import assert from 'node:assert/strict';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { summarizeSamples } from '../src/health-policy.mjs';
import { createSwitchExecutor } from '../src/switch-executor.mjs';

function makeConfig() {
  const config = structuredClone(defaults);
  config.groups.target = 'XFLTD';
  config.probes.urls = ['https://service.example/'];
  config.probes.validationRounds = 2;
  config.probes.parallelism = 2;
  config.probes.timeoutMs = 100;
  config.policy.postSwitchDelaySeconds = 2;
  config.policy.postSwitchRounds = 2;
  config.policy.maxSwitchAttempts = 3;
  return config;
}

function makeClock(start = 1_700_000_000_000) {
  let now = start;
  const sleeps = [];
  return {
    now: () => now,
    nowIso: () => new Date(now).toISOString(),
    sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    sleeps,
    advance: (milliseconds) => { now += milliseconds; },
  };
}

function makeExecutor(overrides = {}) {
  const config = overrides.config ?? makeConfig();
  const clock = overrides.clock ?? makeClock();
  const events = overrides.events ?? [];
  const controller = overrides.controller ?? {
    select: async (group, name) => { events.push(`select:${group}:${name}`); },
  };
  const executor = createSwitchExecutor({
    controller,
    config,
    clock,
    probes: {},
    logger: async (level, event) => { events.push(`log:${event}`); },
    beforeSwitch: overrides.beforeSwitch ?? (async () => { events.push('beforeSwitch'); }),
    onSwitchStart: () => events.push('start'),
    onSwitchEnd: () => events.push('end'),
    guardTimeoutMs: overrides.guardTimeoutMs,
  });
  return { executor, config, clock, events, controller };
}

function strictResult(node = 'candidate') {
  return summarizeSamples(node, [
    { round: 1, url: 'https://service.example/', ok: true, delay: 100 },
    { round: 2, url: 'https://service.example/', ok: true, delay: 100 },
  ]);
}

function failedResult(node = 'candidate') {
  return summarizeSamples(node, [
    { round: 1, url: 'https://service.example/', ok: false, error: 'ETIMEDOUT' },
    { round: 2, url: 'https://service.example/', ok: false, error: 'ETIMEDOUT' },
  ]);
}

function thresholdSet(config, kind) {
  return {
    minSuccessRate: config.probes[`${kind}MinSuccessRate`],
    maxAverageMs: config.probes[`${kind}MaxAverageMs`],
    maxSingleMs: config.probes[`${kind}MaxSingleMs`],
  };
}

function makeTailContext({ config, clock, events, probes, candidate = { node: 'candidate' } }) {
  const state = {
    quarantinedNodes: {},
    switchHistory: [],
    currentSelection: 'current',
    currentLeaf: 'current',
  };
  const decisions = [];
  const admissions = [];
  return {
    state,
    candidate,
    candidates: [candidate],
    current: { successRate: 0.25, averageMs: 900, maxMs: 1200 },
    previousSelection: 'current',
    currentLeaf: 'current',
    health: { status: 'hard-failure', emergency: true },
    selectionAdmissionRejected: false,
    search: { source: 'live', validated: [] },
    forceScan: false,
    scanReason: 'hard-failure',
    budgetClass: 'recovery',
    setDecision: (action, reason, details) => decisions.push({ action, reason, details }),
    persistState: async () => { events.push('persist'); },
    recordEvaluation: () => { events.push('evaluation'); },
    recordAdmission: (profile, selection, leaf) => { admissions.push({ profile, selection, leaf }); },
    resolveLeaf: async (name) => name,
    probeNode: async () => { events.push('probe'); return probes.shift() ?? failedResult(); },
    currentThresholds: () => thresholdSet(config, 'current'),
    candidateThresholds: () => thresholdSet(config, 'candidate'),
    consumeSwitchBudget: () => ({ allowed: true, used: 1, count: 3, windowSeconds: 600, budgetClass: 'recovery' }),
    getSwitchBudget: () => ({ used: 0, count: 3 }),
    recordRecoveryRollback: () => { events.push('recovery-rollback'); },
    selectionAdmissionVersion: 1,
    decisions,
    admissions,
  };
}

test('critical section counts nested attempts and fires outer start/end once', () => {
  const { executor, events } = makeExecutor();
  assert.equal(executor.switchAttemptDepth, 0);
  executor.beginSwitchAttempt();
  assert.equal(executor.switchAttemptDepth, 1);
  executor.beginSwitchAttempt();
  assert.equal(executor.switchAttemptDepth, 2);
  executor.endSwitchAttempt();
  assert.equal(executor.switchAttemptDepth, 1);
  executor.endSwitchAttempt();
  assert.equal(executor.switchAttemptDepth, 0);
  assert.deepEqual(events, ['start', 'end']);
});

test('runSwitchAttempt always unwinds the depth on success and error', async () => {
  const { executor } = makeExecutor();
  const value = await executor.runSwitchAttempt(async () => 42);
  assert.equal(value, 42);
  assert.equal(executor.switchAttemptDepth, 0);
  await assert.rejects(executor.runSwitchAttempt(async () => { throw new Error('boom'); }));
  assert.equal(executor.switchAttemptDepth, 0);
});

test('guardedSelect runs beforeSwitch → beforeSelect → select in order', async () => {
  const { executor, events } = makeExecutor();
  const result = await executor.guardedSelect('XFLTD', 'node-a', {
    beforeSelect: async () => { events.push('beforeSelect'); return { budgetClass: 'recovery' }; },
  });
  assert.deepEqual(result, { blocked: false, budgetClass: 'recovery' });
  assert.deepEqual(events, ['beforeSwitch', 'beforeSelect', 'select:XFLTD:node-a']);
});

test('guardedSelect timeout blocks without beforeSelect or select', async () => {
  const { executor, events } = makeExecutor({
    beforeSwitch: () => { events.push('beforeSwitch'); return new Promise(() => {}); },
    guardTimeoutMs: 40,
  });
  const result = await executor.guardedSelect('XFLTD', 'node-a', {
    beforeSelect: async () => { events.push('beforeSelect'); return {}; },
  });
  assert.deepEqual(result, { blocked: true, reason: 'guardrail-timeout', timeoutMs: 40 });
  assert.deepEqual(events, ['beforeSwitch']);
});

test('guardedSelect returns a blocked beforeSelect result without selecting', async () => {
  const { executor, events } = makeExecutor();
  const result = await executor.runSwitchAttempt(() => executor.guardedSelect('XFLTD', 'node-a', {
    beforeSelect: async () => ({ blocked: true, reason: 'switch-budget-exhausted' }),
  }));
  assert.deepEqual(result, { blocked: true, reason: 'switch-budget-exhausted' });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'end']);
});

test('guardTimeoutFor caps normal path at guardTimeoutMs and floors emergency at 250ms', () => {
  const clock = makeClock(1_700_000_000_000);
  const { executor } = makeExecutor({ clock });
  assert.equal(executor.guardTimeoutFor(), 3000);
  assert.equal(executor.guardTimeoutFor(clock.now() + 10_000), 3000);
  assert.equal(executor.guardTimeoutFor(clock.now() + 800), 800);
  assert.equal(executor.guardTimeoutFor(clock.now() + 100), 250);

  const { executor: small } = makeExecutor({ clock, guardTimeoutMs: 100 });
  assert.equal(small.guardTimeoutFor(clock.now() + 10_000), 100);
  assert.equal(small.guardTimeoutFor(clock.now() + 100), 100);
});

test('executeSwitchTail switches, persists and records strict admission in order', async () => {
  const config = makeConfig();
  const clock = makeClock();
  const events = [];
  const { executor } = makeExecutor({ config, clock, events });
  const candidate = { node: 'candidate', preSwitchVerification: strictResult() };
  const ctx = makeTailContext({
    config, clock, events, probes: [strictResult('candidate')], candidate,
  });

  const result = await executor.executeSwitchTail(ctx);

  assert.equal(result.status, 'switched');
  assert.equal(result.candidate.node, 'candidate');
  assert.deepEqual(events.slice(0, 7), [
    'start', 'beforeSwitch', 'persist', 'select:XFLTD:candidate', 'persist',
    'log:node-switched', 'probe',
  ]);
  assert.deepEqual(clock.sleeps, [2000]);
  assert.equal(events.includes('evaluation'), true);
  assert.deepEqual(ctx.admissions.at(-1), { profile: 'strict', selection: 'candidate', leaf: 'candidate' });
  assert.equal(ctx.state.lastSwitch.verified, true);
  assert.equal(ctx.state.currentSelection, 'candidate');
  assert.equal(ctx.state.currentLeaf, 'candidate');
});

test('executeSwitchTail isolates a failed post-switch verification and falls back', async () => {
  const config = makeConfig();
  const clock = makeClock();
  const events = [];
  const { executor } = makeExecutor({ config, clock, events });
  const candidate = { node: 'candidate', preSwitchVerification: strictResult() };
  const ctx = makeTailContext({
    config, clock, events, probes: [failedResult('candidate'), failedResult('current')], candidate,
  });

  const result = await executor.executeSwitchTail(ctx);

  assert.equal(result.status, 'degraded-fallback');
  assert.equal(ctx.state.quarantinedNodes.candidate?.reason, 'post-switch-verification-failed');
  assert.equal(ctx.state.quarantinedNodes.current?.reason, 'hard-failure');
  assert.equal(events.includes('select:XFLTD:candidate'), true);
  assert.equal(events.includes('recovery-rollback'), false);
});

test('executeSwitchTail returns guardrail-timeout when the guard blocks the attempt', async () => {
  const config = makeConfig();
  const clock = makeClock();
  const events = [];
  const { executor } = makeExecutor({
    config,
    clock,
    events,
    beforeSwitch: () => new Promise(() => {}),
    guardTimeoutMs: 30,
  });
  const candidate = { node: 'candidate', preSwitchVerification: strictResult() };
  const ctx = makeTailContext({ config, clock, events, probes: [], candidate });

  const result = await executor.executeSwitchTail(ctx);

  assert.equal(result.status, 'guardrail-timeout');
  assert.equal(ctx.state.currentSelection, 'current');
  assert.equal(events.includes('select:XFLTD:candidate'), false);
});
