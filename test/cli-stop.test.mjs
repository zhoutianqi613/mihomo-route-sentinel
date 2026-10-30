import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readLock } from '../src/lock.mjs';

const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const lockModuleUrl = new URL('../src/lock.mjs', import.meta.url).href;
const projectRoot = path.resolve(path.dirname(cliPath), '..');

const holderSource = `import { acquireLock, controllerFingerprint } from ${JSON.stringify(lockModuleUrl)};
const lockFile = process.argv[2];
const mode = process.argv[3] ?? 'graceful';
const release = await acquireLock(lockFile, {
  controllerFingerprint: controllerFingerprint({
    controller: { transport: 'http', url: 'http://127.0.0.1:9090', pipePath: '' },
    groups: { target: 'PROXY' },
  }),
  programVersion: 'cli-stop-holder',
});
console.log('holder-ready');
if (mode === 'ignore') {
  process.on('SIGTERM', () => {});
} else {
  process.on('SIGTERM', async () => {
    await release();
    process.exit(0);
  });
}
setInterval(() => {}, 1000);
`;

function sleep(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

async function withWorkspace(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mihomo-cli-stop-'));
  const configPath = path.join(root, 'config.json');
  const lockPath = path.join(root, 'watchdog.lock');
  await writeFile(configPath, JSON.stringify({
    configVersion: 5,
    groups: { target: 'PROXY', candidates: 'Candidates' },
    files: { lock: './watchdog.lock' },
  }), 'utf8');
  try {
    return await action({ root, configPath, lockPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runCli(configPath, extraArgs = []) {
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

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

async function startHolder(root, lockPath, mode = 'graceful') {
  const holderPath = path.join(root, 'holder.mjs');
  await writeFile(holderPath, holderSource, 'utf8');
  const child = spawn(process.execPath, [holderPath, lockPath, mode], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const lock = await readLock(lockPath);
    if (lock?.pid === child.pid) return child;
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  child.kill('SIGKILL');
  throw new Error('持锁子进程未能在超时内就绪');
}

test('无锁文件时 --stop 提示未在运行并退出 0', async () => {
  await withWorkspace(async ({ configPath }) => {
    const result = await runCli(configPath, ['--stop']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /未在运行/);
  });
});

test('锁文件 PID 已死时 --stop 清理陈旧锁并退出 0', async () => {
  await withWorkspace(async ({ configPath, lockPath }) => {
    const stalePid = await deadPid();
    await writeFile(lockPath, JSON.stringify({
      version: 1,
      pid: stalePid,
      startedAt: new Date().toISOString(),
      controllerFingerprint: 'stale',
      programVersion: 'stale',
    }), 'utf8');
    const result = await runCli(configPath, ['--stop']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /未存活，已清理陈旧锁/);
    assert.equal(await readLock(lockPath), null);
  });
});

test('锁文件内容损坏时 --stop 清理陈旧锁并退出 0', async () => {
  await withWorkspace(async ({ configPath, lockPath }) => {
    await writeFile(lockPath, '{broken-json', 'utf8');
    const result = await runCli(configPath, ['--stop']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /无法解析，已清理陈旧锁/);
    assert.equal(await readLock(lockPath), null);
  });
});

test('活实例收到 --stop 的 SIGTERM 后退出且锁被释放', async () => {
  await withWorkspace(async ({ root, configPath, lockPath }) => {
    const holder = await startHolder(root, lockPath);
    try {
      const result = await runCli(configPath, ['--stop']);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /已停止/);
      assert.equal(await readLock(lockPath), null);
    } finally {
      holder.kill('SIGKILL');
    }
  });
});

test('活实例忽略 SIGTERM 时 --stop 在 5 秒后提示超时', {
  skip: process.platform === 'win32' ? 'Windows 的 SIGTERM 会直接终止进程' : false,
}, async () => {
  await withWorkspace(async ({ root, configPath, lockPath }) => {
    const holder = await startHolder(root, lockPath, 'ignore');
    try {
      const result = await runCli(configPath, ['--stop']);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /5 秒内未释放/);
      assert.equal((await readLock(lockPath))?.pid, holder.pid);
    } finally {
      holder.kill('SIGKILL');
    }
  });
});

test('--help 说明 --stop 的用途', async () => {
  const help = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, '--help'], { cwd: projectRoot });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
  assert.match(help, /--stop/);
  assert.match(help, /SIGTERM/);
});
