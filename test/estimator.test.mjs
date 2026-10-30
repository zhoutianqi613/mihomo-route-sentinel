import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ewma,
  latencyUpperBound,
  quantile,
  summarizeUncertainty,
  wilsonLowerBound,
} from '../src/estimator.mjs';
import { summarizeSamples } from '../src/watchdog.mjs';

const close = (actual, expected, tolerance = 1e-9) => {
  assert.ok(Number.isFinite(actual), `期望有限数，实际 ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `期望 ${expected}±${tolerance}，实际 ${actual}`);
};

test('wilsonLowerBound：4/4 只给出约 0.51 的保守下界', () => {
  const lower = wilsonLowerBound(4, 4);
  assert.ok(lower > 0.5 && lower < 0.52, `4/4 下界异常：${lower}`);
  close(lower, 0.5101, 5e-4);
  // 小样本全绿不能被当成真实成功率 100%。
  assert.ok(lower < 1);
});

test('wilsonLowerBound：全失败为 0、20/20 超过 0.8、无样本为 0', () => {
  assert.equal(wilsonLowerBound(0, 4), 0);
  assert.ok(wilsonLowerBound(20, 20) > 0.8);
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.equal(wilsonLowerBound(3, -1), 0);
  // 成功数超过样本数时按样本数截断，不产生 >1 的下界。
  assert.equal(wilsonLowerBound(9, 4), wilsonLowerBound(4, 4));
  assert.ok(wilsonLowerBound(1, 1) > 0 && wilsonLowerBound(1, 1) < wilsonLowerBound(4, 4));
});

test('quantile：线性插值（Type 7）', () => {
  close(quantile([1, 2, 3, 4, 5], 0.95), 4.8);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
});

test('quantile：空数组返回 null，单值直接返回，p 夹到 [0,1]', () => {
  assert.equal(quantile([], 0.95), null);
  assert.equal(quantile(null, 0.95), null);
  assert.equal(quantile([7], 0.95), 7);
  assert.equal(quantile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(quantile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(quantile([1, 2, 3, 4, 5], -1), 1);
  assert.equal(quantile([1, 2, 3, 4, 5], 2), 5);
});

test('ewma：首样本即为初值，之后按 alpha 加权', () => {
  assert.equal(ewma(null, 100, 0.5), 100);
  assert.equal(ewma(undefined, 100, 0.5), 100);
  close(ewma(100, 200, 0.25), 125);
  assert.equal(ewma(100, 200, 0), 100);
  assert.equal(ewma(100, 200, 1), 200);
  // 非有限输入不污染估计。
  assert.equal(ewma(Number.NaN, 200, 0.5), 200);
  assert.equal(ewma(100, Number.NaN, 0.5), 100);
});

test('latencyUpperBound：mean + z*stddev/sqrt(n)，未知波动返回 Infinity', () => {
  close(latencyUpperBound(100, 20, 4), 119.6, 1e-9);
  assert.equal(latencyUpperBound(100, 0, 1), 100);
  assert.equal(latencyUpperBound(100, 20, 0), Infinity);
  assert.equal(latencyUpperBound(Number.POSITIVE_INFINITY, 0, 4), Infinity);
  assert.equal(latencyUpperBound(100, Number.POSITIVE_INFINITY, 4), Infinity);
  assert.ok(latencyUpperBound(100, 20, 4) > latencyUpperBound(100, 0, 4));
});

test('summarizeUncertainty：失败样本不进延迟分位但计入成功率', () => {
  const summary = summarizeUncertainty([
    { ok: true, delay: 200 },
    { ok: true, delay: 100 },
    { ok: false },
  ]);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.successes, 2);
  close(summary.successRate, 2 / 3);
  assert.equal(summary.successLowerBound, wilsonLowerBound(2, 3));
  // 失败样本若被当成 0ms 参与分位，p50 会变成 100。
  assert.equal(summary.p50Ms, 150);
  close(summary.p95Ms, 195);
  assert.equal(summary.meanMs, 150);
  assert.equal(summary.stdMs, 50);
  close(summary.latencyUpperMs, 150 + (1.96 * (50 / Math.sqrt(2))), 1e-9);
});

test('summarizeUncertainty：空样本与全失败给出不可用语义', () => {
  const empty = summarizeUncertainty([]);
  assert.deepEqual(
    {
      attempts: empty.attempts,
      successes: empty.successes,
      successRate: empty.successRate,
      successLowerBound: empty.successLowerBound,
      p50Ms: empty.p50Ms,
      p95Ms: empty.p95Ms,
      meanMs: empty.meanMs,
      latencyUpperMs: empty.latencyUpperMs,
    },
    {
      attempts: 0,
      successes: 0,
      successRate: 0,
      successLowerBound: 0,
      p50Ms: null,
      p95Ms: null,
      meanMs: Infinity,
      latencyUpperMs: Infinity,
    },
  );
  const failed = summarizeUncertainty([{ ok: false }, { ok: false, delay: 120 }]);
  assert.equal(failed.attempts, 2);
  assert.equal(failed.successes, 0);
  assert.equal(failed.successRate, 0);
  assert.equal(failed.p50Ms, null);
  assert.equal(failed.meanMs, Infinity);
  assert.equal(failed.stdMs, Infinity);
  assert.equal(failed.latencyUpperMs, Infinity);
});

test('watchdog 汇总暴露不确定性字段，且小样本排序更保守', () => {
  const fourOfFour = summarizeSamples('four', [
    { ok: true, delay: 500 },
    { ok: true, delay: 500 },
    { ok: true, delay: 500 },
    { ok: true, delay: 500 },
  ]);
  const oneOfOne = summarizeSamples('one', [
    { ok: true, delay: 500 },
  ]);
  // 保留既有字段以免破坏快照与测试。
  for (const key of ['attempts', 'successes', 'successRate', 'averageMs', 'maxMs', 'jitterMs', 'score', 'samples']) {
    assert.ok(key in fourOfFour, `缺少既有字段 ${key}`);
  }
  for (const key of ['successLowerBound', 'p50Ms', 'p95Ms', 'stdMs', 'latencyUpperMs']) {
    assert.ok(key in fourOfFour, `缺少新增字段 ${key}`);
  }
  assert.equal(oneOfOne.successRate, fourOfFour.successRate);
  // 同样的点估计下，样本更少的候选排序更差（winner's curse 防护）。
  assert.ok(fourOfFour.score < oneOfOne.score,
    `4/4 分数 ${fourOfFour.score} 应低于 1/1 分数 ${oneOfOne.score}`);
  assert.equal(fourOfFour.p50Ms, 500);
  assert.equal(fourOfFour.p95Ms, 500);
});
