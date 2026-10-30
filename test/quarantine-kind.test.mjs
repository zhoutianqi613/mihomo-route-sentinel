import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { Watchdog } from '../src/watchdog.mjs';

const url = 'https://business-a.example/';

// 候选快照让后台扫描路径可直接进入切前复核，避免依赖真实扫描时序。
function cachedCandidate(averageMs) {
  return {
    node: 'candidate',
    attempts: 4,
    successes: 4,
    successRate: 1,
    averageMs,
    maxMs: averageMs,
    jitterMs: 0,
    score: averageMs * 1.25,
    profile: 'strict',
  };
}

async function fixture(t, { probe, state: overrides = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-quarantine-kind-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = structuredClone(defaults);
  config.groups = { target: 'target', candidates: 'candidates' };
  Object.assign(config.probes, {
    urls: [url], controlUrls: [], currentRounds: 2, validationRounds: 2,
    timeoutMs: 100, discoveryTimeoutMs: 100, scanDeadlineMs: 500,
    preSwitchValidationDeadlineMs: 500, topCandidates: 3, maxValidationCandidates: 3,
    parallelism: 2,
  });
  Object.assign(config.policy, {
    hardFailureConfirmSeconds: 0, postSwitchDelaySeconds: 0, postSwitchRounds: 2,
    partialFailureCycles: 1, latencyFailureCycles: 1, minimumDwellSeconds: 0,
    optimizationIntervalSeconds: 0, emergencySwitchDeadlineMs: 500,
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
    candidateSnapshot: {
      at: new Date().toISOString(), selection: 'current', leaf: 'current',
      sampled: [], candidates: [cachedCandidate(100)],
    },
    ...overrides,
  }));
  let selected = 'current';
  const counts = new Map();
  const events = [];
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: selected, all: ['current', 'candidate'] };
      if (name === 'candidates') return { type: 'URLTest', all: ['current', 'candidate'] };
      return { type: 'Shadowsocks' };
    },
    async getDelay(node) {
      const count = (counts.get(node) ?? 0) + 1;
      counts.set(node, count);
      const value = await probe(node, count);
      if (value === null) throw new Error('模拟不可达');
      return value;
    },
    async select(group, node) { selected = node; },
  };
  const create = () => new Watchdog({
    controller, config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });
  return {
    config,
    create,
    events,
    selected: () => selected,
    readState: async () => JSON.parse(await readFile(config.files.state, 'utf8')),
  };
}

function remainingSeconds(entry) {
  return (Date.parse(entry.until) - Date.now()) / 1000;
}

test('切前质量不达标按 quality 短隔离 180 秒，不再套用 900 秒网络隔离', async (t) => {
  // 当前出口健康（300ms），候选完整采完但平均 700ms 未过 600ms 严格线。
  const f = await fixture(t, { probe: (node) => (node === 'current' ? 300 : 700) });

  const result = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });

  assert.equal(result.status, 'no-pre-switch-candidate');
  const state = await f.readState();
  const entry = state.quarantinedNodes.candidate;
  assert.equal(entry.reason, 'pre-switch-validation-failed');
  assert.equal(entry.kind, 'quality');
  const remaining = remainingSeconds(entry);
  assert.ok(remaining > 170 && remaining <= 180, `质量隔离应约为 180 秒，实际 ${remaining}`);
  const rejected = f.events.find(({ event }) => event === 'candidate-pre-switch-rejected');
  assert.equal(rejected?.details.kind, 'quality');
});

test('切后验证失败仍是 900 秒网络隔离，但标注 kind=verify', async (t) => {
  // 前两次采到候选 300ms（切前复核通过），切后两轮探测失败。
  const f = await fixture(t, {
    probe: (node, count) => {
      if (node === 'current') return 300;
      return count <= 2 ? 300 : null;
    },
  });

  const result = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });

  assert.equal(result.status, 'rollback-recovered');
  const state = await f.readState();
  const entry = state.quarantinedNodes.candidate;
  assert.equal(entry.reason, 'post-switch-verification-failed');
  assert.equal(entry.kind, 'verify');
  const remaining = remainingSeconds(entry);
  assert.ok(remaining > 890 && remaining <= 900, `切后验证失败应约为 900 秒，实际 ${remaining}`);
  const failed = f.events.find(({ event }) => event === 'switch-verification-failed');
  assert.equal(failed?.details.kind, 'verify');
});

test('成功优化切换后旧节点只按 cooldown 冷却 120 秒', async (t) => {
  const f = await fixture(t, { probe: () => 300 });

  const result = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });

  assert.equal(result.status, 'switched');
  assert.equal(f.selected(), 'candidate');
  const state = await f.readState();
  const entry = state.quarantinedNodes.current;
  assert.equal(entry.reason, 'forced-optimization');
  assert.equal(entry.kind, 'cooldown');
  const remaining = remainingSeconds(entry);
  assert.ok(remaining > 110 && remaining <= 120, `旧节点冷却应约为 120 秒，实际 ${remaining}`);
  const verified = f.events.find(({ event }) => event === 'switch-verified');
  assert.equal(verified?.details.kind, 'cooldown');
});

test('其余网络失败路径保持 900 秒隔离且 kind 默认为 network', async (t) => {
  // 硬故障：当前出口不可达，候选完整可达，走应急接管。
  const f = await fixture(t, { probe: (node) => (node === 'current' ? null : 300) });

  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });

  assert.equal(result.status, 'emergency-fallback');
  const state = await f.readState();
  const entry = state.quarantinedNodes.current;
  assert.equal(entry.reason, 'emergency-best-effort');
  assert.equal(entry.kind, 'network');
  const remaining = remainingSeconds(entry);
  assert.ok(remaining > 890 && remaining <= 900, `网络隔离应约为 900 秒，实际 ${remaining}`);
});

test('隔离到期清理行为不变：过期项被删除，未过期项连同 kind 保留', async (t) => {
  const expiredUntil = new Date(Date.now() - 1000).toISOString();
  const activeUntil = new Date(Date.now() + 60_000).toISOString();
  const f = await fixture(t, {
    probe: () => 300,
    state: {
      quarantinedNodes: {
        'expired-node': { until: expiredUntil, reason: 'pre-switch-validation-failed', kind: 'quality' },
        'active-node': { until: activeUntil, reason: 'post-switch-verification-failed', kind: 'verify' },
      },
    },
  });

  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });

  assert.equal(result.status, 'healthy');
  const state = await f.readState();
  assert.equal(state.quarantinedNodes['expired-node'], undefined);
  assert.deepEqual(state.quarantinedNodes['active-node'], {
    until: activeUntil,
    reason: 'post-switch-verification-failed',
    kind: 'verify',
  });
});
