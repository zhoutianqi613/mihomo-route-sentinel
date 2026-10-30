// Clash Verge 进程控制与配置文件刷新等待：Windows 进程发现/停止/启动/重启、
// appDir 解析、可执行文件校验与 mtime 轮询。只做本机进程与文件时间戳操作，
// 不依赖 guardrails.mjs / dns-config.mjs，避免循环依赖。
import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLASH_VERGE_DIR = 'io.github.clash-verge-rev.clash-verge-rev';
const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

export async function pathExists(target) {
  try { await access(target); return true; } catch { return false; }
}

export function discoverClashVergeAppDir({ configuredPath = '', platform = process.platform, env = process.env } = {}) {
  if (configuredPath) return path.resolve(configuredPath);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, CLASH_VERGE_DIR);
  if (platform === 'darwin' && env.HOME) {
    return path.join(env.HOME, 'Library', 'Application Support', CLASH_VERGE_DIR);
  }
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, CLASH_VERGE_DIR);
  if (env.HOME) return path.join(env.HOME, '.config', CLASH_VERGE_DIR);
  return '';
}

export async function resolveClashVergeWindows({ allowMissing = false, execFileImpl = execFileAsync } = {}) {
  const script = [
    '$sessionId = (Get-Process -Id $PID).SessionId',
    "$matches = @(Get-CimInstance Win32_Process -Filter \"Name = 'clash-verge.exe'\" | Where-Object { $_.SessionId -eq $sessionId -and $_.ExecutablePath })",
    `if ($matches.Count -eq 0 -and ${allowMissing ? '$true' : '$false'}) { exit 0 }`,
    "if ($matches.Count -ne 1) { throw 'Expected exactly one Clash Verge GUI process in the current session' }",
    'Write-Output $matches[0].ExecutablePath',
  ].join('; ');
  const { stdout } = await execFileImpl('powershell.exe', [...POWERSHELL_ARGS, script],
    { windowsHide: true, timeout: 15000 });
  const executable = stdout.trim();
  if (!executable && allowMissing) return null;
  if (!path.isAbsolute(executable)) throw new Error('Clash Verge executable path was not resolved');
  return executable;
}

export async function stopClashVergeWindows(expectedExecutable, { execFileImpl = execFileAsync } = {}) {
  const script = [
    '$sessionId = (Get-Process -Id $PID).SessionId',
    "$matches = @(Get-CimInstance Win32_Process -Filter \"Name = 'clash-verge.exe'\" | Where-Object { $_.SessionId -eq $sessionId -and $_.ExecutablePath -eq $env:MIHOMO_ROUTE_SENTINEL_CLASH_EXE })",
    "if ($matches.Count -ne 1) { throw 'Expected exactly one matching Clash Verge GUI process' }",
    'Stop-Process -Id $matches[0].ProcessId -Force',
  ].join('; ');
  await execFileImpl('powershell.exe', [...POWERSHELL_ARGS, script], {
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, MIHOMO_ROUTE_SENTINEL_CLASH_EXE: expectedExecutable },
  });
}

export async function startClashVergeWindows(executable, { execFileImpl = execFileAsync } = {}) {
  await execFileImpl('powershell.exe', [...POWERSHELL_ARGS,
    'Start-Process -FilePath $env:MIHOMO_ROUTE_SENTINEL_CLASH_EXE -WindowStyle Hidden',
  ], {
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, MIHOMO_ROUTE_SENTINEL_CLASH_EXE: executable },
  });
}

export function validateClashVergeExecutable(executable) {
  if (!executable || !path.isAbsolute(executable)
      || path.basename(executable).toLowerCase() !== 'clash-verge.exe') {
    throw new Error('Clash Verge executable path is invalid');
  }
  return path.resolve(executable);
}

export function sameWindowsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export async function stopClashVergeIfRunningWindows(expectedExecutable = null, { execFileImpl = execFileAsync } = {}) {
  const runningExecutable = await resolveClashVergeWindows({ allowMissing: true, execFileImpl });
  const executable = validateClashVergeExecutable(expectedExecutable ?? runningExecutable);
  if (runningExecutable) {
    if (!sameWindowsPath(runningExecutable, executable)) {
      throw new Error('Running Clash Verge executable does not match pending repair');
    }
    await stopClashVergeWindows(executable, { execFileImpl });
  }
  return executable;
}

export async function restartClashVergeWindows(expectedExecutable = null, {
  execFileImpl = execFileAsync,
  delayMs = 800,
} = {}) {
  const executable = await stopClashVergeIfRunningWindows(expectedExecutable, { execFileImpl });
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await startClashVergeWindows(executable, { execFileImpl });
  return true;
}

export async function ensureClashVergeRunningWindows(expectedExecutable, { execFileImpl = execFileAsync } = {}) {
  const executable = validateClashVergeExecutable(expectedExecutable);
  const runningExecutable = await resolveClashVergeWindows({ allowMissing: true, execFileImpl });
  if (!runningExecutable) {
    await startClashVergeWindows(executable, { execFileImpl });
    return;
  }
  if (!sameWindowsPath(runningExecutable, executable)) {
    throw new Error('Running Clash Verge executable does not match pending repair');
  }
}

export async function fileStamp(filePath) {
  const metadata = await stat(filePath);
  return { mtimeMs: metadata.mtimeMs };
}

export function fileRefreshed(before, after) {
  return Boolean(after && (!before || after.mtimeMs > before.mtimeMs));
}

export async function waitForFileRefresh(filePath, previousStamp, timeoutMs = 20000, { intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await fileStamp(filePath).catch(() => null);
    if (fileRefreshed(previousStamp, current)) return current;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return null;
}
