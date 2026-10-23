import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildStatusSnapshot,
  createRotatingLogger,
  formatStatus,
  readRecentNdjson,
} from '../src/observability.mjs';

test('rotating logger retains valid NDJSON and redacts credentials', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-log-'));
  const logFile = path.join(root, 'watchdog.ndjson');
  const logger = createRotatingLogger(logFile, { quiet: true, maxBytes: 260, retainedFiles: 2 });
  for (let index = 0; index < 12; index += 1) {
    await logger('info', 'sample', {
      index,
      authorization: 'Bearer must-not-leak',
      message: 'Authorization: Bearer also-must-not-leak',
    });
  }

  const files = [logFile, `${logFile}.1`, `${logFile}.2`];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(content, /must-not-leak/);
    for (const line of content.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  await assert.rejects(readFile(`${logFile}.3`, 'utf8'), /ENOENT/);
});

test('status snapshot uses live selection and recent probe without failing on optional fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-status-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({
    consecutiveFailures: 2,
    consecutiveLatencyFailures: 2,
    lastSwitchAt: '2026-10-23T10:00:00.000Z',
    lastSwitch: { from: 'old', to: 'new', reason: 'latency-degraded' },
    quarantinedNodes: { bad: { until: '2999-01-01T00:00:00.000Z', reason: 'failed' } },
  }));
  await writeFile(logFile, [
    {
      timestamp: '2026-10-23T10:01:00.000Z',
      event: 'current-node-evaluated',
      selected: 'logged',
      leaf: 'logged-leaf',
      successRate: 1,
      averageMs: 420,
      maxMs: 700,
      health: 'healthy',
      quality: 'excellent',
    },
    {
      timestamp: '2026-10-23T10:00:59.000Z',
      event: 'link-telemetry',
      metrics: {
        enabled: true,
        https: { networkOk: true, statusCode: 204, connectMs: 1, tlsMs: 2, ttfbMs: 3 },
        websocket: { networkOk: true, websocketOk: false, statusCode: 401, connectMs: 1, tlsMs: 2, ttfbMs: 3 },
      },
    },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: 'live' };
      return { type: 'VLESS', name };
    },
  };

  const snapshot = await buildStatusSnapshot({ stateFile, logFile, controller, targetGroup: 'target' });
  assert.deepEqual(snapshot.current, { selected: 'live', leaf: 'live', source: 'controller' });
  assert.equal(snapshot.probe.averageMs, 420);
  assert.equal(snapshot.consecutiveFailures.latency, 2);
  assert.equal(snapshot.quarantinedNodes[0].node, 'bad');
  const formatted = formatStatus(snapshot);
  assert.match(formatted, /当前叶子节点\s+: live/);
  assert.match(formatted, /WebSocket 链路.*HTTP 401/);
});

test('missing or damaged status files are handled gracefully', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-broken-status-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'missing.ndjson');
  await writeFile(stateFile, '{invalid');
  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(snapshot.current.selected, null);
  assert.ok(snapshot.warnings.some((message) => message.includes('损坏')));
  assert.ok(snapshot.warnings.some((message) => message.includes('日志文件不存在')));
  assert.deepEqual((await readRecentNdjson(logFile)).records, []);
});

test('status switch budget supports legacy strings and excludes recovery rollbacks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-budget-status-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  const oldest = new Date(Date.now() - 100_000).toISOString();
  const rollback = new Date(Date.now() - 50_000).toISOString();
  const newest = new Date(Date.now() - 10_000).toISOString();
  await writeFile(stateFile, JSON.stringify({
    switchHistory: [
      oldest,
      { timestamp: rollback, from: 'b', to: 'a', kind: 'recovery-rollback' },
      { timestamp: newest, from: 'a', to: 'c', kind: 'failover' },
    ],
  }));
  await writeFile(logFile, '');

  const snapshot = await buildStatusSnapshot({
    stateFile,
    logFile,
    policy: { switchBudgetCount: 2, switchBudgetWindowSeconds: 600 },
  });
  assert.equal(snapshot.switchBudget.used, 2);
  assert.equal(snapshot.switchBudget.limit, 2);
  assert.equal(
    snapshot.switchBudget.blockedUntil,
    new Date(Date.parse(oldest) + 600_000).toISOString(),
  );
});

test('historical last switch does not cause a warning when synchronized current state matches', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-status-consistent-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({
    currentSelection: 'live',
    currentLeaf: 'live-leaf',
    lastSwitch: { from: 'old-a', to: 'old-b', reason: 'hard-failure' },
  }));
  await writeFile(logFile, '');
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: 'live' };
      if (name === 'live') return { type: 'Selector', now: 'live-leaf' };
      return { type: 'VLESS', name };
    },
  };

  const snapshot = await buildStatusSnapshot({ stateFile, logFile, controller, targetGroup: 'target' });
  assert.equal(snapshot.warnings.some((message) => message.includes('状态不一致')), false);
});

test('synchronized current state mismatch produces a precise warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-status-mismatch-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({
    currentSelection: 'stale-selection',
    currentLeaf: 'stale-leaf',
  }));
  await writeFile(logFile, '');
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { type: 'Selector', now: 'live' };
      return { type: 'VLESS', name };
    },
  };

  const snapshot = await buildStatusSnapshot({ stateFile, logFile, controller, targetGroup: 'target' });
  assert.ok(snapshot.warnings.some((message) => message.includes('守护程序同步状态不一致')));
});

test('status pairs telemetry at or before the latest evaluation across cycle interleaving', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-status-interleaved-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, '{}');
  const oldTelemetry = {
    timestamp: '2026-10-23T10:00:00.000Z',
    event: 'link-telemetry',
    metrics: { enabled: true, https: { networkOk: true, statusCode: 204, ttfbMs: 100 } },
  };
  const oldEvaluation = {
    timestamp: '2026-10-23T10:00:01.000Z',
    event: 'current-node-evaluated',
    selected: 'node-a',
    leaf: 'node-a',
    successRate: 1,
    averageMs: 500,
    maxMs: 600,
    health: 'healthy',
    quality: 'excellent',
  };
  const newTelemetry = {
    timestamp: '2026-10-23T10:00:02.000Z',
    event: 'link-telemetry',
    metrics: { enabled: true, https: { networkOk: true, statusCode: 403, ttfbMs: 900 } },
  };
  await writeFile(
    logFile,
    `${[oldTelemetry, oldEvaluation, newTelemetry].map((record) => JSON.stringify(record)).join('\n')}\n`,
  );

  const interleaved = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(interleaved.probe.at, oldEvaluation.timestamp);
  assert.equal(interleaved.telemetry.at, oldTelemetry.timestamp);
  assert.equal(interleaved.telemetry.https.statusCode, 204);

  const newEvaluation = {
    ...oldEvaluation,
    timestamp: '2026-10-23T10:00:03.000Z',
    averageMs: 700,
  };
  await writeFile(
    logFile,
    `${[oldTelemetry, oldEvaluation, newTelemetry, newEvaluation].map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  const complete = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(complete.probe.at, newEvaluation.timestamp);
  assert.equal(complete.telemetry.at, newTelemetry.timestamp);
  assert.equal(complete.telemetry.https.statusCode, 403);
});

test('status hides expired scan backoff and keeps a future backoff active', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-status-backoff-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(logFile, '');
  await writeFile(stateFile, JSON.stringify({
    candidateScanBackoffUntil: new Date(Date.now() - 60_000).toISOString(),
    lastCandidateScanOutcome: 'no-stable-candidate',
  }));

  const expired = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(expired.scanBackoff.until, null);
  assert.equal(expired.scanBackoff.reason, 'no-stable-candidate');
  assert.match(formatStatus(expired), /扫描退避\s+: 未启用/);

  const futureUntil = new Date(Date.now() + 60_000).toISOString();
  await writeFile(stateFile, JSON.stringify({
    candidateScanBackoffUntil: futureUntil,
    lastCandidateScanOutcome: 'upstream-outage',
  }));
  const active = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(active.scanBackoff.until, futureUntil);
  assert.equal(active.scanBackoff.reason, 'upstream-outage');
  assert.match(formatStatus(active), new RegExp(`扫描退避\\s+: 至 ${futureUntil}`));
});
