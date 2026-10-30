import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { buildStatusSnapshot } from '../src/observability.mjs';
import { Watchdog } from '../src/watchdog.mjs';

const HTTPS_403 = Object.freeze({
  networkOk: true,
  outcome: 'authentication-rejected',
  statusCode: 403,
});
const WEBSOCKET_401 = Object.freeze({
  networkOk: true,
  outcome: 'authentication-rejected',
  statusCode: 401,
});

async function runScenario({ linkTelemetry } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-business-outcome-'));
  const config = structuredClone(defaults);
  config.groups.target = 'target';
  config.groups.candidates = 'candidates';
  config.files = {
    ...config.files,
    state: path.join(root, 'state.json'),
    log: path.join(root, 'watchdog.ndjson'),
    lock: path.join(root, 'watchdog.lock'),
    guardrailState: path.join(root, 'guardrails.json'),
  };
  config.probes.urls = ['https://chatgpt.com/', 'https://api.openai.com/v1/models'];
  config.policy.hardFailureConfirmSeconds = 0;
  config.policy.minimumDwellSeconds = 0;

  let selected = 'old';
  const switches = [];
  const logs = [];
  const controller = {
    async getProxy(name) {
      if (name === 'target') {
        return { name, type: 'Selector', now: selected, all: ['old', 'a'] };
      }
      if (name === 'candidates') {
        return { name, type: 'URLTest', all: ['old', 'a'] };
      }
      return { name, type: 'VLESS' };
    },
    async getDelay() {
      return 100;
    },
    async select(_group, node) {
      switches.push(node);
      selected = node;
    },
  };
  const watchdog = new Watchdog({
    controller,
    config,
    logger: async (level, event, details = {}) => {
      logs.push({ level, event, details });
    },
  });
  const result = await watchdog.runOnce({ dryRun: false, linkTelemetry });
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  return { config, controller, result, state, switches, logs };
}

test('业务拒绝只做记录：403 + WebSocket 401 时健康仍为 stable 且不切换', async () => {
  const run = await runScenario({
    linkTelemetry: { enabled: true, https: HTTPS_403, websocket: WEBSOCKET_401 },
  });

  assert.equal(run.result.status, 'healthy');
  assert.equal(run.switches.length, 0, '业务结果注释不能触发切换');
  assert.equal(run.state.lastEvaluation.health, 'healthy');
  assert.equal(run.state.lastEvaluation.stable, true);
  assert.deepEqual(run.state.lastEvaluation.linkFailures, []);
  assert.deepEqual(run.state.lastEvaluation.linkOutcomes, [
    { kind: 'https', networkOk: true, outcome: 'authentication-rejected', statusCode: 403 },
    { kind: 'websocket', networkOk: true, outcome: 'authentication-rejected', statusCode: 401 },
  ]);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, [
    { kind: 'https', outcome: 'authentication-rejected', statusCode: 403 },
    { kind: 'websocket', outcome: 'authentication-rejected', statusCode: 401 },
  ]);
  const evaluated = run.logs.filter((entry) => entry.event === 'current-node-evaluated');
  assert.equal(evaluated.length, 1);
  assert.deepEqual(evaluated[0].details.linkOutcomes, run.state.lastEvaluation.linkOutcomes);
});

test('网络不可达保持既有语义：仍判为 partial-failure 并进入恢复路径', async () => {
  const run = await runScenario({
    linkTelemetry: {
      enabled: true,
      https: { networkOk: false, outcome: 'network-error', statusCode: null },
      websocket: { networkOk: false, outcome: 'network-error', statusCode: null },
    },
  });

  assert.equal(run.result.status, 'transient');
  assert.equal(run.state.lastEvaluation.health, 'partial-failure');
  assert.equal(run.state.lastEvaluation.stable, false);
  assert.deepEqual(run.state.lastEvaluation.linkFailures, ['https', 'websocket']);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, []);
  assert.equal(run.switches.length, 0, '单周期未达确认阈值时不切换');
});

test('无 telemetry 时证据字段为空数组', async () => {
  const run = await runScenario();

  assert.equal(run.result.status, 'healthy');
  assert.deepEqual(run.state.lastEvaluation.linkFailures, []);
  assert.deepEqual(run.state.lastEvaluation.linkOutcomes, []);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, []);
});

test('证据分层字段可 JSON 序列化，状态快照仍可构建', async () => {
  const run = await runScenario({
    linkTelemetry: { enabled: true, https: HTTPS_403, websocket: WEBSOCKET_401 },
  });

  const stateRoundTrip = JSON.parse(JSON.stringify(run.state));
  assert.deepEqual(
    stateRoundTrip.lastEvaluation.businessAnnotations,
    run.state.lastEvaluation.businessAnnotations,
  );
  assert.deepEqual(stateRoundTrip.lastEvaluation.linkOutcomes, run.state.lastEvaluation.linkOutcomes);

  const snapshot = await buildStatusSnapshot({
    stateFile: run.config.files.state,
    logFile: run.config.files.log,
    controller: run.controller,
    targetGroup: run.config.groups.target,
    policy: run.config.policy,
    probes: run.config.probes,
    retainedFiles: run.config.logging.retainedFiles,
  });
  const snapshotRoundTrip = JSON.parse(JSON.stringify(snapshot));
  assert.equal(snapshotRoundTrip.current.selected, 'old');
  assert.ok(Array.isArray(snapshotRoundTrip.warnings));
});
