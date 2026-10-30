import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverClashVergeAppDir,
  ensureClashVergeRunningWindows,
  fileRefreshed,
  fileStamp,
  resolveClashVergeWindows,
  restartClashVergeWindows,
  sameWindowsPath,
  startClashVergeWindows,
  stopClashVergeWindows,
  validateClashVergeExecutable,
  waitForFileRefresh,
} from '../src/clash-verge-process.mjs';

const executable = path.resolve('fake-clash-verge', 'clash-verge.exe');

function fakeExec(handler) {
  const calls = [];
  const impl = async (command, args, options = {}) => {
    const call = { command, args, options };
    calls.push(call);
    return handler ? handler(call) : { stdout: '' };
  };
  return { calls, impl };
}

const scriptOf = (call) => call.args.at(-1);

test('validateClashVergeExecutable 与 sameWindowsPath 的纯判定', () => {
  assert.equal(validateClashVergeExecutable(executable), path.resolve(executable));
  assert.throws(() => validateClashVergeExecutable('clash-verge.exe'), /path is invalid/);
  assert.throws(() => validateClashVergeExecutable(path.resolve('clash-verge-other.exe')), /path is invalid/);
  assert.equal(sameWindowsPath(executable, executable.toUpperCase()), true);
  assert.equal(sameWindowsPath(executable, path.resolve('other.exe')), false);
});

test('discoverClashVergeAppDir 按配置、平台与环境变量解析', () => {
  const configured = path.resolve('custom-app-dir');
  assert.equal(discoverClashVergeAppDir({ configuredPath: configured, platform: 'win32' }), configured);

  const winDir = discoverClashVergeAppDir({
    platform: 'win32',
    env: { APPDATA: path.resolve('appdata') },
  });
  assert.match(winDir, /clash-verge-rev/);

  const darwinDir = discoverClashVergeAppDir({ platform: 'darwin', env: { HOME: path.resolve('home') } });
  assert.match(darwinDir, /Library/);
  assert.match(darwinDir, /clash-verge-rev/);

  const xdgDir = discoverClashVergeAppDir({
    platform: 'linux',
    env: { XDG_CONFIG_HOME: path.resolve('xdg'), HOME: path.resolve('home') },
  });
  assert.equal(xdgDir, path.join(path.resolve('xdg'), 'io.github.clash-verge-rev.clash-verge-rev'));
  assert.equal(discoverClashVergeAppDir({ platform: 'linux', env: {} }), '');
});

test('resolveClashVergeWindows 构造进程发现命令并校验 stdout', async () => {
  const { calls, impl } = fakeExec(() => ({ stdout: `${executable}\n` }));
  const resolved = await resolveClashVergeWindows({ execFileImpl: impl });

  assert.equal(resolved, executable);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.deepEqual(calls[0].args.slice(0, 6),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
  assert.match(scriptOf(calls[0]), /Get-CimInstance Win32_Process/);
  assert.match(scriptOf(calls[0]), /Write-Output/);
  assert.match(scriptOf(calls[0]), /\$false/);
  assert.equal(calls[0].options.windowsHide, true);
});

test('resolveClashVergeWindows 允许缺失时返回 null，缺失但不允许时报错', async () => {
  const empty = fakeExec(() => ({ stdout: '   ' }));
  assert.equal(await resolveClashVergeWindows({ allowMissing: true, execFileImpl: empty.impl }), null);
  assert.match(scriptOf(empty.calls[0]), /\$true/);
  await assert.rejects(resolveClashVergeWindows({ execFileImpl: empty.impl }));
});

test('stop 与 start 使用各自的 PowerShell 脚本和可执行文件环境变量', async () => {
  const { calls, impl } = fakeExec(() => ({ stdout: '' }));

  await stopClashVergeWindows(executable, { execFileImpl: impl });
  await startClashVergeWindows(executable, { execFileImpl: impl });

  assert.equal(calls.length, 2);
  assert.match(scriptOf(calls[0]), /Stop-Process -Id/);
  assert.equal(calls[0].options.env.MIHOMO_ROUTE_SENTINEL_CLASH_EXE, executable);
  assert.match(scriptOf(calls[1]), /Start-Process -FilePath/);
  assert.match(scriptOf(calls[1]), /-WindowStyle Hidden/);
  assert.equal(calls[1].options.env.MIHOMO_ROUTE_SENTINEL_CLASH_EXE, executable);
});

test('restartClashVergeWindows 先停止再启动并返回 true', async () => {
  const { calls, impl } = fakeExec((call) => (
    scriptOf(call).includes('Write-Output') ? { stdout: `${executable}\n` } : { stdout: '' }
  ));

  const result = await restartClashVergeWindows(null, { execFileImpl: impl, delayMs: 0 });

  assert.equal(result, true);
  assert.equal(calls.length, 3);
  assert.match(scriptOf(calls[0]), /Write-Output/);
  assert.match(scriptOf(calls[1]), /Stop-Process/);
  assert.match(scriptOf(calls[2]), /Start-Process/);
});

test('ensureClashVergeRunningWindows 仅在未运行时启动，路径不一致时报错', async () => {
  const runningSame = fakeExec(() => ({ stdout: `${executable}\n` }));
  await ensureClashVergeRunningWindows(executable, { execFileImpl: runningSame.impl });
  assert.equal(runningSame.calls.length, 1);

  const notRunning = fakeExec(() => ({ stdout: '' }));
  await ensureClashVergeRunningWindows(executable, { execFileImpl: notRunning.impl });
  assert.equal(notRunning.calls.length, 2);
  assert.match(scriptOf(notRunning.calls[1]), /Start-Process/);

  const other = path.resolve('fake-clash-verge', 'other', 'clash-verge.exe');
  const runningOther = fakeExec(() => ({ stdout: `${other}\n` }));
  await assert.rejects(
    ensureClashVergeRunningWindows(executable, { execFileImpl: runningOther.impl }),
    /does not match pending repair/,
  );
});

test('fileStamp / fileRefreshed / waitForFileRefresh 判定 mtime 前进', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sentinel-process-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'runtime.yaml');
  await writeFile(filePath, 'mode: rule\n', 'utf8');

  const before = await fileStamp(filePath);
  assert.equal(Number.isFinite(before.mtimeMs), true);
  assert.equal(fileRefreshed(before, before), false);
  assert.equal(fileRefreshed(before, { mtimeMs: before.mtimeMs + 1 }), true);

  const future = new Date(before.mtimeMs + 5_000);
  await utimes(filePath, future, future);
  const refreshed = await waitForFileRefresh(filePath, before, 100, { intervalMs: 5 });
  assert.ok(refreshed && refreshed.mtimeMs > before.mtimeMs);

  const freshStamp = await fileStamp(filePath);
  assert.equal(await waitForFileRefresh(filePath, freshStamp, 10, { intervalMs: 2 }), null);
});
