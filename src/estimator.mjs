// 不确定性估计器：纯函数、无 I/O、无外部依赖。
//
// 背景：健康判定此前只用 2–4 个样本的点估计（成功率、平均延迟、最大延迟）。
// 在这么小的样本上直接挑“最快/成功率最高”的节点会受 winner's curse 影响：
// 被选中的往往是本轮偶然偏快者，下一轮就回落。这里给出保守的量：
// 成功率用 Wilson 下界、延迟用均值 + 标准误上界、尾部用 p95，
// 让排序与准入对小样本保持诚实，而不是靠调大阈值。

/** 默认 95% 双侧正态分位数，与常见健康检查口径一致。 */
const DEFAULT_Z = 1.96;

/** 把任意数值夹到 [0,1]。 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Wilson 得分区间下界（默认 95%）。
 *
 * 相比 successes/total 这样的点估计，4 个样本全成功只会给出约 0.51 的下界，
 * 20/20 才会超过 0.8；因此“4/4 全绿”不会被当成“真实成功率 100%”。
 * total 不为正时返回 0（没有样本就没有证据）。
 */
export function wilsonLowerBound(successes, total, z = DEFAULT_Z) {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const n = Math.floor(total);
  if (n <= 0) return 0;
  const ok = Math.min(Math.max(Number.isFinite(successes) ? successes : 0, 0), n);
  const zValue = Number.isFinite(z) ? Math.max(0, z) : DEFAULT_Z;
  const zSquared = zValue * zValue;
  const proportion = ok / n;
  const denominator = 1 + (zSquared / n);
  const center = proportion + (zSquared / (2 * n));
  const margin = zValue * Math.sqrt(((proportion * (1 - proportion)) + (zSquared / (4 * n))) / n);
  return clamp01((center - margin) / denominator);
}

/**
 * 线性插值分位数（Type 7，与 numpy/Excel 默认实现一致）。
 *
 * 输入须已按升序排列；空数组或没有有限数值时返回 null。
 * p 会被夹到 [0,1]，因此 p=0 取最小值、p=1 取最大值。
 */
export function quantile(sortedValues, p) {
  if (!Array.isArray(sortedValues)) return null;
  const values = sortedValues.filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const position = clamp01(Number.isFinite(p) ? p : 0);
  const index = (values.length - 1) * position;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  if (lowerIndex === upperIndex) return values[lowerIndex];
  const fraction = index - lowerIndex;
  return values[lowerIndex] + ((values[upperIndex] - values[lowerIndex]) * fraction);
}

/**
 * 指数加权移动平均。
 *
 * previous 为 null/undefined 或非有限数时直接返回当前值（首样本即初值）；
 * alpha 夹到 [0,1]，越大越偏向新样本。用于让延迟估计有记忆但不会被单次抖动带偏。
 */
export function ewma(previous, value, alpha) {
  const weight = clamp01(Number.isFinite(alpha) ? alpha : 0);
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return value;
  if (!Number.isFinite(value)) return previous;
  return (weight * value) + ((1 - weight) * previous);
}

/**
 * 延迟上界：mean + z * stddev / sqrt(n)（正态近似，使用总体标准差）。
 *
 * n<=0、均值非有限或标准差非有限时返回 Infinity：
 * 未知波动不能被当成零波动，否则会给出虚假的窄区间。
 * n=1 且 stddev=0 时退化为 mean。
 */
export function latencyUpperBound(mean, stddev, n, z = DEFAULT_Z) {
  if (!Number.isFinite(mean) || !Number.isFinite(n) || n <= 0) return Infinity;
  if (!Number.isFinite(stddev)) return Infinity;
  const zValue = Number.isFinite(z) ? Math.max(0, z) : DEFAULT_Z;
  const spread = Math.max(0, stddev);
  return mean + (zValue * (spread / Math.sqrt(n)));
}

/**
 * 汇总一批探针样本的不确定性视图。
 *
 * 输入：[{ ok: boolean, delay?: number }]，与 watchdog 的采样结构兼容。
 * 输出：{ attempts, successes, successRate, successLowerBound,
 *         p50Ms, p95Ms, meanMs, stdMs, latencyUpperMs }。
 *
 * 约定：
 * - 失败样本计入 attempts 与成功率，但不进入延迟分位、均值与上界；
 * - 没有任何成功延迟时，meanMs/stdMs 为 Infinity、分位为 null、上界为 Infinity，
 *   与现有 watchdog 汇总的“不可用即 Infinity”语义保持一致；
 * - stdMs 为总体标准差（与既有 jitterMs 同口径），不是样本标准差。
 */
export function summarizeUncertainty(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const attempts = list.length;
  const successful = list.filter((sample) => sample?.ok === true);
  const delays = successful
    .map((sample) => sample?.delay)
    .filter((delay) => Number.isFinite(delay))
    .sort((a, b) => a - b);
  const successes = successful.length;
  const successRate = attempts > 0 ? successes / attempts : 0;
  const meanMs = delays.length
    ? delays.reduce((sum, value) => sum + value, 0) / delays.length
    : Infinity;
  const variance = delays.length
    ? delays.reduce((sum, value) => sum + ((value - meanMs) ** 2), 0) / delays.length
    : Infinity;
  const stdMs = Number.isFinite(variance) ? Math.sqrt(variance) : Infinity;
  return {
    attempts,
    successes,
    successRate,
    successLowerBound: wilsonLowerBound(successes, attempts),
    p50Ms: quantile(delays, 0.5),
    p95Ms: quantile(delays, 0.95),
    meanMs,
    stdMs,
    latencyUpperMs: latencyUpperBound(meanMs, stdMs, delays.length),
  };
}
