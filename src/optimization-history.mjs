import { createHash } from 'node:crypto';
import { ewma } from './estimator.mjs';
import { hasCompleteProbeRounds } from './health-policy.mjs';

const MAX_NODES = 256;
const MAX_OBSERVATIONS = 64;
const finite = value => Number.isFinite(value) && value >= 0;
const contextOf = config => createHash('sha256').update(JSON.stringify([
  config.groups.target, config.groups.candidates, [...config.probes.urls].sort(), config.probes.timeoutMs,
])).digest('hex');

// 只存数值和节点名称；原始 URL、错误文本及 Controller 信息不进入历史状态。
export function createHistoryObservation(result, timing, config) {
  if (config.policy.optimizationHistoryEnabled !== true || !Number.isFinite(timing.at)
    || timing.timeoutMs !== config.probes.timeoutMs || timing.fullTimeout !== true
    || !hasCompleteProbeRounds(result, config.probes.urls, 1)) return null;
  if (typeof result.node !== 'string' || !result.node || result.node.length > 512) return null;
  const observation = {
    context: contextOf(config), node: result.node, at: timing.at,
    attempts: result.attempts, successes: result.successes,
    meanMs: finite(result.averageMs) ? result.averageMs : null,
    p95Ms: finite(result.p95Ms) ? result.p95Ms : null,
  };
  observation.id = createHash('sha256').update(JSON.stringify(observation)).digest('hex');
  return observation;
}

function validObservation(row, now, windowMs) {
  return row && typeof row.id === 'string' && row.id.length <= 128
    && Number.isFinite(row.at) && row.at <= now && row.at >= now - windowMs
    && Number.isInteger(row.attempts) && row.attempts > 0
    && Number.isInteger(row.successes) && row.successes >= 0 && row.successes <= row.attempts
    && (row.successes === 0 || (finite(row.meanMs) && finite(row.p95Ms)));
}

export function mergeOptimizationHistory(state, observations, config, now = Date.now()) {
  if (config.policy.optimizationHistoryEnabled !== true) return;
  const context = contextOf(config);
  const windowMs = config.policy.optimizationHistoryWindowSeconds * 1000;
  const old = state.optimizationHistory;
  const entries = old?.version === 1 && old.context === context && Array.isArray(old.nodes)
    ? old.nodes : [];
  const nodes = new Map();
  const add = (node, row) => {
    if (typeof node !== 'string' || !node || node.length > 512 || !validObservation(row, now, windowMs)) return;
    if (!nodes.has(node)) nodes.set(node, new Map());
    nodes.get(node).set(row.id, { id: row.id, at: row.at, attempts: row.attempts,
      successes: row.successes, meanMs: row.meanMs, p95Ms: row.p95Ms });
  };
  for (const entry of entries.slice(0, MAX_NODES)) {
    if (!Array.isArray(entry?.observations)) continue;
    for (const row of entry.observations.slice(-MAX_OBSERVATIONS)) add(entry.node, row);
  }
  for (const row of observations) if (row?.context === context) add(row.node, row);
  state.optimizationHistory = { version: 1, context, nodes: [...nodes].map(([node, rows]) => ({
    node, observations: [...rows.values()].sort((a, b) => a.at - b.at).slice(-MAX_OBSERVATIONS),
  })).sort((a, b) => b.observations.at(-1).at - a.observations.at(-1).at).slice(0, MAX_NODES) };
}

function windows(rows, intervalMs) {
  const buckets = new Map();
  for (const row of rows) {
    const key = Math.floor(row.at / intervalMs);
    const bucket = buckets.get(key) ?? { key, at: 0, attempts: 0, successes: 0, latencySum: 0, p95Ms: 0, n: 0 };
    bucket.at += row.at;
    bucket.n += 1;
    bucket.attempts += row.attempts;
    bucket.successes += row.successes;
    bucket.latencySum += (row.meanMs ?? 0) * row.successes;
    bucket.p95Ms = Math.max(bucket.p95Ms, row.p95Ms ?? 0);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(bucket => ({ ...bucket, at: bucket.at / bucket.n,
    successRate: bucket.successes / bucket.attempts,
    meanMs: bucket.successes ? bucket.latencySum / bucket.successes : null,
  })).sort((a, b) => a.at - b.at);
}

export function evaluateHistoricalCandidate(state, currentNode, candidateNode, config, now = Date.now()) {
  const policy = config.policy;
  const empty = { eligible: false, reason: 'insufficient-history', comparisons: 0, consecutiveWins: 0 };
  const history = state.optimizationHistory;
  if (history?.version !== 1 || history.context !== contextOf(config) || !Array.isArray(history.nodes)) return empty;
  const get = node => {
    const rows = history.nodes.find(entry => entry?.node === node)?.observations;
    return (Array.isArray(rows) ? rows : [])
      .filter(row => validObservation(row, now, policy.optimizationHistoryWindowSeconds * 1000));
  };
  const currentWindows = windows(get(currentNode), policy.intervalSeconds * 1000);
  const candidateWindows = windows(get(candidateNode), policy.intervalSeconds * 1000);
  const used = new Set();
  const pairs = [];
  for (const candidate of candidateWindows) {
    const current = currentWindows.filter(row => !used.has(row.key)
      && Math.abs(row.at - candidate.at) <= policy.optimizationHistoryMaxSkewSeconds * 1000)
      .sort((a, b) => Math.abs(a.at - candidate.at) - Math.abs(b.at - candidate.at))[0];
    if (!current) continue;
    used.add(current.key);
    pairs.push({ at: Math.max(current.at, candidate.at), current, candidate });
  }
  if (!pairs.length) return empty;
  pairs.sort((a, b) => a.at - b.at);
  const alpha = policy.optimizationHistoryAlpha;
  let current = {};
  let candidate = {};
  let consecutiveWins = 0;
  let previousAt = null;
  const maxGapMs = policy.optimizationHistoryWindowSeconds * 1000 / policy.optimizationHistoryMinComparisons;
  for (const pair of pairs) {
    if (previousAt !== null && pair.at - previousAt > maxGapMs) {
      consecutiveWins = 0;
      current = {};
      candidate = {};
    }
    for (const [estimate, row] of [[current, pair.current], [candidate, pair.candidate]]) {
      estimate.successRate = ewma(estimate.successRate, row.successRate, alpha);
      estimate.meanMs = ewma(estimate.meanMs, row.meanMs ?? config.probes.timeoutMs, alpha);
      estimate.p95Ms = ewma(estimate.p95Ms, row.successes ? row.p95Ms : config.probes.timeoutMs, alpha);
      estimate.score = estimate.meanMs + 0.15 * estimate.p95Ms;
    }
    const improvement = Math.min(policy.minimumImprovementMs, current.score * policy.minimumImprovementRatio);
    const wins = candidate.successRate >= current.successRate
      && candidate.score < current.score && candidate.score <= current.score - improvement;
    consecutiveWins = wins ? consecutiveWins + 1 : 0;
    previousAt = pair.at;
  }
  const fresh = now - previousAt <= policy.candidateSnapshotMaxAgeSeconds * 1000;
  const eligible = fresh && consecutiveWins >= policy.optimizationHistoryMinComparisons;
  return { eligible, reason: !fresh ? 'stale-history' : eligible ? 'sustained-history-improvement'
    : 'history-advantage-not-sustained', comparisons: pairs.length, consecutiveWins,
  lastComparedAt: new Date(previousAt).toISOString(), current, candidate };
}
