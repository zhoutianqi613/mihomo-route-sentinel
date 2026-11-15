// 审计只消费已经取得的证据，不参与候选排序、准入或切换预算计算。
import { explainRoundStability, hasCompleteProbeRounds } from './health-policy.mjs';

const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const incompleteErrors = new Set(['SCAN_DEADLINE', 'PROBE_CANCELLED', 'ABORT_ERR']);

export function compactProbeEvidence(result, thresholds) {
  if (!result) return null;
  const evidence = {
    startedAt: isoTime(result.startedAt), completedAt: isoTime(result.completedAt),
  };
  for (const key of ['attempts', 'successes', 'successRate', 'averageMs', 'maxMs', 'p95Ms', 'jitterMs',
    'successLowerBound', 'latencyUpperMs', 'score']) {
    evidence[key] = Number.isFinite(result[key]) ? result[key] : null;
  }
  if (thresholds) evidence.rounds = explainRoundStability(result, thresholds).rounds;
  return evidence;
}

export function buildCandidateScanAudit({ source, currentLeaf, excludedNodes, config,
  sampled, ranked, validated, stable, provisional, thresholds }) {
  const include = config.probes.includeRegex ? new RegExp(config.probes.includeRegex, 'i') : null;
  const exclude = config.probes.excludeRegex ? new RegExp(config.probes.excludeRegex, 'i') : null;
  const discovered = new Map(sampled.map(row => [row.node, row]));
  const checked = new Map(validated.map(row => [row.node, row]));
  const shortlisted = new Set(ranked.map(row => row.node));
  const strictNames = new Set(stable.map(row => row.node));
  const provisionalNames = new Set(provisional.map(row => row.node));
  return [...new Set(source)].map(node => {
    const discovery = discovered.get(node);
    const validation = checked.get(node);
    let status;
    let reasons;
    if (node === currentLeaf) reasons = ['current-node'];
    else if (excludedNodes.has(node)) reasons = ['excluded-node'];
    else if (include && !include.test(node)) reasons = ['include-regex'];
    else if (exclude?.test(node)) reasons = ['exclude-regex'];
    if (reasons) status = 'filtered';
    else if (!discovery) { status = 'not-measured'; reasons = ['not-measured']; }
    else if (discovery.successes <= 0) {
      status = discovery.samples?.some(row => incompleteErrors.has(row.error))
        ? 'discovery-incomplete' : 'discovery-no-success';
      reasons = [status];
    } else if (!shortlisted.has(node)) { status = 'not-shortlisted'; reasons = [status]; }
    else if (!validation || !hasCompleteProbeRounds(validation, config.probes.urls,
      Math.max(2, config.probes.validationRounds))) {
      status = 'validation-incomplete'; reasons = [status];
    } else {
      status = strictNames.has(node) ? 'strict' : provisionalNames.has(node) ? 'current-health' : 'rejected';
      reasons = status === 'strict' ? [] : explainRoundStability(validation, thresholds).reasons;
    }
    return { node, status, reasons, discovery: compactProbeEvidence(discovery),
      validation: compactProbeEvidence(validation, thresholds) };
  });
}

export function buildLiveCandidateComparison({ at, stage, decisionId, scanId, snapshotAt,
  selection, leaf, current, results, ranked, reasons = new Map(), thresholds }) {
  const ranks = new Map(ranked.map((row, index) => [row.node, index + 1]));
  return {
    at, stage, decisionId, scanId, snapshotAt, selection, leaf,
    current: { node: current.node, ...compactProbeEvidence(current) },
    roundThresholds: thresholds,
    preferredNode: ranked[0]?.node ?? null,
    candidates: results.map(row => {
      const rank = ranks.get(row.node) ?? null;
      const outcome = rank === 1 ? 'preferred' : rank ? 'ranked-behind' : 'rejected';
      return { node: row.node, rank, outcome,
        reasons: rank ? (rank === 1 ? [] : ['ranked-behind']) : (reasons.get(row.node) ?? ['no-relative-improvement']),
        evidence: compactProbeEvidence(row, thresholds) };
    }),
  };
}

export const candidateReasonLabels = Object.freeze({
  'switch-budget-exhausted': '切换预算耗尽', healthy: '当前健康，保持选择',
  'failure-threshold-not-reached': '连续异常尚未达到门槛',
  'optimization-history-pending': '等待历史持续优势', 'minimum-dwell-active': '最短驻留尚未结束',
  'current-node': '当前节点，由健康检查测评', 'excluded-node': '隔离或调用方排除',
  'include-regex': '未匹配包含规则', 'exclude-regex': '命中排除规则',
  'not-measured': '未取得测评', 'discovery-no-success': '初筛无成功响应',
  'discovery-incomplete': '初筛证据未采齐', 'not-shortlisted': '初筛排名未进入复测短名单',
  'validation-incomplete': '复测证据未采齐', 'incomplete-evidence': '切前证据未采齐',
  'success-rate': '成功率不足', 'average-latency': '单轮平均延迟超限',
  'single-latency': '单次延迟超限', 'ranked-behind': '本次比较排名靠后',
  'no-successful-sample': '本次无成功样本', 'no-relative-improvement': '本次未达到相对改善条件',
  'history-advantage-not-sustained': '历史优势未持续', 'insufficient-history': '历史样本不足',
  'stale-history': '历史配对过期', 'dynamic-candidate-history-unbound': '动态叶子历史未绑定',
});
