import assert from 'node:assert/strict';
import test from 'node:test';
import { createCandidateService } from '../src/candidate-service.mjs';
import { summarizeSamples } from '../src/health-policy.mjs';

const baseConfig = {
  probes: {
    urls: ['https://service-a.example/', 'https://service-b.example/'],
    scanUrlCount: 1,
    scanRounds: 1,
    discoveryTimeoutMs: 50,
    scanDeadlineMs: 200,
    timeoutMs: 50,
    parallelism: 2,
    maxValidationCandidates: 3,
    validationRounds: 2,
    includeRegex: '',
    excludeRegex: '',
    currentMinSuccessRate: 1,
    currentMaxAverageMs: 800,
    currentMaxSingleMs: 1500,
    candidateMinSuccessRate: 1,
    candidateMaxAverageMs: 600,
    candidateMaxSingleMs: 1200,
  },
  groups: { candidates: 'candidates' },
  policy: { candidateSnapshotMaxAgeSeconds: 120 },
};

function makeConfig() {
  return structuredClone(baseConfig);
}

function currentThresholds(config) {
  return {
    minSuccessRate: config.probes.currentMinSuccessRate,
    maxAverageMs: config.probes.currentMaxAverageMs,
    maxSingleMs: config.probes.currentMaxSingleMs,
  };
}

function candidateThresholds(config) {
  return {
    minSuccessRate: config.probes.candidateMinSuccessRate,
    maxAverageMs: config.probes.candidateMaxAverageMs,
    maxSingleMs: config.probes.candidateMaxSingleMs,
  };
}

function createFakeClock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    nowIso: () => new Date(now).toISOString(),
    advance: (milliseconds) => { now += milliseconds; },
  };
}

function withProbeStats(results, stats) {
  Object.defineProperty(results, 'probeStats', { enumerable: false, value: stats });
  return results;
}

function makeResult(node, { delay = 100, score = 100, rounds = 2, urls = baseConfig.probes.urls } = {}) {
  const samples = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const url of urls) samples.push({ node, round, url, ok: true, delay });
  }
  const summary = summarizeSamples(node, samples);
  return { ...summary, node, score };
}

function createHarness({ candidates = [], responses = [], clock = createFakeClock() } = {}) {
  const config = makeConfig();
  const events = [];
  const logger = async (level, event, details) => { events.push({ level, event, details }); };
  const probes = {
    calls: [],
    async probeCandidatesInParallel(nodes, rounds, urls, deadlineAt, options) {
      probes.calls.push({ nodes: [...nodes], rounds, urls: [...urls], deadlineAt, options });
      const next = responses.shift();
      return typeof next === 'function' ? next() : (next ?? withProbeStats([], { method: 'per-node' }));
    },
  };
  const controller = {
    async getProxy() {
      return { name: config.groups.candidates, type: 'URLTest', all: candidates };
    },
  };
  let activeScan = null;
  const service = createCandidateService({
    controller,
    config,
    logger,
    probes,
    currentThresholds: () => currentThresholds(config),
    candidateThresholds: () => candidateThresholds(config),
    clock,
    getActiveCandidateScan: () => activeScan,
    setActiveCandidateScan: (scan) => { activeScan = scan; },
  });
  return { service, config, probes, events, clock, controller, getActiveScan: () => activeScan, setActiveScan: (scan) => { activeScan = scan; } };
}

test('filterCandidates excludes current/quarantined nodes and honors include/exclude regex', () => {
  const { service, config } = createHarness();
  assert.deepEqual(
    service.filterCandidates(['a', 'b', 'c', 'a'], 'a', new Set(['b'])),
    ['c'],
  );

  config.probes.includeRegex = '香港|新加坡';
  assert.deepEqual(
    service.filterCandidates(['香港 01', '日本 01', '新加坡 02'], 'current'),
    ['香港 01', '新加坡 02'],
  );

  config.probes.includeRegex = '';
  config.probes.excludeRegex = '测试';
  assert.deepEqual(
    service.filterCandidates(['香港 测试', '香港 01'], 'current'),
    ['香港 01'],
  );
});

test('candidate snapshot keeps identity and expires after the configured age', () => {
  const clock = createFakeClock();
  const { service } = createHarness({ clock });
  const search = {
    durationMs: 10,
    deadlineMs: 20,
    deadlineReached: false,
    stable: [{ node: 'strict' }],
    provisional: [{ node: 'provisional' }],
    validated: [
      makeResult('strict', { delay: 100, score: 300 }),
      makeResult('provisional', { delay: 700, score: 200 }),
      makeResult('rejected', { delay: 900, score: 100 }),
    ],
    sampled: [{ node: 'sampled', attempts: 2, successes: 2, successRate: 1, averageMs: null, maxMs: null, jitterMs: null, score: null }],
  };

  const snapshot = service.createCandidateSnapshot(search, 'selection', 'leaf');
  assert.equal(snapshot.selection, 'selection');
  assert.equal(snapshot.leaf, 'leaf');
  assert.equal(snapshot.at, clock.nowIso());
  assert.deepEqual(snapshot.candidates.map((entry) => [entry.node, entry.profile]), [
    ['strict', 'strict'],
    ['provisional', 'current-health'],
    ['rejected', 'rejected'],
  ]);
  assert.equal(snapshot.sampled[0].node, 'sampled');

  const restored = service.searchFromCandidateSnapshot(snapshot, 'selection', 'leaf');
  assert.equal(restored.source, 'candidate-snapshot');
  assert.equal(restored.ageMs, 0);
  assert.deepEqual(restored.stable.map((entry) => entry.node), ['strict']);
  assert.deepEqual(restored.provisional.map((entry) => entry.node), ['provisional']);
  assert.deepEqual(restored.rejected, [{ node: 'rejected', reasons: ['cached-rejected'] }]);
  assert.equal(restored.validated.every((entry) => Array.isArray(entry.samples) && entry.samples.length === 0), true);

  assert.equal(service.searchFromCandidateSnapshot(snapshot, 'other-selection', 'leaf'), null);
  assert.equal(service.searchFromCandidateSnapshot(snapshot, 'selection', 'other-leaf'), null);

  clock.advance(121_000);
  assert.equal(service.searchFromCandidateSnapshot(snapshot, 'selection', 'leaf'), null);
});

test('searchFromCandidateSnapshot inflates missing metrics and preserves probe stats', () => {
  const clock = createFakeClock();
  const { service } = createHarness({ clock });
  const snapshot = {
    at: clock.nowIso(),
    selection: 's',
    leaf: 'l',
    durationMs: 5,
    deadlineMs: 9,
    deadlineReached: true,
    probeStats: { discovery: { peakConcurrency: 2 } },
    candidates: [
      { node: 'a', attempts: 2, successes: 2, successRate: 1, averageMs: null, maxMs: null, jitterMs: null, score: null, profile: 'strict' },
    ],
    sampled: [{ node: 'b', attempts: 1, successes: 0, successRate: 0, averageMs: null, maxMs: null, jitterMs: null, score: null }],
  };
  const restored = service.searchFromCandidateSnapshot(snapshot, 's', 'l');
  assert.equal(restored.validated[0].averageMs, Infinity);
  assert.equal(restored.validated[0].maxMs, Infinity);
  assert.equal(restored.validated[0].jitterMs, Infinity);
  assert.equal(restored.validated[0].score, Infinity);
  assert.equal(restored.sampled[0].averageMs, Infinity);
  assert.deepEqual(restored.probeStats, { discovery: { peakConcurrency: 2 } });
  assert.equal(restored.deadlineReached, true);
  assert.equal(restored.completedAt, snapshot.at);
});

test('findCandidates ranks the shortlist, classifies strict/provisional/rejected and reports deadline', async () => {
  const clock = createFakeClock();
  const urls = baseConfig.probes.urls;
  const quick = withProbeStats([
    makeResult('strict', { delay: 100, score: 300 }),
    makeResult('provisional', { delay: 700, score: 200 }),
    makeResult('rejected', { delay: 900, score: 100 }),
    { node: 'dead', attempts: 2, successes: 0, successRate: 0, averageMs: null, maxMs: null, jitterMs: null, score: 99, samples: [] },
  ], { method: 'per-node', controllerRequests: 4 });
  const validated = withProbeStats([
    makeResult('rejected', { delay: 900, score: 100 }),
    makeResult('provisional', { delay: 700, score: 200 }),
    makeResult('strict', { delay: 100, score: 300, urls }),
  ], { method: 'per-node', controllerRequests: 12 });
  const { service, probes, events } = createHarness({
    clock,
    candidates: ['strict', 'provisional', 'rejected', 'dead'],
    responses: [() => { clock.advance(250); return quick; }, validated],
  });

  const result = await service.findCandidates('current', new Set());

  assert.deepEqual(probes.calls[0].nodes, ['strict', 'provisional', 'rejected', 'dead']);
  assert.equal(probes.calls[0].rounds, 1);
  assert.deepEqual(probes.calls[0].urls, [urls[0]]);
  assert.deepEqual(probes.calls[1].nodes, ['rejected', 'provisional', 'strict']);
  assert.equal(probes.calls[1].rounds, 2);
  assert.deepEqual(probes.calls[1].urls, urls);

  assert.deepEqual(result.stable.map((entry) => entry.node), ['strict']);
  assert.deepEqual(result.provisional.map((entry) => entry.node), ['provisional']);
  assert.deepEqual(result.rejected.map((entry) => entry.node).sort(), ['provisional', 'rejected']);
  assert.equal(result.rejected.every((entry) => entry.reasons.includes('average-latency')), true);
  assert.equal(result.sampled.length, 4);
  assert.deepEqual(result.probeStats.discovery, { method: 'per-node', controllerRequests: 4 });
  assert.deepEqual(result.probeStats.validation, { method: 'per-node', controllerRequests: 12 });
  assert.equal(result.deadlineReached, true);
  assert.ok(result.durationMs >= 0);
  assert.equal(events.some((entry) => entry.event === 'candidate-validation-completed'), true);
});

test('candidateScanMatches requires both selection and leaf identity', () => {
  const { service } = createHarness();
  assert.equal(service.candidateScanMatches({ selection: 's', leaf: 'l' }, 's', 'l'), true);
  assert.equal(service.candidateScanMatches({ selection: 's', leaf: 'l' }, 's', 'other'), false);
  assert.equal(service.candidateScanMatches({ selection: 's', leaf: 'l' }, 'other', 'l'), false);
  assert.equal(service.candidateScanMatches(null, 's', 'l'), false);
  assert.equal(service.candidateScanMatches({}, 's', 'l'), false);
});

test('findCandidates degrades to empty result when the candidate group is empty', async () => {
  const { service, probes, events } = createHarness({ candidates: [] });
  const result = await service.findCandidates('current', new Set());

  assert.deepEqual(result.stable, []);
  assert.deepEqual(result.validated, []);
  assert.equal(result.deadlineReached, false);
  assert.equal(result.deadlineMs, baseConfig.probes.scanDeadlineMs);
  assert.equal(probes.calls.length, 0);
  const emptyEvent = events.find((entry) => entry.event === 'candidate-source-empty');
  assert.deepEqual(emptyEvent.details, { group: 'candidates' });
  assert.equal(emptyEvent.level, 'error');
});

test('startBackgroundCandidateScan cancels the previous scan and exposes a handle through get/set', async () => {
  const { service, getActiveScan, setActiveScan } = createHarness({ candidates: [] });
  let cancelled = 0;
  const previous = { cancel: () => { cancelled += 1; } };
  setActiveScan(previous);

  const first = service.startBackgroundCandidateScan({
    selection: 's', leaf: 'l', excludedNodes: new Set(), allowProvisionalRecovery: false, reason: 'first',
  });
  assert.equal(cancelled, 1);
  assert.equal(getActiveScan(), first);
  assert.equal(first.completed, false);
  assert.equal(typeof first.startedAt, 'string');

  const second = service.startBackgroundCandidateScan({
    selection: 's', leaf: 'l2', excludedNodes: new Set(), allowProvisionalRecovery: true, reason: 'second',
  });
  assert.equal(getActiveScan(), second);

  await second.promise;
  await first.promise;
  assert.equal(second.completed, true);
  assert.equal(second.selection, 's');
  assert.equal(second.leaf, 'l2');
  assert.equal(second.recovery, true);
});
