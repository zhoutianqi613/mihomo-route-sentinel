import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { MihomoController } from '../src/controller.mjs';
import { classifyHealth, summarizeSamples, Watchdog } from '../src/watchdog.mjs';

function startMockController({
  initialSelected = 'bad-node',
  flakyCandidate = false,
  candidates: configuredCandidates,
  delayResolver,
  targetHistoryDelay,
} = {}) {
  let selected = initialSelected;
  const switches = [];
  let flakyProbeCount = 0;
  const probeCounts = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const name = parts[1] ? decodeURIComponent(parts[1]) : '';

    if (request.method === 'GET' && url.pathname === '/proxies/XFLTD') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        name: 'XFLTD',
        type: 'Selector',
        now: selected,
        alive: true,
        history: targetHistoryDelay == null ? [] : [{ delay: targetHistoryDelay }],
      }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/proxies/candidates') {
      response.setHeader('Content-Type', 'application/json');
      const all = configuredCandidates ?? (flakyCandidate
        ? ['bad-node', 'flaky-node', 'good-node', 'slow-node']
        : ['bad-node', 'good-node', 'slow-node']);
      response.end(JSON.stringify({ name: 'candidates', type: 'URLTest', all }));
      return;
    }
    if (request.method === 'GET' && parts.length === 2) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ name, type: 'VLESS', alive: name !== 'bad-node' }));
      return;
    }
    if (request.method === 'GET' && parts[2] === 'delay') {
      const targetUrl = url.searchParams.get('url');
      const countKey = `${name}\u0000${targetUrl}`;
      const probeCount = (probeCounts.get(countKey) ?? 0) + 1;
      probeCounts.set(countKey, probeCount);
      const resolvedDelay = delayResolver?.({ name, targetUrl, probeCount });
      if (resolvedDelay === null || (resolvedDelay === undefined && name === 'bad-node')
        || (resolvedDelay === undefined && name === 'flaky-node' && ++flakyProbeCount > 3)) {
        response.statusCode = 504;
        response.end(JSON.stringify({ message: 'timeout' }));
      } else {
        response.setHeader('Content-Type', 'application/json');
        const delay = resolvedDelay ?? (name === 'flaky-node' ? 80
          : (name === 'good-node' ? 120 : (name === 'degraded-node' ? 1500 : 2500)));
        response.end(JSON.stringify({ delay }));
      }
      return;
    }
    if (request.method === 'PUT' && url.pathname === '/proxies/XFLTD') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        selected = JSON.parse(Buffer.concat(chunks).toString('utf8')).name;
        switches.push(selected);
        response.statusCode = 204;
        response.end();
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        getSelected: () => selected,
        switches,
        probeCounts,
      });
    });
  });
}

async function makeConfig(controllerUrl) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mihomo-watchdog-'));
  const config = structuredClone(defaults);
  config.controller.transport = 'http';
  config.controller.url = controllerUrl;
  config.controller.requestTimeoutMs = 1000;
  config.groups.target = 'XFLTD';
  config.groups.candidates = 'candidates';
  config.probes.urls = ['https://service.example/'];
  config.probes.timeoutMs = 500;
  config.probes.currentRounds = 1;
  config.probes.scanRounds = 1;
  config.probes.validationRounds = 2;
  config.probes.topCandidates = 3;
  config.probes.parallelism = 3;
  config.probes.currentMaxAverageMs = 800;
  config.probes.currentMaxSingleMs = 1500;
  config.probes.candidateMaxAverageMs = 600;
  config.probes.candidateMaxSingleMs = 1200;
  config.policy.partialFailureCycles = 1;
  config.policy.latencyFailureCycles = 1;
  config.policy.hardFailureConfirmSeconds = 0;
  config.policy.minimumDwellSeconds = 0;
  config.policy.postSwitchDelaySeconds = 0;
  config.policy.postSwitchRounds = 1;
  config.files.state = path.join(root, 'state.json');
  config.files.log = path.join(root, 'watchdog.ndjson');
  config.files.lock = path.join(root, 'watchdog.lock');
  return config;
}

test('summarizeSamples prioritizes success rate before latency', () => {
  const stable = summarizeSamples('stable', [
    { ok: true, delay: 500 },
    { ok: true, delay: 600 },
  ]);
  const flaky = summarizeSamples('flaky', [
    { ok: true, delay: 50 },
    { ok: false },
  ]);
  assert.ok(stable.score < flaky.score);
  assert.equal(stable.successRate, 1);
});

test('runtime metadata is persisted for deployed-version verification', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const runtime = { version: 'test-version', pid: 1234, startedAt: '2026-10-24T00:00:00.000Z' };
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    runtime,
    logger: async () => {},
  });

  await watchdog.runOnce({ dryRun: false });

  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.deepEqual(state.runtime, runtime);
});

test('health classification distinguishes hard, partial, and latency failures', () => {
  const thresholds = { minSuccessRate: 1, maxAverageMs: 800, maxSingleMs: 1500 };
  const policy = {
    emergencySuccessRate: 0.5,
    emergencyMaxAverageMs: 3000,
    immediateMaxSingleMs: 2500,
  };
  assert.deepEqual(classifyHealth({ successRate: 0.5, averageMs: 800, maxMs: 900 }, thresholds, policy), {
    stable: false,
    emergency: true,
    status: 'hard-failure',
    quality: 'hard-failure',
  });
  assert.deepEqual(classifyHealth({ successRate: 0.75, averageMs: 800, maxMs: 900 }, thresholds, policy), {
    stable: false,
    emergency: false,
    status: 'partial-failure',
    quality: 'partial-failure',
  });
  assert.deepEqual(classifyHealth({ successRate: 1, averageMs: 1500, maxMs: 1600 }, thresholds, policy), {
    stable: false,
    emergency: false,
    status: 'latency-degraded',
    quality: 'unacceptable',
  });
  assert.equal(classifyHealth({ successRate: 1, averageMs: 500, maxMs: 1000 }, thresholds, policy).quality, 'excellent');
  assert.equal(classifyHealth({ successRate: 1, averageMs: 700, maxMs: 1400 }, thresholds, policy).quality, 'acceptable');
  assert.equal(classifyHealth({ successRate: 1, averageMs: 1000, maxMs: 2000 }, thresholds, policy).quality, 'degraded');
  assert.deepEqual(classifyHealth({ successRate: 1, averageMs: 1400, maxMs: 2600 }, thresholds, policy), {
    stable: false,
    emergency: false,
    status: 'latency-spike',
    quality: 'unacceptable',
  });
  assert.equal(classifyHealth(
    { successRate: 1, averageMs: 1400, maxMs: 2600 },
    { ...thresholds, maxAverageMs: 5000, maxSingleMs: 5000 },
    policy,
  ).stable, false);
});

test('候选连续验证任一轮不合格时不能被另一轮平均值掩盖', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'mixed-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      if (name === 'mixed-node') return probeCount % 2 === 0 ? 1100 : 100;
      return 100;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: true, forceScan: true });

  assert.equal(result.status, 'no-candidate', JSON.stringify([...mock.probeCounts.entries()]));
  assert.deepEqual(mock.switches, []);
});

test('watchdog switches an unhealthy node to a validated candidate', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const controller = new MihomoController(config.controller, {});
  const events = [];
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'good-node');
  assert.deepEqual(mock.switches, ['good-node']);
  assert.ok(events.some((entry) => entry.event === 'switch-verified'));
  const next = await watchdog.runOnce({ dryRun: false });
  assert.equal(next.status, 'healthy');
  assert.equal(events.some((entry) => entry.event === 'external-selection-detected'), false);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.lastSwitch.to, 'good-node');
  assert.equal(state.lastSwitch.verified, true);
  assert.equal(state.switchHistory.length, 1);
});

test('runtime guard failure blocks every actual node selection', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async () => {},
    beforeSwitch: async () => {
      const error = new Error('guard blocked');
      error.code = 'GUARDRAIL_BLOCKED';
      throw error;
    },
  });

  await assert.rejects(watchdog.runOnce({ dryRun: false }), { code: 'GUARDRAIL_BLOCKED' });
  assert.equal(mock.getSelected(), 'bad-node');
  assert.deepEqual(mock.switches, []);
});

test('dry run recommends a candidate without switching', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const originalState = '{\n  "consecutiveFailures": 7,\n  "switchHistory": ["2026-01-01T00:00:00.000Z"]\n}\n';
  await writeFile(config.files.state, originalState);
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: true });
  assert.equal(result.status, 'would-switch');
  assert.equal(result.candidate.node, 'good-node');
  assert.equal(mock.getSelected(), 'bad-node');
  assert.deepEqual(mock.switches, []);
  assert.equal(await readFile(config.files.state, 'utf8'), originalState);
});

test('forced scan on a healthy node does not increase failure counters', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const originalState = '{"consecutiveFailures":4}\n';
  await writeFile(config.files.state, originalState);
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: true, forceScan: true });
  assert.equal(result.status, 'no-candidate');
  assert.equal(await readFile(config.files.state, 'utf8'), originalState);
});

test('a single real-link network failure participates in consecutive failure decisions', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.partialFailureCycles = 2;
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({
    dryRun: false,
    linkTelemetry: {
      enabled: true,
      https: { networkOk: false },
      websocket: { networkOk: true },
    },
  });
  assert.equal(result.status, 'transient');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.consecutivePartialFailures, 1);
  const evaluation = events.find((entry) => entry.event === 'current-node-evaluated');
  assert.deepEqual(evaluation.details.linkFailures, ['https']);
  assert.equal(evaluation.details.health, 'partial-failure');
});

test('disabled or missing real-link metrics do not downgrade a healthy node', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({
    dryRun: false,
    linkTelemetry: { enabled: true, https: {}, websocket: null },
  });
  assert.equal(result.status, 'healthy');
});

test('stable node synchronizes runtime selection and clears its stale quarantine', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  await writeFile(config.files.state, JSON.stringify({
    quarantinedNodes: {
      'good-node': { until: new Date(Date.now() + 600_000).toISOString(), reason: 'old-failure' },
      'other-node': { until: new Date(Date.now() + 600_000).toISOString(), reason: 'other-failure' },
    },
  }));
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'healthy');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentSelection, 'good-node');
  assert.equal(state.currentLeaf, 'good-node');
  assert.equal(state.quarantinedNodes['good-node'], undefined);
  assert.equal(state.quarantinedNodes['other-node'].reason, 'other-failure');
});

test('external selection is strictly admitted from real probes and ignores UI 5000 placeholder', async (t) => {
  const mock = await startMockController({
    initialSelected: 'good-node',
    targetHistoryDelay: 5000,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'good-node',
    currentLeaf: 'old-node',
  }));
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'external-selection-admitted');
  assert.equal(mock.probeCounts.get('good-node\u0000https://service.example/'), 2);
  assert.deepEqual(mock.switches, []);
  assert.equal(events.some((entry) => entry.event === 'external-selection-detected'
    && entry.details.expected === 'good-node'
    && entry.details.expectedLeaf === 'old-node'
    && entry.details.observedLeaf === 'good-node'), true);
  assert.equal(events.some((entry) => entry.event === 'external-selection-validation-completed'
    && entry.details.admitted === true
    && entry.details.maxMs === 120), true);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentSelection, 'good-node');
  assert.equal(state.externalSelectionPendingAdmission, undefined);
  assert.equal(state.lastExternalSelection.verified, true);
});

test('legacy selection state is revalidated once and replaced when candidate admission fails', async (t) => {
  const mock = await startMockController({
    initialSelected: 'legacy-node',
    candidates: ['legacy-node', 'good-node'],
    delayResolver: ({ name }) => name === 'legacy-node' ? 700 : 100,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'legacy-node',
    currentLeaf: 'legacy-node',
  }));
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.deepEqual(mock.switches, ['good-node']);
  assert.equal(events.some((entry) => entry.event === 'external-selection-detected'), false);
  assert.equal(events.some((entry) => entry.event === 'baseline-revalidation'
    && entry.details.admitted === false), true);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentSelection, 'good-node');
  assert.equal(state.selectionAdmissionVersion, 1);
  assert.equal(state.externalSelectionPendingAdmission, undefined);
  assert.equal(state.lastBaselineRevalidation.verified, false);
});

test('legacy selection state records the admission version after strict baseline acceptance', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'good-node',
    currentLeaf: 'good-node',
  }));
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'baseline-revalidated');
  assert.deepEqual(mock.switches, []);
  assert.equal(events.some((entry) => entry.event === 'baseline-revalidation'
    && entry.details.admitted === true), true);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.selectionAdmissionVersion, 1);
  assert.equal(state.externalSelectionPendingAdmission, undefined);
  assert.equal(state.lastBaselineRevalidation.verified, true);
});

test('unadmitted external selection immediately scans and every select still uses beforeSwitch', async (t) => {
  const mock = await startMockController({
    initialSelected: 'external-node',
    candidates: ['external-node', 'good-node'],
    delayResolver: ({ name }) => name === 'external-node' ? 700 : 100,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.latencyFailureCycles = 5;
  config.policy.minimumDwellSeconds = 600;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'old-node',
    currentLeaf: 'old-node',
    lastSwitchAt: new Date().toISOString(),
    candidateScanBackoffUntil: new Date(Date.now() + 600_000).toISOString(),
    lastCandidateScanOutcome: 'no-stable-candidate',
    degradationWindow: Array.from({ length: 3 }, () => ({ degraded: true })),
  }));
  let beforeSwitchCalls = 0;
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
    beforeSwitch: async () => { beforeSwitchCalls += 1; },
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'good-node');
  assert.deepEqual(mock.switches, ['good-node']);
  assert.equal(beforeSwitchCalls, 1);
  assert.equal(events.some((entry) => entry.event === 'external-selection-validation-completed'
    && entry.details.admitted === false), true);
  assert.equal(events.some((entry) => entry.event === 'current-node-evaluated'
    && entry.details.health === 'external-selection-rejected'), true);
  assert.equal(events.some((entry) => entry.event === 'node-switched'
    && entry.details.reason === 'external-selection-rejected'), true);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentSelection, 'good-node');
  assert.equal(state.externalSelectionPendingAdmission, undefined);
  assert.equal(state.lastSwitch.source, 'sentinel');
});

test('unadmitted external selection remains pending when no replacement is available', async (t) => {
  const mock = await startMockController({
    initialSelected: 'external-node',
    candidates: ['external-node'],
    delayResolver: () => 700,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'old-node',
    currentLeaf: 'old-node',
  }));
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const first = await watchdog.runOnce({ dryRun: false });
  const second = await watchdog.runOnce({ dryRun: false });
  assert.equal(first.status, 'no-candidate');
  assert.equal(second.status, 'scan-backoff');
  assert.deepEqual(mock.switches, []);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentSelection, 'old-node');
  assert.equal(state.externalSelectionPendingAdmission.to, 'external-node');
  assert.equal(state.lastExternalSelection.verified, false);
});

test('active degraded node is removed from quarantine before failure threshold returns', async (t) => {
  const mock = await startMockController({ initialSelected: 'degraded-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.latencyFailureCycles = 2;
  await writeFile(config.files.state, JSON.stringify({
    quarantinedNodes: {
      'degraded-node': { until: new Date(Date.now() + 600_000).toISOString(), reason: 'old-failure' },
      'other-node': { until: new Date(Date.now() + 600_000).toISOString(), reason: 'other-failure' },
    },
  }));
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'transient');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentSelection, 'degraded-node');
  assert.equal(state.quarantinedNodes['degraded-node'], undefined);
  assert.equal(state.quarantinedNodes['other-node'].reason, 'other-failure');
});

test('active partial-failure quarantine cleanup remains in-memory during dry run', async (t) => {
  const mock = await startMockController({
    initialSelected: 'partial-node',
    delayResolver: ({ targetUrl }) => targetUrl.endsWith('/fail') ? null : 100,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.probes.urls = ['https://service.example/ok', 'https://service.example/fail'];
  config.policy.emergencySuccessRate = 0.4;
  config.policy.partialFailureCycles = 2;
  const originalState = `${JSON.stringify({
    quarantinedNodes: {
      'partial-node': { until: new Date(Date.now() + 600_000).toISOString(), reason: 'old-failure' },
    },
  }, null, 2)}\n`;
  await writeFile(config.files.state, originalState);
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: true });
  assert.equal(result.status, 'transient');
  assert.equal(await readFile(config.files.state, 'utf8'), originalState);
});

test('emergency failure bypasses both failure threshold and minimum dwell', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.partialFailureCycles = 3;
  config.policy.latencyFailureCycles = 3;
  config.policy.minimumDwellSeconds = 600;
  await writeFile(config.files.state, JSON.stringify({
    consecutiveFailures: 0,
    lastSwitchAt: new Date().toISOString(),
    candidateScanBackoffUntil: new Date(Date.now() + 600_000).toISOString(),
    lastCandidateScanOutcome: 'no-stable-candidate',
  }));
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'good-node');
});

test('latency spike confirmation recovery does not switch immediately', async (t) => {
  const mock = await startMockController({
    initialSelected: 'spike-node',
    candidates: ['spike-node', 'good-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'spike-node') return probeCount === 1 ? 2600 : 100;
      return 100;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.latencyFailureCycles = 5;
  config.policy.minimumDwellSeconds = 600;
  config.policy.hardFailureConfirmSeconds = 0.001;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'spike-node',
    currentLeaf: 'spike-node',
    selectionAdmissionVersion: 1,
    lastSwitchAt: new Date().toISOString(),
  }));
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'transient-recovered');
  assert.equal(mock.getSelected(), 'spike-node');
  assert.deepEqual(mock.switches, []);
  assert.equal(events.some((entry) => entry.event === 'current-node-evaluated'
    && entry.details.health === 'latency-spike'
    && entry.details.quality === 'unacceptable'), true);
  assert.equal(events.some((entry) => entry.event === 'immediate-failure-confirmed'
    && entry.details.trigger === 'latency-spike'
    && entry.details.confirmed === false), true);
  assert.equal(events.some((entry) => entry.event === 'current-node-evaluated'
    && entry.details.selectionSource === 'immediate-confirmation'
    && entry.details.health === 'healthy'), true);
});

test('confirmed latency spike bypasses ordinary latency cycles and minimum dwell', async (t) => {
  const mock = await startMockController({
    initialSelected: 'spike-node',
    candidates: ['spike-node', 'good-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'spike-node') return probeCount <= 2 ? 2600 : 100;
      return 100;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.latencyFailureCycles = 5;
  config.policy.minimumDwellSeconds = 600;
  config.policy.hardFailureConfirmSeconds = 0.001;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'spike-node',
    currentLeaf: 'spike-node',
    selectionAdmissionVersion: 1,
    lastSwitchAt: new Date().toISOString(),
  }));
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'good-node');
  assert.deepEqual(mock.switches, ['good-node']);
  assert.equal(events.some((entry) => entry.event === 'immediate-failure-confirmed'
    && entry.details.trigger === 'latency-spike'
    && entry.details.confirmed === true), true);
});

test('ordinary latency degradation still respects minimum dwell', async (t) => {
  const mock = await startMockController({ initialSelected: 'degraded-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.minimumDwellSeconds = 600;
  await writeFile(config.files.state, JSON.stringify({
    consecutiveFailures: 0,
    lastSwitchAt: new Date().toISOString(),
  }));
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'minimum-dwell');
  assert.equal(mock.getSelected(), 'degraded-node');
  assert.deepEqual(mock.switches, []);
});

test('failed post-switch verification quarantines candidate and tries the next one', async (t) => {
  const mock = await startMockController({ flakyCandidate: true });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'good-node');
  assert.deepEqual(mock.switches, ['flaky-node', 'good-node']);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.quarantinedNodes['flaky-node'].reason, 'post-switch-verification-failed');
});

test('unsafe failed candidates are not reselected as fallback', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'fallback-a', 'fallback-b'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      return probeCount <= 3 ? (name === 'fallback-a' ? 100 : 150) : null;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 2;
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'degraded-fallback');
  assert.equal(mock.getSelected(), 'fallback-b');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.lastSwitch.to, 'fallback-b');
  assert.equal(state.lastSwitch.reason, 'degraded-fallback');
  assert.equal(state.lastSwitch.verified, false);
  assert.ok(Number.isFinite(Date.parse(state.lastSwitchAt)));
  assert.equal(state.quarantinedNodes['fallback-a'].reason, 'post-switch-verification-failed');
  assert.equal(state.quarantinedNodes['fallback-b'].reason, 'post-switch-verification-failed');
  assert.equal(state.quarantinedNodes['bad-node'].reason, 'hard-failure');
});

test('post-switch failure may retain only a candidate that still meets current health thresholds', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'provisional-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      return probeCount <= 3 ? 100 : 700;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 1;
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'provisional-fallback');
  assert.equal(mock.getSelected(), 'provisional-node');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.lastSwitch.reason, 'provisional-fallback');
  assert.equal(state.provisionalFallback.profile, 'current-threshold');
  assert.equal(state.selectionAdmissionVersion, undefined);
  assert.equal(state.quarantinedNodes['provisional-node'], undefined);
});

test('scan-level current-stable candidate is used when no strict candidate survives validation', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'provisional-node', 'slow-node'],
    delayResolver: ({ name }) => {
      if (name === 'bad-node') return null;
      if (name === 'provisional-node') return 700;
      return 1600;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 1;
  const events = [];
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'provisional-fallback');
  assert.equal(mock.getSelected(), 'provisional-node');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.deepEqual(state.lastCandidateScan.stable, []);
  assert.deepEqual(state.lastCandidateScan.provisional, ['provisional-node']);
  assert.equal(state.provisionalFallback.selection, 'provisional-node');
  assert.equal(events.some((entry) => entry.event === 'provisional-candidates-selected'), true);
});

test('scan-level provisional is attempted after every strict candidate fails post-switch verification', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'strict-then-fails', 'provisional-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      if (name === 'strict-then-fails') return probeCount <= 3 ? 400 : null;
      return 700;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 2;
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'provisional-fallback');
  assert.deepEqual(mock.switches, ['strict-then-fails', 'provisional-node']);
  assert.equal(mock.getSelected(), 'provisional-node');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.deepEqual(state.lastCandidateScan.stable, ['strict-then-fails']);
  assert.deepEqual(state.lastCandidateScan.provisional, ['provisional-node']);
  assert.equal(state.provisionalFallback.selection, 'provisional-node');
});

test('a provisional candidate does not prevent a later strict candidate from succeeding', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'provisional-node', 'strict-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      if (name === 'provisional-node') return probeCount <= 3 ? 100 : 700;
      return 400;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 2;
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'strict-node');
  assert.deepEqual(mock.switches, ['provisional-node', 'strict-node']);
});

test('best current-stable provisional is restored without consuming switch budget', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'provisional-a', 'provisional-b'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      if (name === 'provisional-a') return probeCount <= 3 ? 100 : 700;
      return probeCount <= 3 ? 150 : 800;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 2;
  config.policy.switchBudgetCount = 2;
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'provisional-fallback');
  assert.equal(mock.getSelected(), 'provisional-a');
  assert.deepEqual(mock.switches, ['provisional-a', 'provisional-b', 'provisional-a']);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.switchHistory.at(-1).kind, 'provisional-recovery');
  assert.equal(state.switchHistory.at(-1).budgetExempt, true);
});

test('an unverified degraded selection gets one audited recovery attempt despite exhausted budget', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.switchBudgetCount = 1;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'bad-node',
    currentLeaf: 'bad-node',
    provisionalFallback: { profile: 'unverified', selection: 'bad-node' },
    switchHistory: [{
      timestamp: new Date().toISOString(),
      from: 'old-node',
      to: 'bad-node',
      kind: 'candidate-attempt',
    }],
  }));
  const events = [];
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'switched');
  assert.equal(mock.getSelected(), 'good-node');
  assert.equal(events.some((entry) => entry.event === 'degraded-recovery-budget-exempted'), true);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.switchHistory.some((entry) => entry.kind === 'degraded-recovery'
    && entry.budgetExempt === true), true);
});

test('rolling intermittent latency degradation triggers optimization after healthy recovery', async (t) => {
  const mock = await startMockController({
    initialSelected: 'acceptable-node',
    candidates: ['acceptable-node', 'good-node'],
    delayResolver: ({ name }) => name === 'acceptable-node' ? 700 : 100,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.optimizationIntervalSeconds = 0;
  config.policy.degradationWindowCycles = 10;
  config.policy.degradationWindowFailures = 3;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'acceptable-node',
    currentLeaf: 'acceptable-node',
    selectionAdmissionVersion: 1,
    degradationWindow: [
      { degraded: true, status: 'latency-degraded' },
      { degraded: false, status: 'healthy' },
      { degraded: true, status: 'latency-spike' },
      { degraded: true, status: 'latency-degraded' },
    ],
  }));
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: true });

  assert.equal(result.status, 'would-switch');
  assert.equal(result.candidate.node, 'good-node');
});

test('rolling degradation triggers on the cycle that reaches its threshold', async (t) => {
  const mock = await startMockController({
    initialSelected: 'degraded-node',
    candidates: ['degraded-node', 'good-node'],
    delayResolver: ({ name }) => name === 'degraded-node' ? 900 : 100,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.latencyFailureCycles = 9;
  config.policy.optimizationIntervalSeconds = 0;
  config.policy.degradationWindowCycles = 10;
  config.policy.degradationWindowFailures = 3;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'degraded-node',
    currentLeaf: 'degraded-node',
    selectionAdmissionVersion: 1,
    degradationWindow: [
      { degraded: true, status: 'latency-degraded' },
      { degraded: false, status: 'healthy' },
      { degraded: true, status: 'latency-degraded' },
      { degraded: false, status: 'healthy' },
    ],
  }));
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: true });

  assert.equal(result.status, 'would-switch');
  assert.equal(result.candidate.node, 'good-node');
});

test('strict admission of a changed node clears degradation history before policy evaluation', async (t) => {
  const mock = await startMockController({
    initialSelected: 'good-node',
    candidates: ['good-node', 'slow-node'],
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.optimizationIntervalSeconds = 0;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'old-node',
    currentLeaf: 'old-node',
    selectionAdmissionVersion: 1,
    degradationWindow: Array.from({ length: 3 }, () => ({ degraded: true })),
  }));
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'external-selection-admitted');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.deepEqual(state.degradationWindow, [{
    at: state.degradationWindow[0].at,
    degraded: false,
    status: 'healthy',
  }]);
});

test('strict baseline recovery upgrades provisional switch audit state', async (t) => {
  const mock = await startMockController({ initialSelected: 'good-node' });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.optimizationIntervalSeconds = 0;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'good-node',
    currentLeaf: 'good-node',
    lastSwitchAt: '2026-10-24T00:00:00.000Z',
    lastSwitch: {
      from: 'bad-node',
      to: 'good-node',
      reason: 'degraded-fallback',
      verified: false,
      source: 'sentinel',
    },
    provisionalFallback: { profile: 'unverified', selection: 'good-node' },
  }));
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'baseline-revalidated');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.lastSwitch.reason, 'strict-admission-recovered');
  assert.equal(state.lastSwitch.provisionalReason, 'degraded-fallback');
  assert.equal(state.lastSwitch.verified, true);
  assert.ok(Number.isFinite(Date.parse(state.lastSwitch.strictlyAdmittedAt)));
});

test('periodic optimization keeps an acceptable node when improvement is insufficient', async (t) => {
  const mock = await startMockController({
    initialSelected: 'acceptable-node',
    candidates: ['acceptable-node', 'slightly-better-node'],
    delayResolver: ({ name }) => name === 'acceptable-node' ? 700 : 580,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.optimizationIntervalSeconds = 1;
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: 'acceptable-node',
    currentLeaf: 'acceptable-node',
    selectionAdmissionVersion: 1,
    lastOptimizationScanAt: new Date(0).toISOString(),
  }));
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: true });

  assert.equal(result.status, 'no-improvement');
  assert.deepEqual(mock.switches, []);
});

test('adaptive validation continues past a noisy first batch', async (t) => {
  const noisy = ['noisy-1', 'noisy-2', 'noisy-3'];
  const mock = await startMockController({
    candidates: ['bad-node', ...noisy, 'stable-later'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      if (noisy.includes(name)) return probeCount === 1 ? 50 : null;
      return 100;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.probes.topCandidates = 3;
  config.probes.maxValidationCandidates = 6;
  config.policy.maxSwitchAttempts = 3;
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });

  const result = await watchdog.runOnce({ dryRun: true, forceScan: true });

  assert.equal(result.status, 'would-switch');
  assert.equal(result.candidate.node, 'stable-later');
});

test('unhealthy recovery validates the ranked pool concurrently within one deadline', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'strict-a', 'strict-b', 'strict-c', 'strict-d', 'strict-e', 'strict-f'],
    delayResolver: ({ name }) => name === 'bad-node' ? null : 100,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.probes.topCandidates = 3;
  config.probes.maxValidationCandidates = 6;
  config.policy.maxSwitchAttempts = 3;
  const events = [];
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: true });

  assert.equal(result.status, 'would-switch');
  const validation = events.find((entry) => entry.event === 'candidate-validation-completed');
  assert.equal(validation.details.validatedCount, 6);
  assert.equal(validation.details.stable.length, 6);
});

test('post-switch verification probes the resolved leaf of a nested selector', async () => {
  let selected = 'bad-node';
  const probed = [];
  const controller = {
    async getProxy(name) {
      if (name === 'XFLTD') return { type: 'Selector', now: selected };
      if (name === 'candidates') return { type: 'URLTest', all: ['bad-node', 'nested-good'] };
      if (name === 'nested-good') return { type: 'Selector', now: 'leaf-good' };
      return { type: 'VLESS', name };
    },
    async getDelay(node) {
      probed.push(node);
      if (node === 'bad-node') throw Object.assign(new Error('timeout'), { status: 504 });
      if (node === 'nested-good' && probed.filter((value) => value === node).length > 3) {
        throw Object.assign(new Error('group delay unavailable'), { status: 504 });
      }
      return 100;
    },
    async select(group, node) {
      assert.equal(group, 'XFLTD');
      selected = node;
    },
  };
  const config = await makeConfig('http://127.0.0.1:1');
  config.policy.postSwitchRounds = 2;
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'switched');
  assert.equal(selected, 'nested-good');
  assert.ok(probed.filter((node) => node === 'leaf-good').length >= 2);
});

test('rollback verifies the actual leaf after a dynamic selector is restored', async () => {
  let selected = 'previous-group';
  let rollbackSelected = false;
  const counts = new Map();
  const events = [];
  const controller = {
    async getProxy(name) {
      if (name === 'XFLTD') return { type: 'Selector', now: selected };
      if (name === 'candidates') return { type: 'URLTest', all: ['candidate-a'] };
      if (name === 'previous-group') {
        return { type: 'Selector', now: rollbackSelected ? 'leaf-new' : 'leaf-old' };
      }
      return { type: 'VLESS', name };
    },
    async getDelay(node) {
      const count = (counts.get(node) ?? 0) + 1;
      counts.set(node, count);
      if (node === 'leaf-old') {
        if (count === 1) throw Object.assign(new Error('timeout'), { status: 504 });
        return 100;
      }
      if (node === 'candidate-a') {
        if (count <= 3) return 100;
        throw Object.assign(new Error('post-switch failed'), { status: 504 });
      }
      if (node === 'leaf-new') throw Object.assign(new Error('changed leaf failed'), { status: 504 });
      return 100;
    },
    async select(group, node) {
      assert.equal(group, 'XFLTD');
      selected = node;
      if (node === 'previous-group') rollbackSelected = true;
    },
  };
  const config = await makeConfig('http://127.0.0.1:1');
  config.policy.maxSwitchAttempts = 1;
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });

  assert.equal(result.status, 'degraded-fallback');
  assert.equal(selected, 'previous-group');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.currentLeaf, 'leaf-new');
  assert.equal(events.some((entry) => entry.event === 'switch-recovery-rollback-failed'
    && entry.details.leaf === 'leaf-new'), true);
});

test('each candidate selection consumes budget and degraded fallback cannot exceed it', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'candidate-a', 'candidate-b', 'candidate-c'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      const initialDelay = { 'candidate-a': 100, 'candidate-b': 150, 'candidate-c': 200 }[name];
      return probeCount <= 3 ? initialDelay : null;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.rollbackOnFailure = false;
  config.policy.maxSwitchAttempts = 3;
  config.policy.switchBudgetCount = 2;
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'degraded-fallback');
  assert.deepEqual(mock.switches, ['candidate-a', 'candidate-b']);
  assert.equal(mock.getSelected(), 'candidate-b');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.switchHistory.length, 2);
  assert.deepEqual(state.switchHistory.map((entry) => entry.kind), [
    'candidate-attempt',
    'candidate-attempt',
  ]);
  assert.equal(state.lastSwitch.to, 'candidate-b');
  assert.equal(state.quarantinedNodes['candidate-b'].reason, 'post-switch-verification-failed');
  assert.equal(state.quarantinedNodes['candidate-a'].reason, 'post-switch-verification-failed');
  assert.equal(state.quarantinedNodes['candidate-c'], undefined);
  assert.equal(events.some((entry) => entry.event === 'switch-budget-exhausted'
    && entry.details.blockedCandidate === 'candidate-c'), true);
  assert.equal(events.some((entry) => entry.event === 'fallback-selection-budget-exhausted'), false);
});

test('recovery rollback is audited but exempt from the candidate switch budget', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'candidate-a'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return probeCount === 1 ? null : 100;
      return probeCount <= 3 ? 100 : null;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.maxSwitchAttempts = 1;
  config.policy.switchBudgetCount = 1;
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details) => events.push({ level, event, details }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'rollback-recovered');
  assert.deepEqual(mock.switches, ['candidate-a', 'bad-node']);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.deepEqual(state.switchHistory.map((entry) => entry.kind), [
    'candidate-attempt',
    'recovery-rollback',
  ]);
  assert.equal(state.lastSwitch.reason, 'rollback-recovered');
  assert.equal(events.some((entry) => entry.event === 'switch-recovery-rollback'
    && entry.details.budgetExempt === true), true);
});

test('candidate scan backoff suppresses repeated full scans after no candidate', async (t) => {
  const mock = await startMockController({
    initialSelected: 'degraded-node',
    candidates: ['degraded-node', 'slow-node'],
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.candidateScanBackoffSeconds = 120;
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event) => events.push({ level, event }),
  });

  const first = await watchdog.runOnce({ dryRun: false });
  const second = await watchdog.runOnce({ dryRun: false });
  assert.equal(first.status, 'no-candidate');
  assert.equal(second.status, 'scan-backoff');
  assert.equal(events.filter((entry) => entry.event === 'candidate-scan-started').length, 1);
  assert.equal(events.some((entry) => entry.event === 'no-stable-candidate'), true);
  assert.deepEqual(mock.switches, []);
});

test('switch budget blocks even hard-failure recovery before scanning', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.switchBudgetCount = 3;
  config.policy.switchBudgetWindowSeconds = 600;
  const now = new Date().toISOString();
  await writeFile(config.files.state, JSON.stringify({ switchHistory: [now, now, now] }));
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event) => events.push({ level, event }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switch-budget-exhausted');
  assert.deepEqual(mock.switches, []);
  assert.equal(events.some((entry) => entry.event === 'candidate-scan-started'), false);
  assert.equal(events.some((entry) => entry.event === 'switch-budget-exhausted'), true);
});

test('switch budget counts legacy strings but excludes structured recovery rollbacks', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.policy.switchBudgetCount = 2;
  config.policy.switchBudgetWindowSeconds = 600;
  const now = new Date().toISOString();
  await writeFile(config.files.state, JSON.stringify({
    switchHistory: [
      now,
      { timestamp: now, from: 'candidate-a', to: 'old-node', kind: 'recovery-rollback' },
    ],
  }));
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const result = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'switched');
  assert.deepEqual(mock.switches, ['good-node']);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.switchHistory.length, 3);
  assert.equal(state.switchHistory[2].kind, 'candidate-attempt');
});

test('reachable control URL prevents switching and backs off during a shared upstream outage', async (t) => {
  const controlUrl = 'https://control.example/generate_204';
  const mock = await startMockController({
    candidates: ['bad-node', 'candidate-a', 'candidate-b', 'candidate-c'],
    delayResolver: ({ targetUrl }) => targetUrl === controlUrl ? 50 : null,
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  config.probes.controlUrls = [controlUrl];
  config.policy.upstreamFailureMinCandidates = 3;
  const events = [];
  const controller = new MihomoController(config.controller, {});
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event) => events.push({ level, event }),
  });

  const result = await watchdog.runOnce({ dryRun: false });
  const nextResult = await watchdog.runOnce({ dryRun: false });
  assert.equal(result.status, 'upstream-outage');
  assert.equal(nextResult.status, 'scan-backoff');
  assert.deepEqual(mock.switches, []);
  assert.equal(events.some((entry) => entry.event === 'upstream-outage-detected'), true);
  assert.equal(events.filter((entry) => entry.event === 'candidate-scan-started').length, 1);
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.lastCandidateScanOutcome, 'upstream-outage');
});

test('candidate scan has a hard deadline even when every probe hangs', async () => {
  const config = await makeConfig('http://127.0.0.1:1');
  config.probes.discoveryTimeoutMs = 100;
  config.probes.scanDeadlineMs = 500;
  const never = () => new Promise(() => {});
  const controller = {
    async getProxy(name) {
      if (name === 'candidates') return { type: 'URLTest', all: ['node-a', 'node-b'] };
      return { type: 'VLESS', name };
    },
    getGroupDelays: never,
    getDelay: never,
  };
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });

  const startedAt = performance.now();
  const result = await watchdog.findCandidates('bad-node');
  const elapsedMs = performance.now() - startedAt;

  assert.ok(elapsedMs < 750, `扫描耗时 ${Math.round(elapsedMs)} ms`);
  assert.equal(result.deadlineReached, true);
  assert.deepEqual(result.stable, []);
});

test('background candidate scan does not block repeated current health checks', async (t) => {
  const mock = await startMockController();
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  let finishScan;
  const deferredScan = new Promise((resolve) => { finishScan = resolve; });
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async () => {},
  });
  watchdog.findCandidates = async () => deferredScan;

  const first = await watchdog.runOnce({ dryRun: true, backgroundScan: true });
  const second = await watchdog.runOnce({ dryRun: true, backgroundScan: true });
  assert.equal(first.status, 'candidate-scan-started');
  assert.equal(second.status, 'candidate-scan-in-progress');
  assert.ok((mock.probeCounts.get(`bad-node\u0000${config.probes.urls[0]}`) ?? 0) >= 2);

  finishScan({
    stable: [], provisional: [], sampled: [], validated: [], rejected: [],
    durationMs: 10, deadlineMs: 3000, deadlineReached: false,
  });
  await first.backgroundWake;
  const third = await watchdog.runOnce({ dryRun: true, backgroundScan: true });
  assert.equal(third.status, 'no-candidate');
});

test('background mode rejects a stale fast candidate before changing routes', async (t) => {
  const mock = await startMockController({
    candidates: ['bad-node', 'good-node'],
    delayResolver: ({ name, probeCount }) => {
      if (name === 'bad-node') return null;
      return probeCount >= 4 ? null : 100;
    },
  });
  t.after(() => mock.server.close());
  const config = await makeConfig(mock.url);
  const events = [];
  const watchdog = new Watchdog({
    controller: new MihomoController(config.controller, {}),
    config,
    logger: async (level, event) => events.push({ level, event }),
  });

  const started = await watchdog.runOnce({ dryRun: false, backgroundScan: true });
  await started.backgroundWake;
  const decided = await watchdog.runOnce({ dryRun: false, backgroundScan: true });

  assert.equal(decided.status, 'no-pre-switch-candidate');
  assert.deepEqual(mock.switches, []);
  assert.equal(events.some((entry) => entry.event === 'candidate-pre-switch-rejected'), true);
});
