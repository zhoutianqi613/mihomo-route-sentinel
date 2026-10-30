import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildStatusSnapshot, formatStatus } from '../src/observability.mjs';

const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const projectRoot = path.resolve(path.dirname(cliPath), '..');

async function packageVersion() {
  const metadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  return metadata.version;
}

async function withStatusDir(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mihomo-status-'));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFiles(root, { state = {}, log = [] } = {}) {
  const stateFile = path.join(root, 'state.json');
  const logFile = path.join(root, 'watchdog.ndjson');
  await writeFile(stateFile, JSON.stringify(state), 'utf8');
  await writeFile(
    logFile,
    log.map((record) => JSON.stringify(record)).join('\n') + (log.length ? '\n' : ''),
    'utf8',
  );
  return { stateFile, logFile };
}

function recentEvaluation(overrides = {}) {
  return {
    timestamp: new Date().toISOString(),
    selected: 'node-a',
    leaf: 'node-a',
    successRate: 1,
    averageMs: 400,
    maxMs: 500,
    health: 'healthy',
    quality: 'excellent',
    ...overrides,
  };
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

async function writeConfig(root) {
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    configVersion: 5,
    groups: { target: 'PROXY', candidates: 'Candidates' },
    controller: { transport: 'http', url: 'http://127.0.0.1:1' },
    telemetry: { enabled: false },
    guardrails: { enabled: false },
    files: {
      state: './state.json',
      log: './watchdog.ndjson',
      lock: './watchdog.lock',
      guardrailState: './guardrails.json',
    },
  }), 'utf8');
  return configPath;
}

function runCli(configPath, extraArgs) {
  const child = spawn(process.execPath, [cliPath, '--config', configPath, ...extraArgs], {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('锁缺失时状态页首行提示无运行实例并附带警告', async () => {
  await withStatusDir(async (root) => {
    const files = await writeFiles(root, {
      state: {
        runtime: { version: await packageVersion(), pid: 4321, startedAt: new Date().toISOString() },
        lastEvaluation: recentEvaluation(),
      },
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: false, pid: null, alive: false },
      programVersion: await packageVersion(),
      intervalSeconds: 30,
    });
    assert.ok(snapshot.warnings.includes('无运行实例（以下为上次运行记录）'));
    const output = formatStatus(snapshot);
    assert.equal(output.split('\n')[0], '无运行实例（以下为上次运行记录）');
    // runtime 仍展示上次运行记录，而不是被清空。
    assert.match(output, /运行版本\s+: 1\.8\.3（PID 4321/);
  });
});

test('CLI --status 在无锁时首行显示无运行实例', async () => {
  await withStatusDir(async (root) => {
    const configPath = await writeConfig(root);
    await writeFiles(root, {
      state: {
        runtime: { version: await packageVersion(), pid: 4321, startedAt: new Date().toISOString() },
        lastEvaluation: recentEvaluation(),
      },
    });
    const result = await runCli(configPath, ['--status']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.split('\n')[0], '无运行实例（以下为上次运行记录）');
  });
});

test('CLI --status-json 暴露 instance 与 warnings，假 PID 判为非存活', async () => {
  await withStatusDir(async (root) => {
    const configPath = await writeConfig(root);
    const stalePid = await deadPid();
    await writeFiles(root, {
      state: {
        runtime: { version: await packageVersion(), pid: stalePid, startedAt: new Date().toISOString() },
        lastEvaluation: recentEvaluation(),
      },
    });
    await writeFile(path.join(root, 'watchdog.lock'), JSON.stringify({
      version: 1,
      pid: stalePid,
      startedAt: new Date().toISOString(),
      controllerFingerprint: 'test',
      programVersion: await packageVersion(),
    }), 'utf8');
    const result = await runCli(configPath, ['--status-json']);
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.deepEqual(snapshot.instance, { lockPresent: true, pid: stalePid, alive: false });
    assert.ok(Array.isArray(snapshot.warnings));
    assert.ok(snapshot.warnings.includes('无运行实例（以下为上次运行记录）'));
    assert.equal(snapshot.runtime.version, await packageVersion());
  });
});

test('过期 lastEvaluation 触发数据过期警告', async () => {
  await withStatusDir(async (root) => {
    const files = await writeFiles(root, {
      state: {
        runtime: { version: await packageVersion(), pid: 1, startedAt: new Date().toISOString() },
        lastEvaluation: recentEvaluation({ timestamp: new Date(Date.now() - 300_000).toISOString() }),
      },
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: true, pid: process.pid, alive: true },
      programVersion: await packageVersion(),
      intervalSeconds: 30,
    });
    assert.ok(snapshot.warnings.some((message) => (
      message.includes('数据已过期') && message.includes('60 秒')
    )));
  });
});

test('runtime.version 与当前程序版本不一致时给出旧代码警告', async () => {
  await withStatusDir(async (root) => {
    const files = await writeFiles(root, {
      state: {
        runtime: { version: '9.9.9-old', pid: 7, startedAt: new Date().toISOString() },
        lastEvaluation: recentEvaluation(),
      },
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: true, pid: process.pid, alive: true },
      programVersion: '1.8.3',
      intervalSeconds: 30,
    });
    assert.ok(snapshot.warnings.includes('后台运行 9.9.9-old ≠ 当前程序 1.8.3，任务可能仍加载旧代码'));
  });
});

test('state.runtime 缺失时回退最近一次 watchdog-started 日志', async () => {
  await withStatusDir(async (root) => {
    const files = await writeFiles(root, {
      log: [
        {
          timestamp: new Date(Date.now() - 5000).toISOString(),
          event: 'watchdog-started',
          runtime: { version: '1.8.3', pid: 4242, startedAt: new Date().toISOString() },
        },
        {
          timestamp: new Date().toISOString(),
          event: 'current-node-evaluated',
          ...recentEvaluation(),
        },
      ],
    });
    const snapshot = await buildStatusSnapshot({ ...files, programVersion: '1.8.3' });
    assert.equal(snapshot.runtime.pid, 4242);
    assert.equal(snapshot.runtime.version, '1.8.3');
    assert.ok(!snapshot.warnings.some((message) => message.includes('旧代码')));
    const output = formatStatus(snapshot);
    assert.match(output, /运行版本\s+: 1\.8\.3（PID 4242/);
  });
});
