import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { Watchdog } from '../src/watchdog.mjs';

const urls = ['https://business-a.example/', 'https://business-b.example/'];

function history(budgetClass, count = 3) {
  return Array.from({ length: count }, () => ({
    timestamp: new Date().toISOString(), budgetClass, kind: 'candidate-attempt',
  }));
}

async function fixture(t, { probe = (node) => node === 'current' ? null : 300,
  state: overrides = {}, selectError = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-p0-acceptance-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sentinel-p0-acceptance-'));
    return rm(root, { recursive: true, force: true });
  });
  const config = structuredClone(defaults);
  config.groups = { target: 'target', candidates: 'candidates' };
  Object.assign(config.probes, { urls, controlUrls: [], currentRounds: 2, timeoutMs: 100,
    discoveryTimeoutMs: 100, scanDeadlineMs: 500, preSwitchValidationDeadlineMs: 500 });
  Object.assign(config.policy, { hardFailureConfirmSeconds: 0, postSwitchDelaySeconds: 0,
    partialFailureCycles: 1, latencyFailureCycles: 1, minimumDwellSeconds: 0,
    optimizationIntervalSeconds: 0, emergencySwitchDeadlineMs: 500 });
  config.files = { state: path.join(root, 'state.json'), log: path.join(root, 'unused.ndjson'),
    lock: path.join(root, 'unused.lock') };
  const state = {
    currentSelection: 'current', currentLeaf: 'current', selectionAdmissionVersion: 1,
    selectionAdmission: { selection: 'current', leaf: 'current', profile: 'strict', verified: true },
    candidateSnapshot: { at: new Date().toISOString(), selection: 'current', leaf: 'current',
      sampled: [], candidates: [{ node: 'candidate', attempts: 4, successes: 4, successRate: 1,
        averageMs: 300, maxMs: 300, jitterMs: 0, score: 375, profile: 'strict' }] },
    ...overrides,
  };
  await writeFile(config.files.state, JSON.stringify(state));
  let selected = 'current';
  const switches = [];
  const counts = new Map();
  const events = [];
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: selected, all: ['current', 'candidate'] };
      if (name === 'candidates') return { type: 'URLTest', all: ['current', 'candidate'] };
      return { type: 'Shadowsocks' };
    },
    async getDelay(node, url, timeoutMs) {
      const count = (counts.get(node) ?? 0) + 1;
      counts.set(node, count);
      const value = await probe(node, url, count, switches, timeoutMs);
      if (value === null) throw new Error('模拟不可达');
      return value;
    },
    async select(group, node) {
      switches.push(node);
      if (selectError) await selectError({ node, state: JSON.parse(await readFile(config.files.state, 'utf8')) });
      selected = node;
    },
  };
  const create = () => new Watchdog({ controller, config,
    logger: async (level, event, details) => events.push({ event, details }) });
  return { config, controller, create, switches, events,
    readState: async () => JSON.parse(await readFile(config.files.state, 'utf8')) };
}

test('P0：择优预算耗尽后仍可使用独立恢复预算', async (t) => {
  const f = await fixture(t, { state: { switchHistory: history('optimization') } });
  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(result.status, 'emergency-fallback');
  assert.deepEqual(f.switches, ['candidate']);
  const state = await f.readState();
  assert.equal(state.decisionState.budget.optimization.used, 3);
  assert.equal(state.decisionState.budget.recovery.used, 1);
  assert.equal(state.decisionState.budget.rescue.used, 0);
});

test('扩展恢复使用与当前节点相同的单目标超时，不将慢速可达出口判成零响应', async (t) => {
  const f = await fixture(t, { probe: (node, url, count, switches, timeoutMs) => {
    if (node === 'current' || timeoutMs < 95) return null;
    return 80;
  } });
  f.config.probes.preSwitchValidationDeadlineMs = 80;
  f.config.policy.emergencySwitchDeadlineMs = 20;

  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });

  assert.equal(result.status, 'emergency-fallback');
  assert.equal(result.verificationSource, 'live-recovery-validation');
  assert.deepEqual(f.switches, ['candidate']);
  assert.equal((await f.readState()).lastSwitch.verified, false);
});

test('测速成功但实际链路失败时允许完整可达的备选恢复，不套用延迟择优门槛', async (t) => {
  const f = await fixture(t, { probe: (node) => node === 'current' ? 300 : 700,
    state: { degradationWindow: Array.from({ length: 3 }, () => ({
      at: new Date().toISOString(), degraded: true, status: 'latency-degraded',
    })) } });

  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true,
    linkTelemetry: { enabled: true, https: { networkOk: false }, websocket: { networkOk: false } } });

  assert.equal(result.status, 'emergency-fallback');
  assert.deepEqual(f.switches, ['candidate']);
  const state = await f.readState();
  assert.equal(state.lastSwitch.verified, false);
  assert.equal(state.decisionState.budget.recovery.used, 1);
  assert.equal(state.provisionalFallback.requiresStrictAdmission, true);
});

test('鉴权拒绝但网络可达时不作为链路故障放宽恢复条件', async (t) => {
  const f = await fixture(t, { probe: (node) => node === 'current' ? 300 : 700 });
  await f.create().runOnce({ dryRun: false, backgroundScan: true,
    linkTelemetry: { enabled: true,
      https: { networkOk: true, statusCode: 403 }, websocket: { networkOk: true, statusCode: 401 } } });
  assert.deepEqual(f.switches, []);
});

test('实际链路失败时也不能接管仅部分目标可达且不优于当前的候选', async (t) => {
  const f = await fixture(t, { probe: (node, url) => node === 'current' ? 300
    : (url === urls[1] ? null : 100) });
  await f.create().runOnce({ dryRun: false, backgroundScan: true,
    linkTelemetry: { enabled: true, https: { networkOk: false }, websocket: { networkOk: false } } });
  assert.deepEqual(f.switches, []);
});

function unresponsiveSnapshot() {
  return { at: new Date().toISOString(), selection: 'current', leaf: 'current', candidates: [],
    sampled: [{ node: 'candidate', attempts: 2, successes: 0, successRate: 0,
      averageMs: null, maxMs: null, jitterMs: null, score: null }] };
}

test('硬故障遇到零响应快照时重新实时复核，不能永久拒绝恢复', async (t) => {
  const f = await fixture(t, { state: { candidateSnapshot: unresponsiveSnapshot(),
    candidateScanBackoffUntil: new Date(Date.now() + 60_000).toISOString(),
    lastCandidateScanOutcome: 'no-stable-candidate' } });

  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });

  assert.equal(result.status, 'emergency-fallback');
  assert.deepEqual(f.switches, ['candidate']);
  const state = await f.readState();
  assert.equal(state.decisionState.budget.recovery.used, 1);
  assert.notEqual(state.decisionState.admission.profile, 'strict');
  assert.equal(f.events.some(({ event }) => event === 'emergency-discovery-retry'), true);
});

test('零响应快照复核仍全部失败时不切换、不消耗预算', async (t) => {
  const f = await fixture(t, { probe: () => null,
    state: { candidateSnapshot: unresponsiveSnapshot(), candidateScan: { status: 'running' } } });
  const watchdog = f.create();
  let cancelled = false;
  watchdog.activeCandidateScan = { selection: 'current', leaf: 'current', completed: false,
    promise: new Promise(() => {}), cancel: () => { cancelled = true; } };

  await watchdog.runOnce({ dryRun: false, backgroundScan: true });

  assert.deepEqual(f.switches, []);
  assert.equal((await f.readState()).decisionState.budget.recovery.used, 0);
  assert.equal(f.events.some(({ event }) => event === 'emergency-fallback-unavailable'), true);
  assert.equal(cancelled, false, '零响应快照不能反复取消仍在刷新的后台发现');
  assert.equal((await f.readState()).candidateScan.status, 'running');
});

test('P0：硬故障最后一次 rescue 在选择抛错前落盘，重建实例不能重复使用', async (t) => {
  let reserved;
  const f = await fixture(t, { state: { switchHistory: history('recovery') },
    selectError: ({ state }) => { reserved = state; throw new Error('模拟选择失败'); } });
  await assert.rejects(f.create().runOnce({ dryRun: false, backgroundScan: true }), /模拟选择失败/);
  assert.equal(reserved.decisionState.budget.rescue.used, 1);
  assert.equal(reserved.switchHistory.at(-1).budgetClass, 'rescue');
  const next = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(next.status, 'switch-budget-exhausted');
  assert.deepEqual(f.switches, ['candidate']);
  assert.equal((await f.readState()).decisionState.budget.rescue.used, 1);
});

test('P0：部分失败不能借用硬故障 rescue', async (t) => {
  const f = await fixture(t, { probe: (node, url, count) => node === 'candidate' ? 300
    : (count % 4 === 0 ? null : 700), state: { switchHistory: history('recovery') } });
  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(result.status, 'switch-budget-exhausted');
  const state = await f.readState();
  assert.equal(state.decisionState.health.status, 'partial-failure');
  assert.equal(state.decisionState.budget.rescue.used, 0);
  assert.deepEqual(f.switches, []);
});

test('P0：纯延迟退化不能借用恢复预算或 rescue', async (t) => {
  const f = await fixture(t, { probe: (node) => node === 'current' ? 1000 : 300,
    state: { switchHistory: [...history('optimization'), ...history('recovery')] } });
  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(result.status, 'switch-budget-exhausted');
  const state = await f.readState();
  assert.equal(state.lastDecision.budgetClass, 'optimization');
  assert.equal(state.decisionState.budget.rescue.used, 0);
  assert.deepEqual(f.switches, []);
});

test('P0：硬故障确认转为纯延迟退化后重新选择预算类别', async (t) => {
  const f = await fixture(t, { probe: (node, url, count) => node === 'candidate' ? 300
    : (count <= 4 ? null : 1000),
  state: { switchHistory: [...history('optimization'), ...history('recovery')] } });
  f.config.policy.hardFailureConfirmSeconds = 0.001;
  const result = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(result.status, 'switch-budget-exhausted');
  const state = await f.readState();
  assert.equal(state.decisionState.health.status, 'latency-degraded');
  assert.equal(state.lastDecision.budgetClass, 'optimization');
  assert.equal(state.decisionState.budget.rescue.used, 0);
  assert.deepEqual(f.switches, []);
});

test('P0：旧状态的 700ms 节点保留 usable，不伪造故障或强制切换', async (t) => {
  const f = await fixture(t, { probe: () => 700, state: { selectionAdmission: undefined } });
  const result = await f.create().runOnce({ dryRun: false });
  assert.equal(result.status, 'usable-pending-admission');
  const state = await f.readState();
  assert.equal(state.decisionState.health.status, 'healthy');
  assert.equal(state.decisionState.admission.profile, 'usable');
  assert.equal(state.decisionState.admission.verified, false);
  assert.equal(state.lastDecision.action, 'hold');
  assert.deepEqual(f.switches, []);
});

test('P0：700ms 回滚仅恢复 usable，不宣称严格准入', async (t) => {
  const f = await fixture(t, { probe: (node, url, count, switches) => node === 'current'
    ? (switches.length === 0 ? null : 700) : (switches.length === 0 ? 300 : null) });
  const result = await f.create().runOnce({ dryRun: false });
  assert.equal(result.status, 'rollback-recovered');
  assert.deepEqual(f.switches, ['candidate', 'current']);
  const state = await f.readState();
  assert.equal(state.lastSwitch.verified, false);
  assert.equal(state.selectionAdmissionVersion, undefined);
  assert.equal(state.decisionState.admission.profile, 'usable');
  assert.equal(state.provisionalFallback.requiresStrictAdmission, true);
});

test('P0：非后台故障恢复也不得选择实时成功率相同而更慢的节点', async (t) => {
  const f = await fixture(t, { probe: (node, url) => url === urls[1] ? null
    : (node === 'current' ? 300 : 700) });
  await f.create().runOnce({ dryRun: false });
  assert.deepEqual(f.switches, []);
  assert.equal((await f.readState()).decisionState.budget.recovery.used, 0);
});

test('P0：回滚只有一轮严格线样本时仍待两轮严格准入', async (t) => {
  const f = await fixture(t, { probe: (node, url, count, switches) => node === 'current'
    ? (switches.length === 0 ? null : 300) : (switches.length === 0 ? 300 : null) });
  f.config.policy.postSwitchRounds = 1;
  const result = await f.create().runOnce({ dryRun: false });
  assert.equal(result.status, 'rollback-recovered');
  const state = await f.readState();
  assert.equal(state.lastSwitch.verified, false);
  assert.notEqual(state.decisionState.admission.profile, 'strict');
});

test('P0：本轮同叶子两轮完整扫描可以支持切后一轮复核', async (t) => {
  let candidateCalls = 0;
  let callsBeforeSelect = 0;
  const f = await fixture(t, { probe: (node) => {
    if (node === 'current') return null;
    candidateCalls += 1;
    return 300;
  }, selectError: () => { callsBeforeSelect = candidateCalls; } });
  f.config.probes.validationRounds = 1;
  f.config.policy.postSwitchRounds = 1;
  const result = await f.create().runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.equal(callsBeforeSelect, 6, '两个初筛样本外必须仍采集两轮四个严格样本');
  assert.equal(candidateCalls, 8);
  assert.equal((await f.readState()).decisionState.admission.profile, 'strict');
});

test('P0：切后实际叶子变化时不能复用 Selector 名称的两轮扫描证据', async (t) => {
  const f = await fixture(t);
  const getProxy = f.controller.getProxy.bind(f.controller);
  f.controller.getProxy = async (name) => name === 'candidate'
    ? { type: 'Selector', now: 'different-leaf', all: ['different-leaf'] } : getProxy(name);
  f.config.policy.postSwitchRounds = 1;
  const result = await f.create().runOnce({ dryRun: false });
  assert.equal(result.status, 'provisional-fallback');
  const state = await f.readState();
  assert.equal(state.currentLeaf, 'different-leaf');
  assert.equal(state.lastSwitch.verified, false);
  assert.equal(state.decisionState.admission.profile, 'usable');
});
