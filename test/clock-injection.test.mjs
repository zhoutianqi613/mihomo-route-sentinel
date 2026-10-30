import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { getActiveQuarantines, quarantineNode } from '../src/health-policy.mjs';
import { createProbeScheduler } from '../src/probe-scheduler.mjs';
import { getBudgetSnapshot } from '../src/switch-budget.mjs';
import { Watchdog } from '../src/watchdog.mjs';

const FAILURE = Object.assign(new Error('probe timeout'), { status: 504 });

function createFakeClock(start = 1_700_000_000_000) {
  let now = start;
  let nextTimerId = 1;
  const timers = new Map();
  const sleepCalls = [];
  const clock = {
    now: () => now,
    nowIso: () => new Date(now).toISOString(),
    sleep: async (milliseconds) => {
      sleepCalls.push(milliseconds);
      now += milliseconds;
    },
    setTimeout: (callback, milliseconds) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, dueAt: now + Math.max(0, milliseconds) });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    advance: (milliseconds) => {
      now += milliseconds;
      clock.fireDueTimers();
    },
    fireDueTimers: () => {
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.dueAt <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    setNow: (value) => { now = value; },
    sleepCalls,
    pendingTimers: () => timers.size,
  };
  return clock;
}

function makeController({ selected = 'current', candidates = ['current'], delay } = {}) {
  const calls = [];
  return {
    calls,
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: selected, all: ['current', 'other'] };
      if (name === 'candidates') return { type: 'URLTest', all: candidates };
      return { type: 'Shadowsocks' };
    },
    async getDelay(node, url, timeoutMs) {
      calls.push({ node, url, timeoutMs });
      return delay(node, url, timeoutMs);
    },
  };
}

async function makeConfig(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-clock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(defaults);
  config.groups.target = 'target';
  config.groups.candidates = 'candidates';
  config.probes.urls = ['https://service.example/'];
  config.probes.controlUrls = [];
  config.probes.currentRounds = 1;
  config.probes.confirmRounds = 1;
  config.probes.confirmTimeoutMs = 100;
  config.probes.timeoutMs = 100;
  config.probes.scanRounds = 1;
  config.probes.scanUrlCount = 1;
  config.probes.validationRounds = 1;
  config.probes.maxValidationCandidates = 2;
  config.probes.topCandidates = 1;
  config.probes.parallelism = 2;
  config.policy.hardFailureConfirmSeconds = 5;
  config.policy.latencyFailureCycles = 1;
  config.policy.partialFailureCycles = 1;
  config.policy.minimumDwellSeconds = 120;
  config.policy.postSwitchDelaySeconds = 0;
  config.files.state = path.join(root, 'state.json');
  config.files.log = path.join(root, 'watchdog.ndjson');
  config.files.lock = path.join(root, 'watchdog.lock');
  return config;
}

async function writeState(config, state) {
  await writeFile(config.files.state, `${JSON.stringify({ stateVersion: 1, ...state }, null, 2)}\n`, 'utf8');
}

test('Watchdog exposes a working real clock when none is injected', async (t) => {
  const config = await makeConfig(t);
  const controller = makeController({ delay: async () => 80 });
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  assert.equal(typeof watchdog.clock.now, 'function');
  assert.equal(typeof watchdog.clock.nowIso, 'function');
  assert.equal(typeof watchdog.clock.sleep, 'function');
  assert.ok(Math.abs(watchdog.clock.now() - Date.now()) < 1000);
  assert.equal(Number.isFinite(Date.parse(watchdog.clock.nowIso())), true);
  const result = await watchdog.probeNode('current', 1, ['https://service.example/']);
  assert.equal(result.successRate, 1);
});

test('hard-failure confirmation uses the injected clock sleep instead of real waiting', async (t) => {
  const config = await makeConfig(t);
  const clock = createFakeClock();
  const controller = makeController({
    selected: 'bad',
    candidates: ['bad'],
    delay: async () => { throw FAILURE; },
  });
  const watchdog = new Watchdog({ controller, config, logger: async () => {}, clock });

  const startedAt = Date.now();
  const result = await watchdog.runOnce({ dryRun: true });
  const realElapsedMs = Date.now() - startedAt;

  assert.deepEqual(clock.sleepCalls, [5000]);
  assert.equal(clock.now(), 1_700_000_000_000 + 5000);
  assert.ok(realElapsedMs < 1000, `fake clock should not wait 5s, took ${realElapsedMs}ms`);
  assert.equal(result.status, 'no-candidate');
});

test('minimum dwell is evaluated against the injected clock', async (t) => {
  const config = await makeConfig(t);
  const clock = createFakeClock();
  await writeState(config, {
    currentSelection: 'current',
    currentLeaf: 'current',
    selectionAdmissionVersion: 1,
    selectionAdmission: {
      profile: 'strict',
      selection: 'current',
      leaf: 'current',
      verified: true,
      at: new Date(clock.now() - 60_000).toISOString(),
    },
    lastSwitchAt: new Date(clock.now() - 30_000).toISOString(),
    lastHealthyAt: new Date(clock.now() - 30_000).toISOString(),
  });
  const controller = makeController({ delay: async () => 1000 });
  const watchdog = new Watchdog({ controller, config, logger: async () => {}, clock });

  const first = await watchdog.runOnce({ dryRun: true });
  assert.equal(first.status, 'minimum-dwell');

  clock.advance(100_000);
  const second = await watchdog.runOnce({ dryRun: true });
  assert.notEqual(second.status, 'minimum-dwell');
});

test('quarantine expiry timestamps follow the injected clock now', () => {
  const clock = createFakeClock(1_700_000_000_000);
  const state = {};
  quarantineNode(state, 'node-a', 60, 'quality', 'quality', clock.now());
  const untilMs = Date.parse(state.quarantinedNodes['node-a'].until);
  assert.equal(untilMs, clock.now() + 60_000);
  assert.equal(state.quarantinedNodes['node-a'].kind, 'quality');

  assert.deepEqual([...getActiveQuarantines(state, clock.now())], ['node-a']);
  clock.advance(59_000);
  assert.deepEqual([...getActiveQuarantines(state, clock.now())], ['node-a']);
  clock.advance(2_000);
  assert.deepEqual([...getActiveQuarantines(state, clock.now())], []);
  assert.equal(state.quarantinedNodes['node-a'], undefined);
});

test('switch budget windows are evaluated from an injected now', () => {
  const clock = createFakeClock(1_700_000_000_000);
  const policy = { switchBudgetCount: 3, switchBudgetWindowSeconds: 600 };
  const state = {
    switchHistory: [0, 1, 2].map((offset) => ({
      timestamp: new Date(clock.now() - (offset + 1) * 1000).toISOString(),
      budgetClass: 'optimization',
    })),
  };
  assert.equal(getBudgetSnapshot(state, policy, clock.now()).optimization.used, 3);
  clock.advance(600_001);
  assert.equal(getBudgetSnapshot(state, policy, clock.now()).optimization.used, 0);
});

test('probe scheduler honors injected clock for deadline checks and waitUntil timers', async () => {
  const config = { probes: { parallelism: 1, timeoutMs: 100 } };
  const futureStart = Date.now() + 1_000_000;
  const deadlineClock = createFakeClock(futureStart);
  let deadlineCalls = 0;
  const deadlineController = {
    async getDelay() {
      deadlineCalls += 1;
      return 10;
    },
  };
  const deadlineScheduler = createProbeScheduler({
    controller: deadlineController, config, clock: deadlineClock,
  });
  const expired = await deadlineScheduler.probeCandidatesInParallel(
    ['node-a'], 1, ['https://service.example/'], deadlineClock.now() - 1,
  );
  assert.equal(deadlineCalls, 0);
  assert.equal(expired[0].samples[0].error, 'SCAN_DEADLINE');
  assert.equal(expired.probeStats.controllerRequests, 0);

  const timerClock = createFakeClock(1_700_000_000_000);
  let resolveDelay;
  let timerCalls = 0;
  const hangingController = {
    getDelay() {
      timerCalls += 1;
      return new Promise((resolve) => { resolveDelay = resolve; });
    },
  };
  const timerScheduler = createProbeScheduler({
    controller: hangingController, config, clock: timerClock,
  });
  const pending = timerScheduler.probeCandidatesInParallel(
    ['node-a'], 1, ['https://service.example/'], timerClock.now() + 50,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timerCalls, 1);
  timerClock.advance(51);
  const results = await pending;
  assert.equal(results[0].samples[0].error, 'SCAN_DEADLINE');
  resolveDelay(10);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timerScheduler._internals.activeCandidateRequests, 0);
});
