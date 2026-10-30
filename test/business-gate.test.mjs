import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CURRENT_CONFIG_VERSION, defaults, loadConfig } from '../src/config.mjs';
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

async function runScenario({
  businessGate = false,
  partialFailureCycles = 2,
  hardFailure = false,
  linkTelemetry,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-business-gate-'));
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
  config.policy.postSwitchDelaySeconds = 0;
  config.policy.partialFailureCycles = partialFailureCycles;
  config.telemetry.businessFailureMarksDegraded = businessGate;

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
    async getDelay(name) {
      if (hardFailure) {
        throw Object.assign(new Error('mock probe timeout'), { status: 504 });
      }
      return name === 'a' ? 10 : 100;
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
  return { config, result, state, switches, logs };
}

function evaluationLogs(logs) {
  return logs.filter((entry) => entry.event === 'current-node-evaluated');
}

test('业务失败门默认关闭：403 与 WebSocket 401 不改变健康且不切换', async () => {
  const run = await runScenario({
    businessGate: false,
    linkTelemetry: { enabled: true, https: HTTPS_403, websocket: WEBSOCKET_401 },
  });

  assert.equal(run.result.status, 'healthy');
  assert.equal(run.switches.length, 0);
  assert.equal(run.state.lastEvaluation.health, 'healthy');
  assert.equal(run.state.lastEvaluation.stable, true);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, [
    { kind: 'https', outcome: 'authentication-rejected', statusCode: 403 },
    { kind: 'websocket', outcome: 'authentication-rejected', statusCode: 401 },
  ]);
  const evaluated = evaluationLogs(run.logs);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].details.health, 'healthy');
  assert.equal(evaluated[0].details.businessFailureCount, 2);
});

test('业务失败门开启：403 与 WebSocket 401 判为 partial-failure 并进入恢复路径', async () => {
  const run = await runScenario({
    businessGate: true,
    partialFailureCycles: 1,
    linkTelemetry: { enabled: true, https: HTTPS_403, websocket: WEBSOCKET_401 },
  });

  const evaluated = evaluationLogs(run.logs);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].details.health, 'partial-failure');
  assert.equal(evaluated[0].details.businessFailureCount, 2);
  assert.equal(run.result.status, 'switched');
  assert.deepEqual(run.switches, ['a']);
  assert.equal(run.state.switchHistory[0].budgetClass, 'recovery');
  assert.equal(run.state.decisionState.budget.recovery.used, 1);
});

test('业务失败门开启时硬故障优先：仍为 hard-failure 而不是 partial-failure', async () => {
  const run = await runScenario({
    businessGate: true,
    hardFailure: true,
    linkTelemetry: { enabled: true, https: HTTPS_403, websocket: WEBSOCKET_401 },
  });

  const evaluated = evaluationLogs(run.logs);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].details.health, 'hard-failure');
  assert.equal(evaluated[0].details.businessFailureCount, 2);
  assert.equal(run.result.status, 'no-candidate');
  assert.equal(run.state.lastEvaluation.health, 'hard-failure');
});

test('业务失败门开启但无遥测：健康判定不受影响', async () => {
  const run = await runScenario({ businessGate: true });

  assert.equal(run.result.status, 'healthy');
  assert.equal(run.switches.length, 0);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, []);
  assert.equal(run.state.lastEvaluation.health, 'healthy');
  const evaluated = evaluationLogs(run.logs);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].details.businessFailureCount, 0);
});

test('业务失败门开启但业务结果为 accepted/upgraded：无业务失败证据', async () => {
  const run = await runScenario({
    businessGate: true,
    linkTelemetry: {
      enabled: true,
      https: { networkOk: true, outcome: 'accepted', statusCode: 200 },
      websocket: { networkOk: true, outcome: 'upgraded', statusCode: 101 },
    },
  });

  assert.equal(run.result.status, 'healthy');
  assert.equal(run.switches.length, 0);
  assert.deepEqual(run.state.lastEvaluation.linkOutcomes, [
    { kind: 'https', networkOk: true, outcome: 'accepted', statusCode: 200 },
    { kind: 'websocket', networkOk: true, outcome: 'upgraded', statusCode: 101 },
  ]);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, []);
  assert.equal(evaluationLogs(run.logs)[0].details.businessFailureCount, 0);
});

test('业务失败门开启：WebSocket 未升级（101 但握手无效）计入业务降级', async () => {
  const run = await runScenario({
    businessGate: true,
    linkTelemetry: {
      enabled: true,
      https: { networkOk: true, outcome: 'accepted', statusCode: 200 },
      websocket: { networkOk: true, outcome: 'invalid-websocket-handshake', statusCode: 101 },
    },
  });

  assert.equal(run.result.status, 'transient');
  assert.equal(run.switches.length, 0);
  assert.deepEqual(run.state.lastEvaluation.businessAnnotations, [
    { kind: 'websocket', outcome: 'invalid-websocket-handshake', statusCode: 101 },
  ]);
  const evaluated = evaluationLogs(run.logs);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].details.health, 'partial-failure');
  assert.equal(evaluated[0].details.businessFailureCount, 1);
});

test('businessFailureMarksDegraded 默认关闭且必须为布尔值', async () => {
  assert.equal(defaults.telemetry.businessFailureMarksDegraded, false);

  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-business-gate-config-'));
  const configPath = path.join(root, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      configVersion: CURRENT_CONFIG_VERSION,
      groups: { target: 'PROXY', candidates: 'Candidates' },
      telemetry: { businessFailureMarksDegraded: 'false' },
    }), 'utf8');
    await assert.rejects(loadConfig(configPath), /businessFailureMarksDegraded.*布尔/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
