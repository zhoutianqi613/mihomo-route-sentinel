// 健康/策略纯函数：只消费探针汇总与策略阈值，不做 I/O、不依赖 Controller。
// 从 watchdog.mjs 原样迁出（逻辑未改），作为后续拆分 health/策略边界的起点。
import { latencyUpperBound, quantile, wilsonLowerBound } from './estimator.mjs';

export function summarizeSamples(node, samples) {
  const successful = samples.filter((sample) => sample.ok);
  const delays = successful.map((sample) => sample.delay);
  const successRate = samples.length ? successful.length / samples.length : 0;
  const averageMs = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : Infinity;
  const maxMs = delays.length ? Math.max(...delays) : Infinity;
  const variance = delays.length
    ? delays.reduce((sum, value) => sum + ((value - averageMs) ** 2), 0) / delays.length
    : Infinity;
  const jitterMs = Number.isFinite(variance) ? Math.sqrt(variance) : Infinity;
  // 小样本下点估计不可信（winner's curse）：成功率用 Wilson 下界、延迟用标准误上界，
  // 尾部用 p95。失败样本不进延迟统计，但仍计入 attempts 以压低下界。
  const sortedDelays = [...delays].sort((a, b) => a - b);
  const successLowerBound = wilsonLowerBound(successful.length, samples.length);
  const p50Ms = quantile(sortedDelays, 0.5);
  const p95Ms = quantile(sortedDelays, 0.95);
  const stdMs = jitterMs;
  const latencyUpperMs = latencyUpperBound(averageMs, stdMs, delays.length);
  // 排序改为不确定性感知：先压低“成功率下界低”，再比延迟上界，
  // 并对单次最大延迟与波动做轻量惩罚；非有限值用大数兜底，保证不可用候选排在最后。
  const rawScore = ((1 - successLowerBound) * 1_000_000) + latencyUpperMs
    + (maxMs * 0.15) + (stdMs * 0.25);
  const score = Number.isFinite(rawScore) ? rawScore : 1e12;
  return {
    node,
    attempts: samples.length,
    successes: successful.length,
    successRate,
    successLowerBound,
    p50Ms,
    p95Ms,
    averageMs,
    maxMs,
    jitterMs,
    stdMs,
    latencyUpperMs,
    score,
    samples,
  };
}

export function isStable(result, thresholds) {
  return result.successRate >= thresholds.minSuccessRate
    && result.averageMs <= thresholds.maxAverageMs
    && result.maxMs <= thresholds.maxSingleMs;
}

export function isStableAcrossRounds(result, thresholds) {
  const samplesByRound = new Map();
  for (const sample of result.samples ?? []) {
    const round = sample.round ?? 1;
    if (!samplesByRound.has(round)) samplesByRound.set(round, []);
    samplesByRound.get(round).push(sample);
  }
  return samplesByRound.size > 0
    && [...samplesByRound.values()].every((samples) => isStable(
      summarizeSamples(result.node, samples),
      thresholds,
    ));
}

export function hasCompleteProbeRounds(result, urls, minimumRounds) {
  const byRound = new Map();
  for (const sample of result?.samples ?? []) {
    if (['SCAN_DEADLINE', 'PROBE_CANCELLED', 'ABORT_ERR'].includes(sample.error)) return false;
    if (!byRound.has(sample.round)) byRound.set(sample.round, []);
    byRound.get(sample.round).push(sample.url);
  }
  const expected = JSON.stringify([...urls].sort());
  return byRound.size >= minimumRounds
    && Array.from({ length: minimumRounds }, (_, index) => index + 1)
      .every((round) => byRound.has(round))
    && [...byRound.values()].every((roundUrls) => JSON.stringify(roundUrls.sort()) === expected);
}

export function hasStrictAdmissionEvidence(result, probes, thresholds) {
  return hasCompleteProbeRounds(result, probes.urls, Math.max(2, probes.validationRounds))
    && isStableAcrossRounds(result, thresholds);
}

export function compareAvailability(a, b) {
  // 优先比较不确定性保守量；缓存快照等旧结构缺少新字段时回退到原点估计，
  // 保持旧快照的排序行为不变。
  const lowerOf = (entry) => (Number.isFinite(entry.successLowerBound)
    ? entry.successLowerBound : entry.successRate);
  const upperOf = (entry) => (Number.isFinite(entry.latencyUpperMs)
    ? entry.latencyUpperMs : entry.averageMs);
  return lowerOf(b) - lowerOf(a)
    || upperOf(a) - upperOf(b)
    || a.maxMs - b.maxMs
    || a.jitterMs - b.jitterMs
    || a.node.localeCompare(b.node);
}

export function isAvailabilityImprovement(candidate, current, policy) {
  if (candidate.successes <= 0 || candidate.successRate <= 0) return false;
  if (candidate.successRate > current.successRate) return true;
  if (candidate.successRate < current.successRate) return false;
  const required = Math.min(
    policy.minimumImprovementMs,
    current.averageMs * policy.minimumImprovementRatio,
  );
  return Number.isFinite(candidate.averageMs)
    && candidate.averageMs <= current.averageMs - required;
}

export function explainRoundStability(result, thresholds) {
  const samplesByRound = new Map();
  for (const sample of result.samples ?? []) {
    const round = sample.round ?? 1;
    if (!samplesByRound.has(round)) samplesByRound.set(round, []);
    samplesByRound.get(round).push(sample);
  }
  const rounds = [...samplesByRound.entries()].map(([round, samples]) => {
    const summary = summarizeSamples(result.node, samples);
    const reasons = [];
    if (summary.successRate < thresholds.minSuccessRate) reasons.push('success-rate');
    if (summary.averageMs > thresholds.maxAverageMs) reasons.push('average-latency');
    if (summary.maxMs > thresholds.maxSingleMs) reasons.push('single-latency');
    return {
      round,
      stable: reasons.length === 0,
      reasons,
      successRate: summary.successRate,
      averageMs: Number.isFinite(summary.averageMs) ? Math.round(summary.averageMs) : null,
      maxMs: Number.isFinite(summary.maxMs) ? summary.maxMs : null,
    };
  });
  return {
    stable: rounds.length > 0 && rounds.every((round) => round.stable),
    reasons: [...new Set(rounds.flatMap((round) => round.reasons))],
    rounds,
  };
}

export function recordDegradation(state, health, policy) {
  const windowSize = policy.degradationWindowCycles ?? 10;
  const degraded = health.status === 'latency-degraded' || health.status === 'latency-spike';
  state.degradationWindow = [
    ...(Array.isArray(state.degradationWindow) ? state.degradationWindow : []),
    { at: new Date().toISOString(), degraded, status: health.status },
  ].slice(-windowSize);
  const failures = state.degradationWindow.filter((entry) => entry.degraded).length;
  return {
    cycles: state.degradationWindow.length,
    failures,
    required: policy.degradationWindowFailures ?? 3,
    triggered: failures >= (policy.degradationWindowFailures ?? 3),
  };
}

export function classifyHealth(result, thresholds, policy) {
  const emergency = result.successRate <= policy.emergencySuccessRate
    || result.averageMs > policy.emergencyMaxAverageMs;
  const latencySpike = !emergency && result.maxMs > policy.immediateMaxSingleMs;
  const stable = !emergency && !latencySpike && isStable(result, thresholds);
  const quality = emergency
    ? 'hard-failure'
    : (result.successRate < 1 ? 'partial-failure'
      : (result.averageMs <= 500 && result.maxMs <= 1000 ? 'excellent'
        : (result.averageMs <= 800 && result.maxMs <= 1500 ? 'acceptable'
          : (result.averageMs <= 1200 && result.maxMs <= 2500 ? 'degraded' : 'unacceptable'))));
  const status = stable
    ? 'healthy'
    : (emergency ? 'hard-failure'
      : (latencySpike ? 'latency-spike'
        : (result.successRate < thresholds.minSuccessRate ? 'partial-failure' : 'latency-degraded')));
  return { stable, emergency, status, quality };
}

export function requiresImmediateResponse(health) {
  return health.status === 'hard-failure' || health.status === 'latency-spike';
}

export function getActiveQuarantines(state) {
  state.quarantinedNodes ??= {};
  const now = Date.now();
  for (const [node, entry] of Object.entries(state.quarantinedNodes)) {
    if (!entry?.until || Date.parse(entry.until) <= now) delete state.quarantinedNodes[node];
  }
  return new Set(Object.keys(state.quarantinedNodes));
}

// kind 记录隔离原因分层：quality（切前质量不达标，短冷却）、verify（切后验证失败）、
// cooldown（成功切换后的旧出口冷却）、network（真实网络失败，默认）。
export function quarantineNode(state, node, seconds, reason, kind = 'network') {
  if (!node || seconds <= 0) return;
  state.quarantinedNodes ??= {};
  state.quarantinedNodes[node] = {
    until: new Date(Date.now() + (seconds * 1000)).toISOString(),
    reason,
    kind,
  };
}

export function activateCandidateScanBackoff(state, policy, reason) {
  const seconds = policy.candidateScanBackoffSeconds ?? 120;
  if (seconds <= 0) return;
  state.candidateScanBackoffUntil = new Date(Date.now() + (seconds * 1000)).toISOString();
  state.lastCandidateScanOutcome = reason;
}

export function clearCandidateScanBackoff(state) {
  delete state.candidateScanBackoffUntil;
  delete state.lastCandidateScanOutcome;
}
