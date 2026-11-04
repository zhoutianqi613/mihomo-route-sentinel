import assert from 'node:assert/strict';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { summarizeSamples } from '../src/health-policy.mjs';
import { createHistoryObservation, mergeOptimizationHistory, evaluateHistoricalCandidate }
  from '../src/optimization-history.mjs';

const now = 1_800_000_000_000;
const urls = ['https://a.example/', 'https://b.example/'];
function config() {
  const value = structuredClone(defaults);
  value.probes.urls = urls;
  return value;
}
function observation(node, mean, at, cfg, { success = true, tail = mean,
  timeoutMs = cfg.probes.timeoutMs, error = 504 } = {}) {
  const result = summarizeSamples(node, [1, 2].flatMap(round => urls.map(url => ({
    round, url, ok: success, ...(success ? { delay: mean } : { error }),
  }))));
  result.p95Ms = tail;
  return createHistoryObservation(result, { at, timeoutMs, fullTimeout: true }, cfg);
}
function history(pairs, cfg = config()) {
  const state = {};
  const items = pairs.flatMap(([current, candidate, at], i) => [
    observation('current', current, at ?? now - (pairs.length - 1 - i) * 60000, cfg),
    observation('candidate', candidate, (at ?? now - (pairs.length - 1 - i) * 60000) + 1000, cfg),
  ]);
  mergeOptimizationHistory(state, items, cfg, now + 2000);
  return { state, cfg, evaluate: () => evaluateHistoricalCandidate(state, 'current', 'candidate', cfg, now + 2000) };
}

test('历史长期300、复核550而当前800降至500时仍可凭持续优势择优', () => {
  const f = history([[800, 300], [800, 300], [800, 300], [500, 550]]);
  const result = f.evaluate();
  assert.equal(result.eligible, true);
  assert.ok(result.current.meanMs > result.candidate.meanMs);
  assert.equal(result.comparisons, 4);
  assert.equal(result.consecutiveWins, 4);
});

test('只有一次偶然变快不能形成持续优势', () => {
  const f = history([[500, 700], [500, 700], [500, 100]]);
  assert.equal(f.evaluate().eligible, false);
});

test('历史不足三个独立窗口时等待，不借重复快照补次数', () => {
  const f = history([[800, 300]]);
  const item = observation('candidate', 300, now + 1000, f.cfg);
  mergeOptimizationHistory(f.state, [item, item, item], f.cfg, now + 2000);
  assert.equal(f.evaluate().comparisons, 1);
  assert.equal(f.evaluate().eligible, false);
});

test('同一时间窗口的多次复测不能伪装为多个独立比较', () => {
  const f = history([[800, 300, now], [800, 300, now + 200], [800, 300, now + 400]]);
  assert.equal(f.evaluate().comparisons, 1);
  assert.equal(f.evaluate().eligible, false);
});

test('时间相差过大的当前与候选不配对', () => {
  const cfg = config();
  const state = {};
  mergeOptimizationHistory(state, [observation('current', 800, now - 120000, cfg),
    observation('candidate', 300, now, cfg)], cfg, now + 2000);
  assert.equal(evaluateHistoricalCandidate(state, 'current', 'candidate', cfg, now + 2000).comparisons, 0);
});

test('候选历史成功率较低时不因延迟更低被择优', () => {
  const f = history([[800, 300], [800, 300], [800, 300]]);
  mergeOptimizationHistory(f.state, [observation('current', 800, now + 60000, f.cfg),
    observation('candidate', 300, now + 61000, f.cfg, { success: false })], f.cfg, now + 62000);
  assert.equal(evaluateHistoricalCandidate(f.state, 'current', 'candidate', f.cfg, now + 62000).eligible, false);
});

test('尾延迟明显恶化会降低历史综合评分', () => {
  const cfg = config();
  const state = {};
  const items = [0, 1, 2].flatMap(i => {
    const at = now - (2 - i) * 60000;
    return [observation('current', 600, at, cfg),
      observation('candidate', 400, at + 1000, cfg, { tail: 2500 })];
  });
  mergeOptimizationHistory(state, items, cfg, now + 2000);
  assert.equal(evaluateHistoricalCandidate(state, 'current', 'candidate', cfg, now + 2000).eligible, false);
});

test('过期或探测目标改变的历史不能沿用', () => {
  const f = history([[800, 300], [800, 300], [800, 300]]);
  assert.equal(evaluateHistoricalCandidate(f.state, 'current', 'candidate', f.cfg, now + 1_000_000).eligible, false);
  f.cfg.probes.urls = ['https://changed.example/'];
  mergeOptimizationHistory(f.state, [], f.cfg, now + 2000);
  assert.equal(f.evaluate().comparisons, 0);
});

test('取消、截止和不同超时样本不进入历史', () => {
  const cfg = config();
  for (const error of ['SCAN_DEADLINE', 'PROBE_CANCELLED', 'ABORT_ERR']) {
    assert.equal(observation('candidate', 0, now, cfg, { success: false, error }), null);
  }
  assert.equal(observation('candidate', 300, now, cfg, { timeoutMs: 1000 }), null);
});

test('历史损坏、未来时间和超量节点安全清洗且不污染原型', () => {
  const cfg = config();
  const state = { optimizationHistory: { version: 999, nodes: 'invalid' } };
  mergeOptimizationHistory(state, [observation('__proto__', 300, now, cfg),
    observation('future', 300, now + 60000, cfg), ...Array.from({ length: 300 }, (_, i) =>
      observation(`node-${i}`, 300, now, cfg))], cfg, now + 2000);
  assert.ok(state.optimizationHistory.nodes.length <= 256);
  assert.equal(Object.prototype.observations, undefined);
  assert.equal(state.optimizationHistory.nodes.some(r => r.node === 'future'), false);
});

test('长时间缺少配对时重新积累持续优势，过时的胜出次数不能继承', () => {
  const f = history([[800, 300, now - 600000], [800, 300, now - 540000], [800, 300, now]]);
  assert.equal(f.evaluate().eligible, false);
  assert.equal(f.evaluate().consecutiveWins, 1);
});

test('更改超时后排队中的旧探测不能进入新上下文', () => {
  const cfg = config();
  const old = observation('candidate', 300, now, cfg);
  cfg.probes.timeoutMs = 6000;
  const state = {};
  mergeOptimizationHistory(state, [old], cfg, now + 2000);
  assert.equal(state.optimizationHistory.nodes.length, 0);
});

test('单节点历史始终有界且仅保存白名单指标', () => {
  const cfg = config();
  const state = {};
  mergeOptimizationHistory(state, Array.from({ length: 100 }, (_, i) =>
    observation('candidate', 300, now - i * 1000, cfg)), cfg, now + 2000);
  assert.equal(state.optimizationHistory.nodes[0].observations.length, 64);
  assert.equal(JSON.stringify(state.optimizationHistory).includes('https://'), false);
});
