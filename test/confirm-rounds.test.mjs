import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { Watchdog, summarizeSamples } from '../src/watchdog.mjs';

const urls = ['https://business-a.example/', 'https://business-b.example/'];

async function fixture(t, {
  currentDelay = () => null,
  probes: probeOverrides = {},
  policy: policyOverrides = {},
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-confirm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(defaults);
  config.groups = { target: 'target', candidates: 'candidates' };
  Object.assign(config.probes, {
    urls,
    controlUrls: [],
    currentRounds: 1,
    timeoutMs: 5000,
    confirmRounds: 3,
    confirmTimeoutMs: 60,
    discoveryTimeoutMs: 100,
    scanDeadlineMs: 500,
    preSwitchValidationDeadlineMs: 500,
    parallelism: 2,
    topCandidates: 2,
    maxValidationCandidates: 2,
    ...probeOverrides,
  });
  Object.assign(config.policy, {
    hardFailureConfirmSeconds: 0.001,
    postSwitchDelaySeconds: 0,
    minimumDwellSeconds: 0,
    optimizationIntervalSeconds: 0,
    emergencySwitchDeadlineMs: 500,
    maxSwitchAttempts: 1,
    ...policyOverrides,
  });
  config.files = {
    state: path.join(root, 'state.json'),
    log: path.join(root, 'unused.ndjson'),
    lock: path.join(root, 'unused.lock'),
  };
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'current',
    currentLeaf: 'current',
    selectionAdmissionVersion: 1,
    selectionAdmission: { selection: 'current', leaf: 'current', profile: 'strict', verified: true },
    lastSwitchAt: new Date().toISOString(),
  }));
  let selected = 'current';
  const switches = [];
  const events = [];
  const calls = [];
  const counts = new Map();
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: selected, all: ['current', 'candidate'] };
      if (name === 'candidates') return { type: 'URLTest', all: ['current', 'candidate'] };
      return { type: 'Shadowsocks', name };
    },
    async getDelay(node, url, timeoutMs) {
      const key = `${node}\u0000${url}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      calls.push({ node, url, count, timeoutMs });
      const value = currentDelay({ node, url, count, timeoutMs });
      if (value === null) throw new Error('模拟不可达');
      return value;
    },
    async select(group, node) {
      switches.push(node);
      selected = node;
    },
  };
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });
  const confirmation = () => events.find((entry) => entry.event === 'immediate-failure-confirmed');
  return { watchdog, config, calls, switches, events, confirmation };
}

test('3 轮中 2 轮仍然即时失败时确认硬故障并继续恢复', async (t) => {
  const f = await fixture(t, {
    // 初次探测（count=1）失败；确认阶段第 1、2 轮（count=2、3）失败，第 3 轮（count=4）恢复。
    currentDelay: ({ node, count }) => (node !== 'current' ? 300 : (count <= 3 ? null : 100)),
  });

  const result = await f.watchdog.runOnce({ dryRun: false });
  const logged = f.confirmation();
  assert.ok(logged, '必须记录 immediate-failure-confirmed');
  assert.equal(logged.details.trigger, 'hard-failure');
  assert.equal(logged.details.confirmed, true);
  assert.equal(logged.details.rounds, 3);
  assert.equal(logged.details.immediateRounds, 2);
  assert.equal(logged.details.sampledRounds, 3);
  assert.deepEqual(f.switches, ['candidate']);
  assert.notEqual(result.status, 'transient');
});

test('3 轮中只有 1 轮失败时不确认，按既有 transient 逻辑保持', async (t) => {
  const f = await fixture(t, {
    // 只有初次探测与确认第 1 轮失败（count<=2）；其余两轮正常。
    currentDelay: ({ node, count }) => (node !== 'current' ? 300 : (count <= 2 ? null : 100)),
  });

  const result = await f.watchdog.runOnce({ dryRun: false });
  const logged = f.confirmation();
  assert.equal(logged.details.confirmed, false);
  assert.equal(logged.details.immediateRounds, 1);
  assert.equal(logged.details.sampledRounds, 3);
  assert.deepEqual(f.switches, []);
  assert.equal(result.status, 'transient');
});

test('配置 3 轮但确认只采到 2 轮样本时按样本门控拒绝确认', async (t) => {
  const f = await fixture(t, { currentDelay: ({ node }) => (node !== 'current' ? 300 : null) });
  const originalProbeNode = f.watchdog.probeNode.bind(f.watchdog);
  let probeCalls = 0;
  // 初次探测照常；确认阶段只回传 2 轮（rounds=3 未采齐），且这 2 轮全部失败。
  f.watchdog.probeNode = async (...args) => {
    probeCalls += 1;
    if (probeCalls === 1) return originalProbeNode(...args);
    return summarizeSamples('current', [
      { round: 1, url: urls[0], ok: false, error: 'TIMEOUT' },
      { round: 1, url: urls[1], ok: false, error: 'TIMEOUT' },
      { round: 2, url: urls[0], ok: false, error: 'TIMEOUT' },
      { round: 2, url: urls[1], ok: false, error: 'TIMEOUT' },
    ]);
  };

  const result = await f.watchdog.runOnce({ dryRun: false });
  const logged = f.confirmation();
  assert.equal(logged.details.confirmed, false);
  assert.equal(logged.details.rounds, 3);
  assert.equal(logged.details.immediateRounds, 2);
  assert.equal(logged.details.sampledRounds, 2);
  assert.deepEqual(f.switches, []);
  assert.equal(result.status, 'transient');
});

test('确认阶段使用 min(timeoutMs, confirmTimeoutMs) 作为单目标超时', async (t) => {
  const f = await fixture(t, {
    currentDelay: ({ node }) => (node !== 'current' ? 300 : null),
    probes: { timeoutMs: 5000, confirmTimeoutMs: 60 },
  });

  await f.watchdog.runOnce({ dryRun: false });
  const initialCalls = f.calls.filter((call) => call.node === 'current' && call.count === 1);
  const confirmCalls = f.calls.filter((call) => call.node === 'current' && call.count > 1);
  assert.ok(initialCalls.length > 0);
  assert.ok(confirmCalls.length > 0);
  // 实际下发的单目标超时会被剩余截止时间进一步夹紧（deadline - now），因此只断言上限。
  for (const call of initialCalls) assert.ok(call.timeoutMs > 4000, `初次探测超时应接近 timeoutMs，实际 ${call.timeoutMs}`);
  for (const call of confirmCalls) assert.ok(call.timeoutMs <= 60 && call.timeoutMs > 0,
    `确认探测超时不得超过 confirmTimeoutMs，实际 ${call.timeoutMs}`);
  assert.ok(confirmCalls.some((call) => call.timeoutMs >= 50), '确认探测应实际使用 confirmTimeoutMs 量级');
  // 3 轮 × 2 个目标全部进入确认探测。
  assert.equal(confirmCalls.length, 3 * urls.length);
  assert.equal(f.confirmation().details.timeoutMs, 60);
});
