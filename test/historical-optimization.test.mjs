import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { Watchdog, summarizeSamples } from '../src/watchdog.mjs';
import { createHistoryObservation, mergeOptimizationHistory } from '../src/optimization-history.mjs';

async function fixture(t, { seed = true, currentMs = 500, candidateMs = 550, dynamic = false,
  beforeSwitch = async () => {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-history-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sentinel-history-'));
    return rm(root, { recursive: true, force: true });
  });
  let now = Date.now();
  const config = structuredClone(defaults);
  config.groups = { target: 'target', candidates: 'candidates' };
  config.probes.urls = ['https://a.example/', 'https://b.example/'];
  config.probes.controlUrls = [];
  config.policy.hardFailureConfirmSeconds = 0;
  config.policy.minimumDwellSeconds = 0;
  config.policy.postSwitchDelaySeconds = 0;
  config.files = { state: path.join(root, 'state.json'), log: path.join(root, 'unused.ndjson'),
    lock: path.join(root, 'unused.lock') };
  const state = { currentSelection: 'current', currentLeaf: 'current', selectionAdmissionVersion: 1,
    selectionAdmission: { profile: 'strict', selection: 'current', leaf: 'current', verified: true },
    candidateSnapshot: { at: new Date(now).toISOString(), selection: 'current', leaf: 'current',
      candidates: [{ node: 'candidate', attempts: 4, successes: 4, successRate: 1,
        averageMs: 300, maxMs: 300, jitterMs: 0, score: 300, profile: 'strict' }], sampled: [] } };
  if (seed) {
    const observations = [0, 1, 2].flatMap(i => ['current', 'candidate'].map(node => {
      const result = summarizeSamples(node, [1, 2].flatMap(round => config.probes.urls.map(url => ({
        round, url, ok: true, delay: node === 'current' ? 800 : 300,
      }))));
      return createHistoryObservation(result, { at: now - (3 - i) * 60000,
        timeoutMs: config.probes.timeoutMs, fullTimeout: true }, config);
    }));
    mergeOptimizationHistory(state, observations, config, now);
  }
  await writeFile(config.files.state, JSON.stringify(state));
  let selected = 'current';
  const switches = [];
  const events = [];
  let candidateCalls = 0;
  const controller = {
    async getProxy(node) {
      if (node === 'target') return { type: 'Selector', now: selected, all: ['current', 'candidate'] };
      if (node === 'candidates') return { type: 'URLTest', all: ['current', 'candidate'] };
      if (node === 'candidate' && dynamic) return { type: 'Selector', now: 'leaf', all: ['leaf'] };
      return { type: 'Shadowsocks' };
    },
    async getDelay(node) {
      if (node !== 'current') candidateCalls += 1;
      const value = node === 'current' ? currentMs : candidateMs;
      if (value === null) throw Object.assign(new Error('模拟网络失败'), { status: 504 });
      return value;
    },
    async select(group, node) { switches.push(node); selected = node; },
  };
  const create = () => new Watchdog({ controller, config, beforeSwitch,
    clock: { now: () => now, nowIso: () => new Date(now).toISOString(), sleep: async ms => { now += ms; } },
    logger: async (level, event, details) => events.push({ event, ...details }) });
  return { create, config, switches, events, candidateCalls: () => candidateCalls,
    advance: ms => { now += ms; }, readState: async () => JSON.parse(await readFile(config.files.state, 'utf8')) };
}

test('长期占优的候选暂时550、当前暂时500，实时严格合格后仍可择优', async t => {
  const f = await fixture(t);
  const outcome = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });
  assert.equal(outcome.status, 'switched');
  assert.equal(outcome.current.averageMs, 500);
  assert.equal(outcome.verification.averageMs, 550);
  assert.deepEqual(f.switches, ['candidate']);
  const comparison = f.events.findLast(row => row.event === 'historical-optimization-evaluated');
  assert.equal(comparison.stage, 'pre-switch');
  assert.equal(comparison.candidates[0].eligible, true);
  assert.equal((await f.readState()).decisionState.budget.optimization.used, 1);
});

test('缺少历史时不复测或选择，复用快照不能累积优势次数', async t => {
  const f = await fixture(t, { seed: false });
  const watchdog = f.create();
  for (let i = 0; i < 3; i += 1) {
    const outcome = await watchdog.runOnce({ dryRun: false, forceScan: true, backgroundScan: true });
    assert.equal(outcome.status, 'optimization-history-pending');
    f.advance(10000);
  }
  assert.deepEqual(f.switches, []);
  assert.equal(f.candidateCalls(), 0);
  assert.equal((await f.readState()).decisionState.budget.optimization.used, 0);
});

test('历史占优不能绕过实时严格质量门', async t => {
  const f = await fixture(t, { candidateMs: 900 });
  const outcome = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });
  assert.equal(outcome.status, 'no-pre-switch-candidate');
  assert.deepEqual(f.switches, []);
  assert.equal((await f.readState()).decisionState.budget.optimization.used, 0);
});

test('恢复不等待历史，冷启动硬故障仍可按原额度临时接管', async t => {
  const f = await fixture(t, { seed: false, currentMs: null, candidateMs: 700 });
  const outcome = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(outcome.status, 'emergency-fallback');
  assert.deepEqual(f.switches, ['candidate']);
  assert.equal(f.events.some(row => row.event === 'historical-optimization-evaluated'), false);
  assert.equal((await f.readState()).decisionState.budget.recovery.used, 1);
});

test('Dry Run不写逐节点历史或修改选择', async t => {
  const f = await fixture(t);
  const before = await readFile(f.config.files.state);
  const outcome = await f.create().runOnce({ dryRun: true, forceScan: true, backgroundScan: true });
  assert.equal(outcome.status, 'would-switch');
  assert.deepEqual(await readFile(f.config.files.state), before);
  assert.deepEqual(f.switches, []);
});

test('动态候选的历史无法绑定实际叶子时不按别名择优', async t => {
  const f = await fixture(t, { dynamic: true });
  const outcome = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });
  assert.equal(outcome.status, 'optimization-history-pending');
  assert.deepEqual(f.switches, []);
});

test('历史不足时保留正在刷新的后台扫描，避免永久无法积累新样本', async t => {
  const f = await fixture(t, { seed: false, currentMs: 900 });
  f.config.policy.latencyFailureCycles = 1;
  const watchdog = f.create();
  let cancelled = 0;
  const scan = { selection: 'current', leaf: 'current', completed: false,
    cancel: () => { cancelled += 1; }, promise: new Promise(() => {}) };
  watchdog.activeCandidateScan = scan;
  const outcome = await watchdog.runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(outcome.status, 'optimization-history-pending');
  assert.equal(cancelled, 0);
  assert.equal(outcome.backgroundWake, scan.promise);
});

test('周期择优等待历史时不重置900秒间隔而推迟下次评估', async t => {
  const f = await fixture(t, { seed: false, currentMs: 700 });
  const outcome = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(outcome.status, 'optimization-history-pending');
  assert.equal((await f.readState()).lastOptimizationScanAt, undefined);
});

test('历史优势不能绕过普通择优最短驻留', async t => {
  const f = await fixture(t, { currentMs: 700 });
  f.config.policy.minimumDwellSeconds = 120;
  const state = await f.readState();
  state.lastSwitchAt = new Date().toISOString();
  await writeFile(f.config.files.state, JSON.stringify(state));
  const outcome = await f.create().runOnce({ dryRun: false, backgroundScan: true });
  assert.equal(outcome.status, 'minimum-dwell');
  assert.deepEqual(f.switches, []);
});

test('历史优势不能借用恢复额度突破优化预算', async t => {
  const f = await fixture(t);
  const state = await f.readState();
  state.switchHistory = Array.from({ length: 3 }, () => ({
    timestamp: new Date().toISOString(), budgetClass: 'optimization', kind: 'candidate-attempt',
  }));
  await writeFile(f.config.files.state, JSON.stringify(state));
  const outcome = await f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true });
  assert.equal(outcome.status, 'switch-budget-exhausted');
  assert.deepEqual(f.switches, []);
  assert.equal((await f.readState()).decisionState.budget.recovery.used, 0);
});

test('历史优势不能绕过配置守卫或先消耗预算', async t => {
  const f = await fixture(t, { beforeSwitch: async () => { throw new Error('模拟配置守卫阻断'); } });
  await assert.rejects(f.create().runOnce({ dryRun: false, forceScan: true, backgroundScan: true }), /模拟配置守卫阻断/);
  assert.deepEqual(f.switches, []);
  assert.equal((await f.readState()).decisionState.budget.optimization.used, 0);
});
