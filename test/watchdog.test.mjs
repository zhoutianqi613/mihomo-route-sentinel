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

test('unverified fallback records the retained node and removes its quarantine', async (t) => {
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
  assert.equal(result.status, 'unverified-fallback');
  assert.equal(mock.getSelected(), 'fallback-a');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.lastSwitch.to, 'fallback-a');
  assert.equal(state.lastSwitch.reason, 'unverified-fallback');
  assert.equal(state.lastSwitch.verified, false);
  assert.ok(Number.isFinite(Date.parse(state.lastSwitchAt)));
  assert.equal(state.quarantinedNodes['fallback-a'], undefined);
  assert.equal(state.quarantinedNodes['fallback-b'].reason, 'post-switch-verification-failed');
  assert.equal(state.quarantinedNodes['bad-node'].reason, 'hard-failure');
});

test('each candidate selection consumes budget and an unverified fallback cannot exceed it', async (t) => {
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
  assert.equal(result.status, 'unverified-fallback');
  assert.deepEqual(mock.switches, ['candidate-a', 'candidate-b']);
  assert.equal(mock.getSelected(), 'candidate-b');
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  assert.equal(state.switchHistory.length, 2);
  assert.deepEqual(state.switchHistory.map((entry) => entry.kind), [
    'candidate-attempt',
    'candidate-attempt',
  ]);
  assert.equal(state.lastSwitch.to, 'candidate-b');
  assert.equal(state.quarantinedNodes['candidate-b'], undefined);
  assert.equal(state.quarantinedNodes['candidate-a'].reason, 'post-switch-verification-failed');
  assert.equal(state.quarantinedNodes['candidate-c'], undefined);
  assert.equal(events.some((entry) => entry.event === 'switch-budget-exhausted'
    && entry.details.blockedCandidate === 'candidate-c'), true);
  assert.equal(events.some((entry) => entry.event === 'fallback-selection-budget-exhausted'
    && entry.details.retained === 'candidate-b'), true);
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
