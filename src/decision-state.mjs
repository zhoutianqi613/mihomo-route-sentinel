import { getBudgetSnapshot } from './switch-budget.mjs';

const PROFILES = new Set(['strict', 'usable', 'rescue', 'pending', 'unknown']);
const ADMISSION_FAILURES = new Set(['baseline-revalidation-rejected', 'external-selection-rejected']);

function matches(record, selection, leaf) {
  if (!record || !selection || !leaf) return false;
  const selected = record.selection ?? record.selected ?? record.to;
  const actualLeaf = record.leaf ?? (selected === leaf ? selected : null);
  return selected === selection && actualLeaf === leaf;
}

function thresholds(probes, kind) {
  const strict = kind === 'candidate';
  return {
    successRate: probes[`${kind}MinSuccessRate`] ?? 1,
    averageMs: probes[`${kind}MaxAverageMs`] ?? (strict ? 600 : 800),
    maxMs: probes[`${kind}MaxSingleMs`] ?? (strict ? 1200 : 1500),
  };
}

function passes(result, limit) {
  return Number.isFinite(result?.successRate)
    && Number.isFinite(result?.averageMs)
    && Number.isFinite(result?.maxMs)
    && result.successRate >= limit.successRate
    && result.averageMs <= limit.averageMs
    && result.maxMs <= limit.maxMs;
}

function roundsOf(evaluation) {
  const rounds = new Map();
  for (const sample of evaluation?.samples ?? []) {
    const round = sample.round ?? 1;
    if (!rounds.has(round)) rounds.set(round, []);
    rounds.get(round).push(sample);
  }
  return [...rounds.values()].map((samples) => {
    const successes = samples.filter((sample) => sample.ok && Number.isFinite(sample.delay));
    const delays = successes.map((sample) => sample.delay);
    return {
      urls: samples.map((sample) => sample.url),
      successRate: successes.length / samples.length,
      averageMs: delays.length ? delays.reduce((sum, delay) => sum + delay, 0) / delays.length : Infinity,
      maxMs: delays.length ? Math.max(...delays) : Infinity,
    };
  });
}

function deriveHealth(evaluation, policy, probes, context, suppliedHealth) {
  const base = {
    selection: context.selection,
    leaf: context.leaf,
    at: evaluation?.timestamp ?? evaluation?.at ?? null,
    source: evaluation ? 'evaluation' : null,
  };
  if (context.selectionMismatch || !matches(evaluation, context.selection, context.leaf)) {
    return { ...base, status: 'unknown', stable: false, quality: null,
      reason: context.selectionMismatch ? 'live-selection-mismatch' : 'no-matching-evaluation' };
  }
  if (!Number.isFinite(evaluation.successRate) || (evaluation.successRate > 0
      && (!Number.isFinite(evaluation.averageMs) || !Number.isFinite(evaluation.maxMs)))) {
    return { ...base, status: 'unknown', stable: false, quality: null, reason: 'incomplete-evaluation' };
  }
  // 全部失败时 Infinity 经 JSON 变成 null；0% 本身仍是完整的硬故障证据。
  const averageMs = evaluation.successRate === 0 ? Infinity : evaluation.averageMs;
  const maxMs = evaluation.successRate === 0 ? Infinity : evaluation.maxMs;
  const emergency = evaluation.successRate <= (policy.emergencySuccessRate ?? 0.5)
    || averageMs > (policy.emergencyMaxAverageMs ?? 3000);
  const spike = !emergency && maxMs > (policy.immediateMaxSingleMs ?? 2500);
  const linkFailure = !emergency && !spike
    && Array.isArray(evaluation.linkFailures) && evaluation.linkFailures.length > 0;
  const limit = thresholds(probes, 'current');
  const stable = !emergency && !spike && !linkFailure && passes(evaluation, limit);
  const status = stable ? 'healthy'
    : (emergency ? 'hard-failure'
      : (spike ? 'latency-spike'
        : (linkFailure || evaluation.successRate < limit.successRate ? 'partial-failure' : 'latency-degraded')));
  // 旧准入拒绝会污染 health；始终由当前样本重建，真实链路失败单独保留。
  const quality = emergency ? 'hard-failure'
    : (evaluation.successRate < 1 || linkFailure ? 'partial-failure'
      : (averageMs <= 500 && maxMs <= 1000 ? 'excellent'
        : (averageMs <= 800 && maxMs <= 1500 ? 'acceptable'
          : (averageMs <= 1200 && maxMs <= 2500 ? 'degraded' : 'unacceptable'))));
  const override = suppliedHealth && !ADMISSION_FAILURES.has(suppliedHealth.status)
    ? suppliedHealth : null;
  return { ...base, status, stable, quality, reason: status, ...override };
}

function deriveAdmission(state, evaluation, health, probes, context, supplied) {
  const base = { selection: context.selection, leaf: context.leaf, at: null,
    verified: false, requiresStrictAdmission: true };
  const profile = (name, source, reason, record = {}) => ({
    ...base, profile: name, source, reason,
    at: record?.timestamp ?? record?.at ?? record?.detectedAt ?? null,
    verified: name === 'strict', requiresStrictAdmission: name !== 'strict',
  });
  if (context.selectionMismatch) return profile('pending', 'controller', 'live-selection-mismatch');
  const admission = supplied ?? state.selectionAdmission;
  if (matches(admission, context.selection, context.leaf) && PROFILES.has(admission.profile)) {
    if (admission.profile !== 'strict' || admission.verified === true) {
      return profile(admission.profile, admission.source ?? 'selection-admission',
        admission.reason ?? `${admission.profile}-admission`, admission);
    }
  }
  const pending = state.externalSelectionPendingAdmission;
  const provisional = state.provisionalFallback;
  const rounds = matches(evaluation, context.selection, context.leaf) ? roundsOf(evaluation) : [];
  const expectedUrls = [...new Set(probes.urls ?? [])];
  const strict = expectedUrls.length > 0
    && rounds.length >= Math.max(2, probes.validationRounds ?? 2)
    && rounds.every((round) => round.urls.length === expectedUrls.length
      && expectedUrls.every((url) => round.urls.includes(url))
      && passes(round, thresholds(probes, 'candidate')));
  if (strict) return profile('strict', 'evaluation', 'strict-rounds-passed', evaluation);
  // 遗留 pending 的存在表示尚欠严格证据，旧 version 标记和历史成功不得抵销它。
  if (matches(pending, context.selection, context.leaf)) {
    return profile('pending', pending.source ?? 'external', 'strict-admission-pending', pending);
  }
  if (matches(provisional, context.selection, context.leaf)) {
    const usable = provisional.profile === 'current-threshold' || provisional.profile === 'usable';
    return profile(usable ? 'usable' : 'rescue', 'provisional-fallback',
      usable ? 'current-threshold-pending-strict-admission' : 'rescue-pending-strict-admission', provisional);
  }
  const strictRecord = [state.lastExternalSelection, state.lastBaselineRevalidation, state.lastSwitch]
    .filter((record) => record?.verified === true && record.reason !== 'rollback-recovered'
      && matches(record, context.selection, context.leaf))
    .sort((left, right) => (Date.parse(right.at ?? '') || 0) - (Date.parse(left.at ?? '') || 0))[0];
  if (strictRecord) return profile('strict', 'legacy-verified-admission', 'strict-admission-record', strictRecord);
  const usable = health.stable && (rounds.length === 0
    || rounds.every((round) => passes(round, thresholds(probes, 'current'))));
  return profile(usable ? 'usable' : 'unknown', usable ? 'evaluation' : null,
    usable ? 'current-health-pending-strict-admission' : 'no-admission-evidence', evaluation);
}

/** 四维状态只汇总事实；不执行选择，也不将准入失败改写为链路故障。 */
export function synchronizeDecisionState(state, policy = {}, options = {}) {
  const selection = options.selection ?? state.currentSelection ?? null;
  const leaf = options.leaf ?? state.currentLeaf ?? selection;
  const context = { selection, leaf, selectionMismatch: options.selectionMismatch === true };
  const probes = options.probes ?? {};
  const evaluation = options.evaluation ?? state.lastEvaluation ?? null;
  const health = deriveHealth(evaluation, policy, probes, context, options.health);
  const decision = state.lastDecision ?? {};
  state.decisionState = {
    version: 1,
    health,
    admission: deriveAdmission(state, evaluation, health, probes, context, options.admission),
    action: { ...decision, type: decision.type ?? decision.action ?? 'unknown',
      reason: decision.reason ?? null, at: decision.at ?? null },
    budget: options.budget ?? getBudgetSnapshot(state, policy, options.now ?? Date.now()),
  };
  return state.decisionState;
}
