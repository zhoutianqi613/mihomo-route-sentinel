import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaults } from '../src/config.mjs';

const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const projectRoot = path.resolve(path.dirname(cliPath), '..');
const CLI_TIMEOUT_MS = 20000;

function makeConfig(root, { controllerUrl, modeOverrides = {}, groups } = {}) {
  const config = structuredClone(defaults);
  config.groups = groups ?? { target: 'PROXY', candidates: 'Candidates' };
  config.controller = { ...config.controller, transport: 'http', url: controllerUrl };
  config.telemetry = { ...config.telemetry, enabled: false };
  config.guardrails = { ...config.guardrails, ...modeOverrides };
  config.files = {
    state: path.join(root, 'state.json'),
    log: path.join(root, 'watchdog.ndjson'),
    lock: path.join(root, 'watchdog.lock'),
    guardrailState: path.join(root, 'guardrails.json'),
  };
  return config;
}

function startMockController({ mode = 'rule' } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/configs') {
      res.end(JSON.stringify({ mode, 'mixed-port': 7897 }));
      return;
    }
    if (url.pathname === '/proxies/PROXY') {
      res.end(JSON.stringify({ name: 'PROXY', type: 'Selector', now: 'node-a', all: ['node-a'] }));
      return;
    }
    if (url.pathname === '/proxies/Candidates') {
      res.end(JSON.stringify({ name: 'Candidates', type: 'Selector', now: 'node-a', all: ['node-a'] }));
      return;
    }
    if (url.pathname === '/proxies/node-a') {
      res.end(JSON.stringify({ name: 'node-a', type: 'VLESS' }));
      return;
    }
    if (url.pathname === '/proxies/node-a/delay') {
      res.end(JSON.stringify({ delay: 100 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.close(() => done()); }),
      });
    });
  });
}

function spawnCli(configPath, extraArgs = []) {
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
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`子进程超时未退出：${stdout}${stderr}`));
    }, CLI_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, done };
}

async function withWorkspace(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-cli-exit-'));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runCli(configPath, extraArgs = []) {
  const { done } = spawnCli(configPath, extraArgs);
  return done;
}

test('成功完成 Dry Run 返回退出码 0', async () => {
  const mock = await startMockController({ mode: 'rule' });
  try {
    await withWorkspace(async (root) => {
      const configPath = path.join(root, 'config.json');
      await writeFile(configPath, JSON.stringify(makeConfig(root, { controllerUrl: mock.url })));
      const result = await runCli(configPath);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /watchdog-cycle-completed/);
    });
  } finally {
    await mock.close();
  }
});

test('Controller 不可达返回退出码 3', async () => {
  await withWorkspace(async (root) => {
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(makeConfig(root, { controllerUrl: 'http://127.0.0.1:1' })));
    const result = await runCli(configPath);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /退出码：3|Controller 不可达/);
  });
});

test('占位组名属于配置错误并返回退出码 4', async () => {
  await withWorkspace(async (root) => {
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify(makeConfig(root, {
      controllerUrl: 'http://127.0.0.1:1',
      groups: { target: 'CHANGE_ME_TARGET_SELECTOR', candidates: 'CHANGE_ME_CANDIDATE_GROUP' },
    })));
    const result = await runCli(configPath);
    assert.equal(result.code, 4, result.stderr);
    assert.match(result.stderr, /占位值/);
  });
});

test('Dry Run 被配置守卫阻断返回退出码 2 并给出可执行路径', async () => {
  const mock = await startMockController({ mode: 'direct' });
  try {
    await withWorkspace(async (root) => {
      const configPath = path.join(root, 'config.json');
      await writeFile(configPath, JSON.stringify(makeConfig(root, { controllerUrl: mock.url })));
      const result = await runCli(configPath);
      assert.equal(result.code, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /只读 Dry Run 被配置守卫阻断/);
      assert.match(result.stderr, /runtime-mode/);
      assert.match(result.stderr, /处理方式/);
      assert.match(result.stderr, /"guardrails": \{ "enabled": false \}/);
    });
  } finally {
    await mock.close();
  }
});

test('--run 持续模式不因单轮守卫阻断退出', async () => {
  const mock = await startMockController({ mode: 'direct' });
  try {
    await withWorkspace(async (root) => {
      const configPath = path.join(root, 'config.json');
      await writeFile(configPath, JSON.stringify(makeConfig(root, { controllerUrl: mock.url })));
      const { child, done } = spawnCli(configPath, ['--run']);
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !/would-repair/.test(stdout) && child.exitCode === null) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      assert.equal(child.exitCode, null, `--run 不应因单轮阻断退出：${stdout}`);
      assert.match(stdout, /would-repair/);
      child.kill('SIGKILL');
      await once(child, 'close').catch(() => {});
      await done.catch(() => {});
    });
  } finally {
    await mock.close();
  }
});
