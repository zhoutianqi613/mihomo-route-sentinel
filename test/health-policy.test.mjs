import assert from 'node:assert/strict';
import test from 'node:test';
import { quantile, wilsonLowerBound } from '../src/estimator.mjs';
import {
  classifyHealth,
  compareAvailability,
  explainRoundStability,
  getActiveQuarantines,
  hasCompleteProbeRounds,
  hasStrictAdmissionEvidence,
  isAvailabilityImprovement,
  quarantineNode,
  recordDegradation,
  requiresImmediateResponse,
  summarizeSamples,
} from '../src/health-policy.mjs';

const thresholds = { minSuccessRate: 1, maxAverageMs: 800, maxSingleMs: 1500 };
const candidateThresholds = { minSuccessRate: 1, maxAverageMs: 600, maxSingleMs: 1200 };
const policy = {
  emergencySuccessRate: 0.5,
  emergencyMaxAverageMs: 3000,
  immediateMaxSingleMs: 2500,
  minimumImprovementMs: 200,
  minimumImprovementRatio: 0.2,
  degradationWindowCycles: 10,
  degradationWindowFailures: 3,
};

test('classifyHealth distinguishes healthy, latency-degraded, hard-failure and spike branches', () => {
  assert.deepEqual(
    classifyHealth({ successRate: 1, averageMs: 500, maxMs: 900 }, thresholds, policy),
    { stable: true, emergency: false, status: 'healthy', quality: 'excellent' },
  );
  assert.deepEqual(
    classifyHealth({ successRate: 1, averageMs: 1000, maxMs: 1600 }, thresholds, policy),
    { stable: false, emergency: false, status: 'latency-degraded', quality: 'degraded' },
  );
  assert.deepEqual(
    classifyHealth({ successRate: 0.25, averageMs: 900, maxMs: 1200 }, thresholds, policy),
    { stable: false, emergency: true, status: 'hard-failure', quality: 'hard-failure' },
  );
  assert.deepEqual(
    classifyHealth({ successRate: 1, averageMs: 700, maxMs: 2600 }, thresholds, policy),
    { stable: false, emergency: false, status: 'latency-spike', quality: 'unacceptable' },
  );
  assert.equal(
    requiresImmediateResponse({ status: 'latency-spike' }),
    true,
  );
  assert.equal(requiresImmediateResponse({ status: 'latency-degraded' }), false);
});

test('isAvailabilityImprovement applies min(200ms, 20% of current average)', () => {
  const fast = { successes: 4, successRate: 1, averageMs: 500 };
  assert.equal(
    isAvailabilityImprovement({ successes: 4, successRate: 1, averageMs: 400 }, fast, policy),
    true,
  );
  assert.equal(
    isAvailabilityImprovement({ successes: 4, successRate: 1, averageMs: 401 }, fast, policy),
    false,
  );

  const slow = { successes: 4, successRate: 1, averageMs: 2000 };
  assert.equal(
    isAvailabilityImprovement({ successes: 4, successRate: 1, averageMs: 1800 }, slow, policy),
    true,
  );
  assert.equal(
    isAvailabilityImprovement({ successes: 4, successRate: 1, averageMs: 1801 }, slow, policy),
    false,
  );

  assert.equal(
    isAvailabilityImprovement({ successes: 4, successRate: 1, averageMs: 100 }, { successes: 4, successRate: 0.9, averageMs: 500 }, policy),
    true,
  );
  assert.equal(
    isAvailabilityImprovement({ successes: 4, successRate: 0.8, averageMs: 100 }, { successes: 4, successRate: 1, averageMs: 500 }, policy),
    false,
  );
  assert.equal(
    isAvailabilityImprovement({ successes: 0, successRate: 0, averageMs: 100 }, fast, policy),
    false,
  );
});

test('summarizeSamples exposes Wilson lower bound, quantiles and latency upper bound', () => {
  const delays = [100, 200, 300, 400];
  const result = summarizeSamples('node-a', delays.map((delay) => ({ ok: true, delay })));

  assert.equal(result.node, 'node-a');
  assert.equal(result.attempts, 4);
  assert.equal(result.successes, 4);
  assert.equal(result.successRate, 1);
  assert.equal(result.averageMs, 250);
  assert.equal(result.maxMs, 400);
  assert.equal(result.successLowerBound, wilsonLowerBound(4, 4));
  assert.ok(result.successLowerBound > 0.5 && result.successLowerBound < 0.55);
  assert.equal(result.p50Ms, 250);
  assert.equal(result.p95Ms, quantile([100, 200, 300, 400], 0.95));
  assert.equal(result.stdMs, result.jitterMs);
  assert.ok(result.latencyUpperMs > result.averageMs);
  assert.ok(Number.isFinite(result.score));
});

test('summarizeSamples keeps failures in attempts but out of delay distributions', () => {
  const withFailure = summarizeSamples('node-b', [
    { ok: true, delay: 100 },
    { ok: true, delay: 200 },
    { ok: true, delay: 300 },
    { ok: true, delay: 400 },
    { ok: false, error: 'ETIMEDOUT' },
  ]);
  assert.equal(withFailure.attempts, 5);
  assert.equal(withFailure.successes, 4);
  assert.equal(withFailure.successRate, 0.8);
  assert.equal(withFailure.successLowerBound, wilsonLowerBound(4, 5));
  assert.equal(withFailure.p95Ms, quantile([100, 200, 300, 400], 0.95));
  const allSuccessful = summarizeSamples('node-c', [100, 200, 300, 400].map((delay) => ({ ok: true, delay })));
  assert.ok(withFailure.score > allSuccessful.score);
});

test('quarantineNode records expiry/kind and getActiveQuarantines prunes inactive entries', () => {
  const state = {};
  quarantineNode(state, 'future-node', 60, 'test-reason');
  quarantineNode(state, 'quality-node', 30, 'quality-reason', 'quality');
  quarantineNode(state, 'zero-node', 0, 'ignored');
  quarantineNode(state, '', 60, 'ignored');

  const future = state.quarantinedNodes['future-node'];
  const futureUntil = Date.parse(future.until);
  assert.ok(futureUntil > Date.now() && futureUntil <= Date.now() + 61_000);
  assert.equal(future.reason, 'test-reason');
  assert.equal(future.kind, 'network');
  assert.equal(state.quarantinedNodes['quality-node'].kind, 'quality');
  assert.equal(state.quarantinedNodes['zero-node'], undefined);

  state.quarantinedNodes.expired = { until: new Date(Date.now() - 1000).toISOString(), reason: 'old' };
  state.quarantinedNodes.noUntil = { reason: 'missing-until' };
  const active = getActiveQuarantines(state);
  assert.ok(active instanceof Set);
  assert.deepEqual([...active].sort(), ['future-node', 'quality-node']);
  assert.equal(state.quarantinedNodes.expired, undefined);
  assert.equal(state.quarantinedNodes.noUntil, undefined);
});

test('explainRoundStability reports per-round reasons before aggregating', () => {
  const result = {
    node: 'round-node',
    samples: [
      { round: 1, url: 'https://a', ok: true, delay: 900 },
      { round: 1, url: 'https://b', ok: true, delay: 900 },
      { round: 2, url: 'https://a', ok: false, error: 'ETIMEDOUT' },
      { round: 2, url: 'https://b', ok: true, delay: 100 },
    ],
  };
  const explanation = explainRoundStability(result, thresholds);
  assert.equal(explanation.stable, false);
  assert.deepEqual(explanation.reasons.sort(), ['average-latency', 'success-rate']);
  assert.equal(explanation.rounds.length, 2);
  const [first, second] = explanation.rounds;
  assert.equal(first.round, 1);
  assert.equal(first.stable, false);
  assert.deepEqual(first.reasons, ['average-latency']);
  assert.equal(first.averageMs, 900);
  assert.equal(first.maxMs, 900);
  assert.equal(second.reasons.includes('success-rate'), true);
  assert.equal(second.averageMs, 100);

  const allPass = explainRoundStability({
    node: 'pass-node',
    samples: [
      { round: 1, url: 'https://a', ok: true, delay: 100 },
      { round: 2, url: 'https://a', ok: true, delay: 200 },
    ],
  }, thresholds);
  assert.equal(allPass.stable, true);
  assert.deepEqual(allPass.reasons, []);
});

test('hasCompleteProbeRounds and hasStrictAdmissionEvidence require every round and every url', () => {
  const urls = ['https://a', 'https://b'];
  const complete = {
    node: 'strict-node',
    samples: [
      { round: 1, url: 'https://a', ok: true, delay: 300 },
      { round: 1, url: 'https://b', ok: true, delay: 300 },
      { round: 2, url: 'https://a', ok: true, delay: 300 },
      { round: 2, url: 'https://b', ok: true, delay: 300 },
    ],
  };
  assert.equal(hasCompleteProbeRounds(complete, urls, 2), true);
  assert.equal(
    hasStrictAdmissionEvidence(complete, { urls, validationRounds: 2 }, candidateThresholds),
    true,
  );

  const missingRound = { node: 'partial-node', samples: complete.samples.slice(0, 2) };
  assert.equal(hasCompleteProbeRounds(missingRound, urls, 2), false);
  assert.equal(
    hasStrictAdmissionEvidence(missingRound, { urls, validationRounds: 2 }, candidateThresholds),
    false,
  );

  const cancelled = {
    node: 'cancelled-node',
    samples: complete.samples.map((sample) => ({ ...sample, error: 'SCAN_DEADLINE' })),
  };
  assert.equal(hasCompleteProbeRounds(cancelled, urls, 2), false);

  // 两轮平均 300ms 看似合格，但第二轮单独超过严格线时不能给出严格准入证据。
  const oneSlowRound = {
    node: 'slow-round-node',
    samples: [
      { round: 1, url: 'https://a', ok: true, delay: 100 },
      { round: 1, url: 'https://b', ok: true, delay: 100 },
      { round: 2, url: 'https://a', ok: true, delay: 700 },
      { round: 2, url: 'https://b', ok: true, delay: 700 },
    ],
  };
  assert.equal(hasCompleteProbeRounds(oneSlowRound, urls, 2), true);
  assert.equal(
    hasStrictAdmissionEvidence(oneSlowRound, { urls, validationRounds: 2 }, candidateThresholds),
    false,
  );
});

test('recordDegradation rolls a bounded window and triggers at the failure threshold', () => {
  const state = {};
  const shortPolicy = { degradationWindowCycles: 3, degradationWindowFailures: 2 };
  assert.deepEqual(recordDegradation(state, { status: 'healthy' }, shortPolicy), {
    cycles: 1, failures: 0, required: 2, triggered: false,
  });
  assert.deepEqual(recordDegradation(state, { status: 'latency-degraded' }, shortPolicy), {
    cycles: 2, failures: 1, required: 2, triggered: false,
  });
  assert.deepEqual(recordDegradation(state, { status: 'latency-spike' }, shortPolicy), {
    cycles: 3, failures: 2, required: 2, triggered: true,
  });
  const result = recordDegradation(state, { status: 'healthy' }, shortPolicy);
  assert.deepEqual(result, { cycles: 3, failures: 2, required: 2, triggered: true });
  assert.equal(state.degradationWindow.length, 3);
  assert.equal(typeof state.degradationWindow[0].at, 'string');
});

test('compareAvailability prefers conservative bounds and falls back for legacy snapshots', () => {
  const better = { node: 'a', successRate: 0.9, successLowerBound: 0.7, latencyUpperMs: 400, averageMs: 500, maxMs: 600, jitterMs: 10 };
  const worse = { node: 'b', successRate: 0.9, successLowerBound: 0.6, latencyUpperMs: 300, averageMs: 500, maxMs: 600, jitterMs: 10 };
  assert.ok(compareAvailability(better, worse) < 0);
  assert.ok(compareAvailability(worse, better) > 0);

  const legacyFast = { node: 'a', successRate: 1, averageMs: 400, maxMs: 500, jitterMs: 5 };
  const legacySlow = { node: 'b', successRate: 0.8, averageMs: 300, maxMs: 400, jitterMs: 5 };
  assert.ok(compareAvailability(legacyFast, legacySlow) < 0);
});
