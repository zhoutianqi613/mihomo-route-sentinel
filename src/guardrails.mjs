import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLASH_VERGE_DIR = 'io.github.clash-verge-rev.clash-verge-rev';

function lineIndent(line) {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function stripYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.split(/\s+#/, 1)[0].trim();
}

function parseTopLevelScalar(content, key) {
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.*?)\\s*$`, 'm');
  const match = content.match(pattern);
  return match ? stripYamlScalar(match[1]) : null;
}

function parseBoolean(value, name) {
  if (value === null) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function splitYaml(content) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  return { lines: content.split(/\r?\n/), newline };
}

function sectionRange(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (lineIndent(line) === 0) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function profileRange(lines, section, profileUid) {
  if (!section) return null;
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    if (lineIndent(line) !== 2) continue;
    const match = line.match(/^\s{2}(.+?):\s*(?:#.*)?$/);
    if (!match || stripYamlScalar(match[1]) !== profileUid) continue;
    let end = section.end;
    for (let inner = index + 1; inner < section.end; inner += 1) {
      const candidate = lines[inner];
      if (!candidate.trim() || candidate.trimStart().startsWith('#')) continue;
      if (lineIndent(candidate) <= 2) {
        end = inner;
        break;
      }
    }
    return { start: index, end };
  }
  return null;
}

function nestedScalar(lines, range, key) {
  if (!range) return null;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = lines[index].match(new RegExp(`^\\s{4,}${key}:\\s*(.*?)\\s*$`));
    if (match) return { index, value: stripYamlScalar(match[1]) };
  }
  return null;
}

export function inspectClashVergeDnsOverride(vergeContent, profileUid) {
  const globalEnabled = parseBoolean(
    parseTopLevelScalar(vergeContent, 'enable_dns_settings'),
    'enable_dns_settings',
  ) ?? false;
  const { lines } = splitYaml(vergeContent);
  const profile = profileRange(lines, sectionRange(lines, 'profile_dns_settings'), profileUid);
  const profileEnabledEntry = nestedScalar(lines, profile, 'enabled');
  const profileEnabled = profileEnabledEntry
    ? parseBoolean(profileEnabledEntry.value, 'profile_dns_settings.enabled')
    : null;
  return {
    enabled: profileEnabled ?? globalEnabled,
    globalEnabled,
    profileEnabled,
  };
}

export function disableClashVergeDnsOverride(vergeContent, profileUid) {
  const { lines, newline } = splitYaml(vergeContent);
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^enable_dns_settings:\s*true(?:\s+#.*)?$/.test(lines[index])) {
      lines[index] = lines[index].replace(/true/, 'false');
      changed = true;
      break;
    }
  }
  const profile = profileRange(lines, sectionRange(lines, 'profile_dns_settings'), profileUid);
  const enabled = nestedScalar(lines, profile, 'enabled');
  if (enabled && enabled.value === 'true') {
    lines[enabled.index] = lines[enabled.index].replace(/true/, 'false');
    changed = true;
  }
  if (profile) {
    for (let index = profile.end - 1; index > profile.start; index -= 1) {
      if (/^\s{4,}confirmation:\s*/.test(lines[index])) {
        lines.splice(index, 1);
        changed = true;
      }
    }
  }
  return { changed, content: lines.join(newline) };
}

export function replaceTopLevelScalar(content, key, expected) {
  const { lines, newline } = splitYaml(content);
  const pattern = new RegExp(`^${key}:\\s*([^#]*?)(\\s+#.*)?$`);
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) return { changed: false, found: false, content };
  const match = lines[index].match(pattern);
  if (stripYamlScalar(match[1]) === expected) return { changed: false, found: true, content };
  lines[index] = `${key}: ${expected}${match[2] ?? ''}`;
  return { changed: true, found: true, content: lines.join(newline) };
}

async function exists(target) {
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

async function resolveClashVergeWindows({ allowMissing = false } = {}) {
  const script = [
    '$sessionId = (Get-Process -Id $PID).SessionId',
    "$matches = @(Get-CimInstance Win32_Process -Filter \"Name = 'clash-verge.exe'\" | Where-Object { $_.SessionId -eq $sessionId -and $_.ExecutablePath })",
    `if ($matches.Count -eq 0 -and ${allowMissing ? '$true' : '$false'}) { exit 0 }`,
    "if ($matches.Count -ne 1) { throw 'Expected exactly one Clash Verge GUI process in the current session' }",
    'Write-Output $matches[0].ExecutablePath',
  ].join('; ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { windowsHide: true, timeout: 15000 });
  const executable = stdout.trim();
  if (!executable && allowMissing) return null;
  if (!path.isAbsolute(executable)) throw new Error('Clash Verge executable path was not resolved');
  return executable;
}

async function stopClashVergeWindows(expectedExecutable) {
  const script = [
    '$sessionId = (Get-Process -Id $PID).SessionId',
    "$matches = @(Get-CimInstance Win32_Process -Filter \"Name = 'clash-verge.exe'\" | Where-Object { $_.SessionId -eq $sessionId -and $_.ExecutablePath -eq $env:MIHOMO_ROUTE_SENTINEL_CLASH_EXE })",
    "if ($matches.Count -ne 1) { throw 'Expected exactly one matching Clash Verge GUI process' }",
    'Stop-Process -Id $matches[0].ProcessId -Force',
  ].join('; ');
  await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, MIHOMO_ROUTE_SENTINEL_CLASH_EXE: expectedExecutable },
  });
}

async function startClashVergeWindows(executable) {
  await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Start-Process -FilePath $env:MIHOMO_ROUTE_SENTINEL_CLASH_EXE -WindowStyle Hidden',
  ], {
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, MIHOMO_ROUTE_SENTINEL_CLASH_EXE: executable },
  });
}

function validateClashVergeExecutable(executable) {
  if (!executable || !path.isAbsolute(executable)
      || path.basename(executable).toLowerCase() !== 'clash-verge.exe') {
    throw new Error('Clash Verge executable path is invalid');
  }
  return path.resolve(executable);
}

function sameWindowsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

async function stopClashVergeIfRunningWindows(expectedExecutable = null) {
  const runningExecutable = await resolveClashVergeWindows({ allowMissing: true });
  const executable = validateClashVergeExecutable(expectedExecutable ?? runningExecutable);
  if (runningExecutable) {
    if (!sameWindowsPath(runningExecutable, executable)) {
      throw new Error('Running Clash Verge executable does not match pending repair');
    }
    await stopClashVergeWindows(executable);
  }
  return executable;
}

async function restartClashVergeWindows(expectedExecutable = null) {
  const executable = await stopClashVergeIfRunningWindows(expectedExecutable);
  await new Promise((resolve) => setTimeout(resolve, 800));
  await startClashVergeWindows(executable);
  return true;
}

async function ensureClashVergeRunningWindows(expectedExecutable) {
  const executable = validateClashVergeExecutable(expectedExecutable);
  const runningExecutable = await resolveClashVergeWindows({ allowMissing: true });
  if (!runningExecutable) {
    await startClashVergeWindows(executable);
    return;
  }
  if (!sameWindowsPath(runningExecutable, executable)) {
    throw new Error('Running Clash Verge executable does not match pending repair');
  }
}

async function scanLines(filePath, visitor) {
  const before = await stat(filePath);
  const stream = createReadStream(filePath);
  let pending = Buffer.alloc(0);
  let offset = 0;
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let newline;
    while ((newline = pending.indexOf(0x0a)) >= 0) {
      const raw = pending.subarray(0, newline);
      const line = raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw;
      visitor(line, offset);
      pending = pending.subarray(newline + 1);
      offset += newline + 1;
    }
  }
  if (pending.length) visitor(pending, offset);
  const after = await stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error('configuration changed during scan');
  }
  return before;
}

async function readTopLevelScalarFile(filePath, key) {
  let value = null;
  const prefix = `${key}:`;
  await scanLines(filePath, (raw) => {
    if (value !== null) return;
    const line = raw.toString('utf8');
    if (line.startsWith(prefix)) value = stripYamlScalar(line.slice(prefix.length));
  });
  return value;
}

async function inspectDnsOverrideFile(filePath, profileUid) {
  let globalEnabled = false;
  let profileEnabled = null;
  let inProfiles = false;
  let inTarget = false;
  let targetMutations = [];
  const mutations = [];
  const metadata = await scanLines(filePath, (raw, lineOffset) => {
    const line = raw.toString('utf8');
    if (!line.trim() || line.trimStart().startsWith('#')) return;
    const indent = lineIndent(line);
    if (indent === 0) {
      inProfiles = /^profile_dns_settings:\s*(?:#.*)?$/.test(line);
      inTarget = false;
      const match = line.match(/^enable_dns_settings:\s*(true|false)(?:\s+#.*)?$/);
      if (match) {
        globalEnabled = match[1] === 'true';
        if (globalEnabled) mutations.push({ offset: lineOffset, expected: 'e', replacement: '#' });
      } else if (/^enable_dns_settings:/.test(line)) {
        throw new Error('enable_dns_settings must be boolean');
      }
      return;
    }
    if (!inProfiles) return;
    if (indent === 2) {
      const match = line.match(/^\s{2}(.+?):\s*(?:#.*)?$/);
      inTarget = Boolean(match && stripYamlScalar(match[1]) === profileUid);
      if (inTarget) {
        targetMutations = [{ offset: lineOffset, expected: '  ', replacement: '##' }];
      }
      return;
    }
    if (inTarget && indent >= 4) {
      targetMutations.push({
        offset: lineOffset,
        expected: ' '.repeat(indent),
        replacement: '#'.repeat(indent),
      });
      const match = line.match(/^\s{4,}enabled:\s*(true|false)(?:\s+#.*)?$/);
      if (match) {
        profileEnabled = match[1] === 'true';
      } else if (/^\s{4,}enabled:/.test(line)) {
        throw new Error('profile_dns_settings.enabled must be boolean');
      }
    }
  });
  return {
    enabled: profileEnabled ?? globalEnabled,
    globalEnabled,
    profileEnabled,
    mutations: [...mutations, ...(profileEnabled ? targetMutations : [])],
    metadata: { size: metadata.size, mtimeMs: metadata.mtimeMs },
  };
}

async function applyFixedMutations(filePath, mutations, expectedMetadata = null) {
  const current = await stat(filePath);
  if (expectedMetadata
      && (current.size !== expectedMetadata.size || current.mtimeMs !== expectedMetadata.mtimeMs)) {
    throw new Error('configuration changed before repair');
  }
  const handle = await open(filePath, 'r+');
  try {
    // 先注释子字段，最后注释 profile 头；任意中断都可用同一 journal 幂等续写。
    for (const mutation of [...mutations].sort((a, b) => b.offset - a.offset)) {
      const expected = Buffer.from(mutation.expected, 'utf8');
      const replacement = Buffer.from(mutation.replacement, 'utf8');
      if (expected.length !== replacement.length) throw new Error('mutation length mismatch');
      const currentBytes = Buffer.alloc(expected.length);
      await handle.read(currentBytes, 0, currentBytes.length, mutation.offset);
      if (currentBytes.equals(replacement)) continue;
      if (!currentBytes.equals(expected)) throw new Error('repair target changed');
      await handle.write(replacement, 0, replacement.length, mutation.offset);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fileStamp(filePath) {
  const metadata = await stat(filePath);
  return { mtimeMs: metadata.mtimeMs };
}

function fileRefreshed(before, after) {
  return Boolean(after && (!before || after.mtimeMs > before.mtimeMs));
}

async function waitForFileRefresh(filePath, previousStamp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await fileStamp(filePath).catch(() => null);
    if (fileRefreshed(previousStamp, current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

function publicResult(status, details = {}) {
  return {
    status,
    ready: status === 'ok' || status === 'repaired',
    issues: details.issues ?? [],
    repairs: details.repairs ?? [],
    unresolved: details.unresolved ?? [],
  };
}

export async function enforceClashVergeAvailability({
  controller,
  guardrails,
  dryRun = true,
  platform = process.platform,
  supervisorState = {},
  now = () => Date.now(),
  resolveRunningExecutable = resolveClashVergeWindows,
  startExecutable = startClashVergeWindows,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!guardrails?.enabled || !guardrails.ensureClashVergeRunning) return publicResult('ok');
  if (platform !== 'win32') {
    return publicResult('blocked', {
      issues: ['clash-verge-autostart-unsupported'],
      unresolved: ['clash-verge-autostart-unsupported'],
    });
  }

  let executable;
  let runningExecutable;
  try {
    executable = validateClashVergeExecutable(guardrails.clashVergeExecutable);
    if (!await exists(executable)) throw new Error('configured executable does not exist');
    runningExecutable = await resolveRunningExecutable({ allowMissing: true });
  } catch {
    return publicResult('blocked', {
      issues: ['clash-verge-executable-unavailable'],
      unresolved: ['clash-verge-executable-unavailable'],
    });
  }

  if (runningExecutable) {
    if (!sameWindowsPath(runningExecutable, executable)) {
      return publicResult('blocked', {
        issues: ['clash-verge-executable-mismatch'],
        unresolved: ['clash-verge-executable-mismatch'],
      });
    }
    supervisorState.nextAttemptAtMs = 0;
    return publicResult('ok');
  }

  const issues = ['clash-verge-not-running'];
  if (!guardrails.autoRepair || dryRun) {
    return publicResult('would-repair', { issues, unresolved: issues });
  }

  const nowMs = now();
  if ((supervisorState.nextAttemptAtMs ?? 0) > nowMs) {
    const blockedIssues = [...issues, 'clash-verge-start-backoff'];
    return publicResult('blocked', { issues: blockedIssues, unresolved: blockedIssues });
  }
  try {
    await startExecutable(executable);
  } catch {
    supervisorState.nextAttemptAtMs = now() + (guardrails.clashVergeStartBackoffSeconds * 1000);
    const failedIssues = [...issues, 'clash-verge-start-failed'];
    return publicResult('blocked', { issues: failedIssues, unresolved: failedIssues });
  }

  const deadline = nowMs + (guardrails.clashVergeStartupTimeoutSeconds * 1000);
  let consecutiveReadyChecks = 0;
  do {
    try {
      const startedExecutable = await resolveRunningExecutable({ allowMissing: true });
      if (!startedExecutable) throw new Error('Clash Verge process is not ready');
      if (!sameWindowsPath(startedExecutable, executable)) {
        const mismatchIssues = [...issues, 'clash-verge-executable-mismatch'];
        return publicResult('blocked', { issues: mismatchIssues, unresolved: mismatchIssues });
      }
      await controller.getConfigs();
      consecutiveReadyChecks += 1;
      if (consecutiveReadyChecks >= 2) {
        supervisorState.nextAttemptAtMs = 0;
        return publicResult('repaired', {
          issues,
          repairs: ['clash-verge-started'],
        });
      }
    } catch {
      consecutiveReadyChecks = 0;
    }
    if (now() >= deadline) break;
    await wait(500);
  } while (true);

  supervisorState.nextAttemptAtMs = now() + (guardrails.clashVergeStartBackoffSeconds * 1000);
  const timeoutIssues = [...issues, 'clash-verge-startup-timeout'];
  return publicResult('blocked', { issues: timeoutIssues, unresolved: timeoutIssues });
}

export async function enforceRuntimeMode({ controller, expectedMode, autoRepair = true, dryRun = true } = {}) {
  try {
    const runtime = await controller.getConfigs();
    if (runtime?.mode === expectedMode) return publicResult('ok');
    if (!autoRepair || dryRun) {
      return publicResult('would-repair', {
        issues: ['runtime-mode'],
        unresolved: ['runtime-mode'],
      });
    }
    await controller.patchConfigs({ mode: expectedMode });
    if (!await runtimeModeIsExpected(controller, expectedMode)) throw new Error('mode verification failed');
    return publicResult('repaired', { issues: ['runtime-mode'], repairs: ['runtime-mode'] });
  } catch {
    return publicResult('blocked', {
      issues: ['controller-unreachable'],
      unresolved: ['controller-unreachable'],
    });
  }
}

async function readGuardState(stateFile) {
  if (!stateFile) return {};
  try {
    const parsed = JSON.parse(await readFile(stateFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('guard state must be an object');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeGuardState(stateFile, state) {
  if (!stateFile) throw new Error('guard state file is not configured');
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporary, stateFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function runtimeModeIsExpected(controller, expectedMode) {
  const runtime = await controller.getConfigs();
  return runtime?.mode === expectedMode;
}

const DNS_RETRY_BACKOFF_MS = 30_000;

function retryIsDue(pending, nowMs = Date.now()) {
  const retryAt = Date.parse(pending?.nextAttemptAt ?? '');
  return !Number.isFinite(retryAt) || retryAt <= nowMs;
}

function deferPendingRetry(pending, nowMs = Date.now()) {
  return {
    ...pending,
    attemptCount: (Number.isInteger(pending?.attemptCount) ? pending.attemptCount : 0) + 1,
    nextAttemptAt: new Date(nowMs + DNS_RETRY_BACKOFF_MS).toISOString(),
  };
}

export async function enforceGuardrails({
  controller,
  guardrails,
  guardStateFile,
  dryRun = true,
  platform = process.platform,
  env = process.env,
  restartClashVerge = restartClashVergeWindows,
} = {}) {
  if (!guardrails?.enabled) return publicResult('ok');
  const issues = new Set();
  const repairs = new Set();
  const unresolved = new Set();
  const canRepair = guardrails.autoRepair && !dryRun;
  const detect = (issue) => {
    issues.add(issue);
    unresolved.add(issue);
  };
  const resolve = (issue, repair = issue) => {
    unresolved.delete(issue);
    repairs.add(repair);
  };
  const result = (status) => publicResult(status, {
    issues: [...issues],
    repairs: [...repairs],
    unresolved: [...unresolved],
  });
  const finish = () => {
    if (unresolved.size > 0) return result(dryRun ? 'would-repair' : 'blocked');
    return result(repairs.size > 0 ? 'repaired' : 'ok');
  };

  const explicitAppDir = Boolean(guardrails.clashVergeAppDir);
  const controllerDescription = controller.describe?.() ?? {};
  const isClashVergePipe = controllerDescription.kind === 'pipe'
    && /verge-mihomo/i.test(controllerDescription.endpoint ?? '');

  // DNS 修复可能已经停止 GUI/Core，因而不能依赖 Controller 可达后才读取债务。
  // 先把持久化 phase 恢复到“已启动并等待 Controller 复核”，随后再检查运行模式。
  if (guardrails.disableClashVergeDnsOverride && (explicitAppDir || isClashVergePipe)) {
    const appDir = discoverClashVergeAppDir({
      configuredPath: guardrails.clashVergeAppDir,
      platform,
      env,
    });
    const vergePath = path.join(appDir, 'verge.yaml');
    const profilesPath = path.join(appDir, 'profiles.yaml');
    const runtimeConfigPath = path.join(appDir, 'clash-verge.yaml');
    if (appDir && await exists(vergePath) && await exists(profilesPath)) {
      try {
        const profileUid = await readTopLevelScalarFile(profilesPath, 'current');
        if (!profileUid) throw new Error('active profile missing');
        const guardState = await readGuardState(guardStateFile);
        let pendingReload = guardState.pendingDnsReload ?? null;
        if (pendingReload) {
          detect('dns-reload-pending');
          if (pendingReload.appDir !== appDir) {
            detect('guardrail-state-invalid');
            return finish();
          }
          let dns = await inspectDnsOverrideFile(vergePath, profileUid);
          const legacyBaseline = pendingReload.runtimeStamp ?? pendingReload.runtimeFingerprint ?? null;
          let phase = ['repair-required', 'reload-required'].includes(pendingReload.phase)
            ? pendingReload.phase
            : (dns.enabled || dns.globalEnabled ? 'repair-required' : 'reload-required');
          if (dns.enabled || dns.globalEnabled) {
            detect('dns-override');
            phase = 'repair-required';
          }
          pendingReload = { ...pendingReload, phase, runtimeStamp: legacyBaseline };
          guardState.pendingDnsReload = pendingReload;
          // 先确认当前 Controller 状态，但失败不能阻止使用持久债务恢复 GUI/Core。
          let controllerReachable = false;
          try {
            await controller.getConfigs();
            controllerReachable = true;
          } catch {
            controllerReachable = false;
          }
          const currentStamp = await fileStamp(runtimeConfigPath).catch(() => null);
          const reloadAlreadyObserved = phase === 'reload-required'
            && !dns.enabled
            && !dns.globalEnabled
            && fileRefreshed(legacyBaseline, currentStamp);

          if (reloadAlreadyObserved && controllerReachable) {
            // 文件与运行态都已恢复；保持债务到后续统一复核，且不重复重启 GUI。
          } else if (reloadAlreadyObserved && canRepair
              && guardrails.restartClashVergeOnDnsRepair && platform === 'win32') {
            if (!retryIsDue(pendingReload)) {
              detect('dns-repair-backoff');
            } else {
              const customRestart = restartClashVerge !== restartClashVergeWindows;
              let executable = pendingReload.executable ?? null;
              try {
                if (customRestart) {
                  const restartResult = await restartClashVerge();
                  if (restartResult !== true) throw new Error('Clash Verge recovery failed');
                  repairs.add('clash-verge-restarted');
                } else {
                  executable ??= await resolveClashVergeWindows({ allowMissing: true });
                  await ensureClashVergeRunningWindows(executable);
                  repairs.add('clash-verge-running');
                }
                pendingReload = {
                  ...pendingReload,
                  executable,
                  nextAttemptAt: new Date(Date.now() + DNS_RETRY_BACKOFF_MS).toISOString(),
                };
                guardState.pendingDnsReload = pendingReload;
                await writeGuardState(guardStateFile, guardState);
              } catch {
                pendingReload = deferPendingRetry({ ...pendingReload, executable });
                guardState.pendingDnsReload = pendingReload;
                await writeGuardState(guardStateFile, guardState).catch(() => {});
                detect('clash-verge-reload-failed');
              }
            }
          } else if (canRepair && guardrails.restartClashVergeOnDnsRepair && platform === 'win32') {
            if (!retryIsDue(pendingReload)) {
              detect('dns-repair-backoff');
            } else {
              const customRestart = restartClashVerge !== restartClashVergeWindows;
              let executable = pendingReload.executable ?? null;
              let appWasStopped = false;
              try {
                if (phase === 'repair-required') {
                  if (!customRestart) {
                    executable = await stopClashVergeIfRunningWindows(executable);
                    appWasStopped = true;
                  }
                  const freshDns = await inspectDnsOverrideFile(vergePath, profileUid);
                  if (freshDns.enabled || freshDns.globalEnabled) {
                    if (freshDns.mutations.length === 0) throw new Error('dns override changed before repair');
                    await applyFixedMutations(vergePath, freshDns.mutations, freshDns.metadata);
                    repairs.add('dns-override-persisted');
                  }
                  dns = await inspectDnsOverrideFile(vergePath, profileUid);
                  if (dns.enabled || dns.globalEnabled) {
                    throw new Error('dns override repair was not persisted');
                  }
                }

                pendingReload = {
                  ...pendingReload,
                  phase: 'reload-required',
                  executable,
                  runtimeStamp: await fileStamp(runtimeConfigPath).catch(() => null),
                  nextAttemptAt: null,
                };
                guardState.pendingDnsReload = pendingReload;
                await writeGuardState(guardStateFile, guardState);

                const restartResult = customRestart
                  ? await restartClashVerge()
                  : await restartClashVergeWindows(executable);
                appWasStopped = false;
                if (restartResult !== true) throw new Error('Clash Verge restart failed');
                const refreshed = await waitForFileRefresh(runtimeConfigPath, pendingReload.runtimeStamp);
                const persisted = await inspectDnsOverrideFile(vergePath, profileUid);
                if (!refreshed || persisted.enabled || persisted.globalEnabled) {
                  throw new Error('runtime config was not refreshed');
                }
                pendingReload = {
                  ...pendingReload,
                  nextAttemptAt: new Date(Date.now() + DNS_RETRY_BACKOFF_MS).toISOString(),
                };
                guardState.pendingDnsReload = pendingReload;
                await writeGuardState(guardStateFile, guardState);
                repairs.add('clash-verge-restarted');
              } catch {
                pendingReload = deferPendingRetry({
                  ...pendingReload,
                  executable,
                  phase: dns.enabled || dns.globalEnabled ? 'repair-required' : 'reload-required',
                });
                guardState.pendingDnsReload = pendingReload;
                await writeGuardState(guardStateFile, guardState).catch(() => {});
                if (!customRestart && executable && appWasStopped) {
                  await ensureClashVergeRunningWindows(executable).catch(() => {});
                }
                detect('clash-verge-reload-failed');
              }
            }
          } else if (canRepair) {
            detect('dns-repair-unsupported');
          }
        }
      } catch {
        detect('clash-verge-config-invalid');
        return finish();
      }
    }
  }

  let runtime;
  try {
    runtime = await controller.getConfigs();
  } catch {
    detect('controller-unreachable');
    return result('blocked');
  }
  if (runtime?.mode !== guardrails.expectedRuntimeMode) {
    detect('runtime-mode');
    if (canRepair) {
      try {
        await controller.patchConfigs({ mode: guardrails.expectedRuntimeMode });
        if (!await runtimeModeIsExpected(controller, guardrails.expectedRuntimeMode)) {
          throw new Error('mode verification failed');
        }
        resolve('runtime-mode');
      } catch {
        return result('blocked');
      }
    }
  }

  if (guardrails.disableClashVergeDnsOverride && (explicitAppDir || isClashVergePipe)) {
    const appDir = discoverClashVergeAppDir({
      configuredPath: guardrails.clashVergeAppDir,
      platform,
      env,
    });
    const vergePath = path.join(appDir, 'verge.yaml');
    const profilesPath = path.join(appDir, 'profiles.yaml');
    const runtimeConfigPath = path.join(appDir, 'clash-verge.yaml');
    if (!appDir || !await exists(vergePath) || !await exists(profilesPath)) {
      detect('clash-verge-config-unavailable');
    } else {
      try {
        const profileUid = await readTopLevelScalarFile(profilesPath, 'current');
        if (!profileUid) throw new Error('active profile missing');
        let guardState;
        try {
          guardState = await readGuardState(guardStateFile);
        } catch {
          detect('guardrail-state-invalid');
          return finish();
        }

        const customRestart = restartClashVerge !== restartClashVergeWindows;
        let dns = await inspectDnsOverrideFile(vergePath, profileUid);
        let pendingReload = guardState.pendingDnsReload ?? null;

        if (pendingReload && pendingReload.appDir !== appDir) {
          detect('guardrail-state-invalid');
          return finish();
        }
        if (pendingReload) {
          detect('dns-reload-pending');
          const legacyBaseline = pendingReload.runtimeStamp ?? pendingReload.runtimeFingerprint ?? null;
          const phase = ['repair-required', 'reload-required'].includes(pendingReload.phase)
            ? pendingReload.phase
            : (dns.enabled || dns.globalEnabled ? 'repair-required' : 'reload-required');
          pendingReload = { ...pendingReload, phase, runtimeStamp: legacyBaseline };

          if (phase === 'reload-required' && !dns.enabled && !dns.globalEnabled) {
            const currentStamp = await fileStamp(runtimeConfigPath).catch(() => null);
            if (fileRefreshed(legacyBaseline, currentStamp)
                && await runtimeModeIsExpected(controller, guardrails.expectedRuntimeMode)) {
              if (dryRun) return finish();
              delete guardState.pendingDnsReload;
              await writeGuardState(guardStateFile, guardState);
              resolve('dns-reload-pending', 'dns-reload-confirmed');
              return repairs.has('clash-verge-restarted')
                ? result('repaired-restart')
                : finish();
            }
          }
        }

        if (dns.enabled || dns.globalEnabled) {
          detect('dns-override');
          if (pendingReload?.phase === 'reload-required') {
            pendingReload = { ...pendingReload, phase: 'repair-required' };
            guardState.pendingDnsReload = pendingReload;
            if (!dryRun) await writeGuardState(guardStateFile, guardState);
          }
        }

        if (!pendingReload && (dns.enabled || dns.globalEnabled) && canRepair) {
          if (!guardrails.restartClashVergeOnDnsRepair || platform !== 'win32') {
            detect('dns-repair-unsupported');
            return result('blocked');
          }
          const executable = customRestart ? null : await resolveClashVergeWindows();
          pendingReload = {
            kind: 'dns-reload-required',
            phase: 'repair-required',
            appDir,
            executable,
            createdAt: new Date().toISOString(),
            runtimeStamp: await fileStamp(runtimeConfigPath).catch(() => null),
            attemptCount: 0,
          };
          guardState.pendingDnsReload = pendingReload;
          await writeGuardState(guardStateFile, guardState);
          detect('dns-reload-pending');
        }

        if (pendingReload) {
          if (!canRepair) return finish();
          if (!guardrails.restartClashVergeOnDnsRepair || platform !== 'win32') {
            detect('dns-repair-unsupported');
            return result('blocked');
          }
          if (!retryIsDue(pendingReload)) {
            detect('dns-repair-backoff');
            return result('blocked');
          }

          let executable = pendingReload.executable ?? null;
          let appWasStopped = false;
          try {
            if (dns.enabled || dns.globalEnabled || pendingReload.phase === 'repair-required') {
              if (!customRestart) {
                executable = await stopClashVergeIfRunningWindows(executable);
                appWasStopped = true;
              }
              const freshDns = await inspectDnsOverrideFile(vergePath, profileUid);
              if (freshDns.enabled || freshDns.globalEnabled) {
                if (freshDns.mutations.length === 0) throw new Error('dns override changed before repair');
                await applyFixedMutations(vergePath, freshDns.mutations, freshDns.metadata);
                repairs.add('dns-override-persisted');
              }
              dns = await inspectDnsOverrideFile(vergePath, profileUid);
              if (dns.enabled || dns.globalEnabled) throw new Error('dns override repair was not persisted');
              pendingReload = {
                ...pendingReload,
                phase: 'reload-required',
                executable,
                runtimeStamp: await fileStamp(runtimeConfigPath).catch(() => null),
                nextAttemptAt: null,
              };
              guardState.pendingDnsReload = pendingReload;
              await writeGuardState(guardStateFile, guardState);
            } else {
              pendingReload = {
                ...pendingReload,
                phase: 'reload-required',
                runtimeStamp: await fileStamp(runtimeConfigPath).catch(() => null),
                nextAttemptAt: null,
              };
              guardState.pendingDnsReload = pendingReload;
              await writeGuardState(guardStateFile, guardState);
            }

            const restartResult = customRestart
              ? await restartClashVerge()
              : await restartClashVergeWindows(executable);
            appWasStopped = false;
            if (restartResult !== true) throw new Error('Clash Verge restart failed');
            const refreshed = await waitForFileRefresh(runtimeConfigPath, pendingReload.runtimeStamp);
            const persisted = await inspectDnsOverrideFile(vergePath, profileUid);
            if (!refreshed || persisted.enabled || persisted.globalEnabled
                || !await runtimeModeIsExpected(controller, guardrails.expectedRuntimeMode)) {
              throw new Error('runtime config was not refreshed');
            }

            delete guardState.pendingDnsReload;
            await writeGuardState(guardStateFile, guardState);
            if (issues.has('dns-override')) resolve('dns-override', 'dns-override-reloaded');
            resolve('dns-reload-pending', 'dns-reload-confirmed');
            repairs.add('clash-verge-restarted');
            return result('repaired-restart');
          } catch {
            pendingReload = deferPendingRetry({
              ...pendingReload,
              executable,
              phase: dns.enabled || dns.globalEnabled ? 'repair-required' : 'reload-required',
            });
            guardState.pendingDnsReload = pendingReload;
            await writeGuardState(guardStateFile, guardState).catch(() => {});
            if (!customRestart && executable && appWasStopped) {
              await ensureClashVergeRunningWindows(executable).catch(() => {});
            }
            detect('clash-verge-reload-failed');
            return result('blocked');
          }
        }
      } catch {
        detect('clash-verge-config-invalid');
      }
    }
  }

  return finish();
}
