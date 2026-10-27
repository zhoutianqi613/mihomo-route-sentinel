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

test('pending external admission is explicit in snapshot and formatted status', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'watchdog-status-external-admission-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({
    currentSelection: 'old-node',
    currentLeaf: 'old-node',
    externalSelectionPendingAdmission: {
      from: 'old-node',
      fromLeaf: 'old-node',
      to: 'manual-node',
      leaf: 'manual-leaf',
      detectedAt: '2026-10-23T10:00:00.000Z',
    },
  }));
  await writeFile(logFile, '');

  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(snapshot.externalSelectionAdmission.to, 'manual-node');
  assert.equal(snapshot.externalSelectionAdmission.leaf, 'manual-leaf');
  assert.ok(snapshot.warnings.includes('外部节点等待严格准入；健康结果独立展示'));
  assert.match(
    formatStatus(snapshot),
    /外部节点准入\s+: 外部节点等待严格准入：manual-node/,
  );
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

test('status exposes the latest guardrail result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-status-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, '{}');
  await writeFile(logFile, `${JSON.stringify({
    timestamp: '2026-10-23T10:00:00.000Z',
    event: 'guardrail-evaluated',
    status: 'repaired',
    ready: true,
    issues: ['runtime-mode'],
    repairs: ['runtime-mode'],
  })}\n`);

  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(snapshot.guardrails.status, 'repaired');
  assert.deepEqual(snapshot.guardrails.repairs, ['runtime-mode']);
  assert.match(formatStatus(snapshot), /配置守卫\s+: repaired，问题 1，修复 1/);
});

test('blocked guardrail produces an explicit fail-closed warning', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-blocked-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, '{}');
  await writeFile(logFile, `${JSON.stringify({
    timestamp: '2026-10-23T10:00:00.000Z',
    event: 'guardrail-evaluated',
    status: 'blocked',
    ready: false,
    issues: ['dns-override', 'clash-verge-reload-failed'],
    repairs: ['dns-override-persisted'],
  })}\n`);

  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.ok(snapshot.warnings.some((message) => (
    message.includes('配置守卫未就绪') && message.includes('clash-verge-reload-failed')
  )));
  assert.match(formatStatus(snapshot), /链路探测与节点切换已暂停/);
});

test('status exposes runtime mode guard failures and switch blocking', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-runtime-guard-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, '{}');
  await writeFile(logFile, `${JSON.stringify({
    timestamp: '2026-10-23T10:00:00.000Z',
    event: 'runtime-mode-guard-evaluated',
    status: 'blocked',
    ready: false,
    issues: ['controller-unreachable'],
    repairs: [],
  })}\n`);

  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(snapshot.runtimeModeGuard.status, 'blocked');
  assert.ok(snapshot.warnings.some((message) => message.includes('任何节点切换均被禁止')));
  assert.match(formatStatus(snapshot), /运行模式守卫\s+: blocked/);
});

test('status exposes Clash Verge process guard failures and recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-process-guard-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, '{}');
  await writeFile(logFile, `${JSON.stringify({
    timestamp: '2026-10-23T10:00:00.000Z',
    event: 'clash-verge-process-guard-evaluated',
    status: 'blocked',
    ready: false,
    issues: ['clash-verge-not-running', 'clash-verge-start-backoff'],
    repairs: [],
  })}\n`);

  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(snapshot.processGuard.status, 'blocked');
  assert.ok(snapshot.warnings.some((message) => message.includes('客户端进程守卫未就绪')));
  assert.match(formatStatus(snapshot), /客户端进程守卫\s+: blocked/);
});

test('status warns about provisional fallback and explains rejected candidates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-provisional-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({
    provisionalFallback: {
      selection: 'temporary-node',
      profile: 'current-threshold',
    },
    lastCandidateScan: {
      at: '2026-10-24T00:00:00.000Z',
      reason: 'periodic-optimization',
      sampledCount: 50,
      validatedCount: 6,
      stable: ['good-node'],
      rejected: [{ node: 'fast-but-flaky', reasons: ['success-rate'] }],
      probeStats: {
        discovery: {
          method: 'group-delay', controllerRequests: 2, logicalAttempts: 100,
        },
        validation: {
          method: 'per-node', controllerRequests: 24, logicalAttempts: 24, peakConcurrency: 8,
        },
      },
    },
  }));
  await writeFile(logFile, '');

  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  const output = formatStatus(snapshot);

  assert.ok(snapshot.warnings.some((message) => message.includes('尚未通过严格准入')));
  assert.match(output, /合格 good-node/);
  assert.match(output, /fast-but-flaky\[success-rate\]/);
  assert.match(output, /候选探测负载\s+: 初筛 group-delay：Controller 2，节点测试 100；严格复测 per-node：Controller 24\/24，峰值并发 8/);
});

test('status exposes candidate snapshot freshness and emergency switch duration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-snapshot-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  const now = new Date().toISOString();
  await writeFile(stateFile, JSON.stringify({
    candidateSnapshot: {
      at: now,
      selection: 'current-node',
      leaf: 'current-node',
      candidates: [{ node: 'fallback-node', successRate: 0.75 }],
    },
    lastSwitchAt: now,
    lastSwitch: {
      from: 'current-node',
      to: 'fallback-node',
      reason: 'emergency-best-effort',
      verified: false,
      decisionDurationMs: 420,
    },
  }));
  await writeFile(logFile, '');

  const snapshot = await buildStatusSnapshot({
    stateFile,
    logFile,
    policy: { candidateSnapshotMaxAgeSeconds: 60 },
  });
  const output = formatStatus(snapshot);

  assert.equal(snapshot.candidateSnapshot.fresh, true);
  assert.equal(snapshot.candidateSnapshot.candidateCount, 1);
  assert.equal(snapshot.lastSwitch.decisionDurationMs, 420);
  assert.match(output, /候选快照\s+: 新鲜/);
  assert.match(output, /emergency-best-effort/);
});

test('当前健康与待准入独立展示，较新状态证据优先于历史拒绝日志', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-four-state-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({
    currentSelection: 'node', currentLeaf: 'node', selectionAdmissionVersion: 1,
    externalSelectionPendingAdmission: { to: 'node', leaf: 'node', source: 'baseline' },
    lastEvaluation: { timestamp: '2026-10-26T10:00:01.000Z', selected: 'node', leaf: 'node',
      successRate: 1, averageMs: 611, maxMs: 750, health: 'baseline-revalidation-rejected' },
    lastDecision: { action: 'hold', reason: 'strict-admission-pending' },
    switchHistory: [{ timestamp: new Date().toISOString(), budgetClass: 'optimization' }],
  }));
  await writeFile(logFile, `${JSON.stringify({
    event: 'current-node-evaluated', timestamp: '2026-10-26T10:00:00.000Z',
    selected: 'node', leaf: 'node', successRate: 0, averageMs: null, maxMs: null, health: 'hard-failure',
  })}\n`);
  const before = await readFile(stateFile, 'utf8');
  const snapshot = await buildStatusSnapshot({ stateFile, logFile,
    policy: { switchBudgetCount: 1, switchBudgetWindowSeconds: 600 } });
  assert.equal(snapshot.probe.averageMs, 611);
  assert.equal(snapshot.probe.health, 'healthy');
  assert.equal(snapshot.decisionState.admission.profile, 'pending');
  assert.equal(snapshot.decisionState.action.type, 'hold');
  assert.equal(snapshot.decisionState.budget.optimization.used, 1);
  assert.equal(snapshot.decisionState.budget.recovery.used, 0);
  assert.equal(snapshot.decisionState.budget.rescue.used, 0);
  const output = formatStatus(snapshot);
  assert.match(output, /健康\/质量\s+: healthy \/ acceptable/);
  assert.match(output, /当前准入\s+: 等待严格准入（pending），verified=false/);
  assert.match(output, /优化预算\s+: 1\/1/);
  assert.match(output, /恢复预算\s+: 0\/1/);
  assert.match(output, /救援预算\s+: 0\/1/);
  assert.equal(await readFile(stateFile, 'utf8'), before);
});

test('实时Controller出口变化时历史成功样本不能显示当前健康', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-four-state-mismatch-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({ currentSelection: 'old', currentLeaf: 'old',
    selectionAdmission: { selection: 'old', leaf: 'old', profile: 'strict', verified: true },
    lastEvaluation: { timestamp: '2026-10-26T10:00:00.000Z', selected: 'old', leaf: 'old',
      successRate: 1, averageMs: 400, maxMs: 500, health: 'healthy' },
  }));
  await writeFile(logFile, '');
  const controller = { async getProxy(name) {
    return name === 'target' ? { now: 'live' } : { type: 'VLESS', name };
  } };
  const snapshot = await buildStatusSnapshot({ stateFile, logFile, controller, targetGroup: 'target' });
  assert.equal(snapshot.current.selected, 'live');
  assert.equal(snapshot.probe.health, 'unknown');
  assert.equal(snapshot.probe.matchesCurrent, false);
  assert.equal(snapshot.decisionState.admission.profile, 'pending');
  const output = formatStatus(snapshot);
  assert.match(output, /探测身份\s+: old \/ old（不能证明当前出口健康）/);
  assert.doesNotMatch(output, /健康\/质量\s+: healthy/);
});

test('rescue可同时当前健康，但状态明确未验证并等待下一周期', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-rescue-state-'));
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify({ currentSelection: 'node', currentLeaf: 'node',
    selectionAdmission: { selection: 'node', leaf: 'node', profile: 'rescue', verified: false },
    lastEvaluation: { selected: 'node', leaf: 'node', successRate: 1, averageMs: 500, maxMs: 700 },
  }));
  await writeFile(logFile, '');
  const snapshot = await buildStatusSnapshot({ stateFile, logFile });
  assert.equal(snapshot.probe.health, 'healthy');
  assert.equal(snapshot.decisionState.admission.profile, 'rescue');
  assert.match(formatStatus(snapshot), /当前准入\s+: 应急接管（rescue），未严格验证，下一周期复核，verified=false/);
});
