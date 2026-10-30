import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

async function withDir(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mihomo-status-mode-'));
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

test('持续守护 + 实际控制显示 mode/apply 且不出现 Dry Run 警告', async () => {
  await withDir(async (root) => {
    const version = await packageVersion();
    const files = await writeFiles(root, {
      state: {
        runtime: {
          version,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          mode: 'continuous',
          apply: true,
        },
        lastEvaluation: recentEvaluation(),
      },
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: true, pid: process.pid, alive: true },
      programVersion: version,
      intervalSeconds: 30,
    });
    assert.equal(snapshot.runtime.mode, 'continuous');
    assert.equal(snapshot.runtime.apply, true);
    const output = formatStatus(snapshot);
    assert.match(output, /运行模式\s+: 持续守护 · 实际控制\(--apply\)/);
    assert.ok(!snapshot.warnings.includes('当前不会切换节点（Dry Run）'));
  });
});

test('单次 + Dry Run 显示对应文案并在警告区固定提示', async () => {
  await withDir(async (root) => {
    const version = await packageVersion();
    const files = await writeFiles(root, {
      state: {
        runtime: {
          version,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          mode: 'once',
          apply: false,
        },
        lastEvaluation: recentEvaluation(),
      },
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: true, pid: process.pid, alive: true },
      programVersion: version,
      intervalSeconds: 30,
    });
    assert.equal(snapshot.runtime.mode, 'once');
    assert.equal(snapshot.runtime.apply, false);
    assert.ok(snapshot.warnings.includes('当前不会切换节点（Dry Run）'));
    const output = formatStatus(snapshot);
    assert.match(output, /运行模式\s+: 单次 · Dry Run\(--dry-run\)/);
    assert.match(output, /警告\s+: .*当前不会切换节点（Dry Run）/);
  });
});

test('--status-json 暴露 runtime.mode 与 runtime.apply', async () => {
  await withDir(async (root) => {
    const configPath = await writeConfig(root);
    const version = await packageVersion();
    await writeFiles(root, {
      state: {
        runtime: {
          version,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          mode: 'continuous',
          apply: true,
        },
        lastEvaluation: recentEvaluation(),
      },
    });
    const result = await runCli(configPath, ['--status-json']);
    assert.equal(result.code, 0, result.stderr);
    const snapshot = JSON.parse(result.stdout);
    assert.equal(snapshot.runtime.mode, 'continuous');
    assert.equal(snapshot.runtime.apply, true);
  });
});

test('旧状态缺少 mode/apply 时显示未知且不崩溃', async () => {
  await withDir(async (root) => {
    const version = await packageVersion();
    const files = await writeFiles(root, {
      state: {
        runtime: { version, pid: 1234, startedAt: new Date().toISOString() },
        lastEvaluation: recentEvaluation(),
      },
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: true, pid: process.pid, alive: true },
      programVersion: version,
      intervalSeconds: 30,
    });
    assert.equal(snapshot.runtime.mode, null);
    assert.equal(snapshot.runtime.apply, null);
    const output = formatStatus(snapshot);
    assert.match(output, /运行模式\s+: 未知 · 未知/);
  });
});

test('新实例尚未落盘时用较新的启动日志补全 mode/apply', async () => {
  await withDir(async (root) => {
    const version = await packageVersion();
    const oldStart = new Date(Date.now() - 60_000).toISOString();
    const newStart = new Date().toISOString();
    const files = await writeFiles(root, {
      state: {
        runtime: { version, pid: 1111, startedAt: oldStart, mode: 'continuous', apply: true },
        lastEvaluation: recentEvaluation(),
      },
      log: [{
        timestamp: newStart,
        event: 'watchdog-started',
        runtime: { version, pid: 2222, startedAt: newStart, mode: 'once', apply: false },
      }],
    });
    const snapshot = await buildStatusSnapshot({
      ...files,
      instance: { lockPresent: true, pid: 2222, alive: true },
      programVersion: version,
      intervalSeconds: 30,
    });
    assert.equal(snapshot.runtime.pid, 2222);
    assert.equal(snapshot.runtime.mode, 'once');
    assert.equal(snapshot.runtime.apply, false);
    const output = formatStatus(snapshot);
    assert.match(output, /运行模式\s+: 单次 · Dry Run\(--dry-run\)/);
    assert.ok(snapshot.warnings.includes('当前不会切换节点（Dry Run）'));
  });
});
