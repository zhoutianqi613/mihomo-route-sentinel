import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyFixedMutations,
  ensureGuardrailBackup,
  inspectDnsOverrideFile,
  readTopLevelScalarFile,
  restoreGuardrailBackup,
  validateClashVergeAppDir,
} from './dns-config.mjs';
import {
  discoverClashVergeAppDir,
  ensureClashVergeRunningWindows,
  fileRefreshed,
  fileStamp,
  pathExists,
  resolveClashVergeWindows,
  restartClashVergeWindows,
  sameWindowsPath,
  startClashVergeWindows,
  stopClashVergeIfRunningWindows,
  validateClashVergeExecutable,
  waitForFileRefresh,
} from './clash-verge-process.mjs';
import {
  DNS_RETRY_BACKOFF_MS,
  appendGuardAudit,
  deferPendingRetry,
  readGuardState,
  recordDnsBackup,
  retryIsDue,
  rollbackPendingDnsReload,
  writeGuardState,
} from './guard-journal.mjs';
import { runtimeModeIsExpected } from './runtime-mode.mjs';

// DNS 配置读写、进程控制、运行模式与 guard journal 已拆到独立模块；
// 这里保持原有对外导出不变，避免 cli 与既有测试改动。
export {
  disableClashVergeDnsOverride,
  inspectClashVergeDnsOverride,
  replaceTopLevelScalar,
} from './dns-config.mjs';
export { restoreGuardrailBackup, validateClashVergeAppDir };
export { discoverClashVergeAppDir };
export { enforceRuntimeMode } from './runtime-mode.mjs';

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
    if (!await pathExists(executable)) throw new Error('configured executable does not exist');
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

/**
 * DNS 修复复核失败后的自动回滚：用最近备份原子恢复 verge.yaml，
 * 审计事件写入 guard journal，债务回到 repair-required 并退避。
 * 恢复失败不吞错：记录原因并把错误返回给调用方。
 */
async function rollbackDnsRepair({
  guardState,
  guardStateFile,
  vergePath,
  backup,
  pendingReload,
  reason,
  failure,
  restoreBackup = restoreGuardrailBackup,
}) {
  const at = new Date().toISOString();
  const record = {
    event: 'dns-repair-rollback',
    at,
    reason,
    failure: failure ? String(failure.message ?? failure) : null,
    backupPath: backup?.path ?? null,
    backupSha256: backup?.sha256 ?? null,
    restoreRequired: true,
    restored: false,
    restoreError: null,
  };
  let restoreError = null;
  if (!backup?.path) {
    restoreError = new Error('缺少可用于回滚的配置备份');
  } else {
    // 配置未实际改动时无需覆盖用户文件；此时恢复动作视为已完成。
    let unchanged = false;
    try {
      const [currentBytes, backupBytes] = await Promise.all([
        readFile(vergePath),
        readFile(backup.path),
      ]);
      unchanged = currentBytes.equals(backupBytes);
    } catch {
      unchanged = false;
    }
    if (unchanged) {
      record.restoreRequired = false;
      record.restored = true;
    } else {
      try {
        await restoreBackup(backup.path, vergePath);
        record.restored = true;
      } catch (error) {
        restoreError = error;
        record.restoreError = error?.message ?? String(error);
      }
    }
  }
  if (restoreError && !record.restoreError) record.restoreError = restoreError.message;
  guardState.dnsRepairRollback = record;
  appendGuardAudit(guardState, record);
  // 回滚后 override 重新出现，债务回到待修复并退避，交给后续周期重试。
  guardState.pendingDnsReload = rollbackPendingDnsReload(pendingReload, at);
  try {
    await writeGuardState(guardStateFile, guardState);
  } catch (error) {
    record.auditWriteError = error?.message ?? String(error);
  }
  return { record, restoreError };
}

export async function enforceGuardrails({
  controller,
  guardrails,
  guardStateFile,
  dryRun = true,
  platform = process.platform,
  env = process.env,
  restartClashVerge = restartClashVergeWindows,
  restoreBackup = restoreGuardrailBackup,
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
  // DNS 修复后的重启等待上限：客户端/管道需在配置的启动超时内就绪，否则视为复核失败。
  const dnsStartupTimeoutMs = Math.max(1, (guardrails.clashVergeStartupTimeoutSeconds ?? 20) * 1000);

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
    // 目录不可信时既不读也不写用户配置：直接 blocked，等待人工确认。
    try {
      await validateClashVergeAppDir(appDir);
    } catch (error) {
      if (error?.code !== 'GUARDRAIL_DIR_UNTRUSTED') throw error;
      detect('clash-verge-appdir-untrusted');
      return { ...result('blocked'), code: error.code, guardrailReason: error.reason };
    }
    if (appDir && await pathExists(vergePath) && await pathExists(profilesPath)) {
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
              let dnsBackup = null;
              try {
                if (phase === 'repair-required') {
                  if (!customRestart) {
                    executable = await stopClashVergeIfRunningWindows(executable);
                    appWasStopped = true;
                  }
                  const freshDns = await inspectDnsOverrideFile(vergePath, profileUid);
                  if (freshDns.enabled || freshDns.globalEnabled) {
                    if (freshDns.mutations.length === 0) throw new Error('dns override changed before repair');
                    // 先确保备份存在再写配置：即使写入中途失败，回滚也有完整原文。
                    dnsBackup = await ensureGuardrailBackup(vergePath);
                    await applyFixedMutations(vergePath, freshDns.mutations, freshDns.metadata);
                    recordDnsBackup(guardState, dnsBackup);
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
                  ...(dnsBackup ? { dnsBackup } : {}),
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
                const refreshed = await waitForFileRefresh(
                  runtimeConfigPath, pendingReload.runtimeStamp, dnsStartupTimeoutMs,
                );
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
              } catch (error) {
                if (dnsBackup) {
                  // 修复已落盘但重启/复核失败：自动回滚到备份，避免留下半修状态。
                  const rollback = await rollbackDnsRepair({
                    guardState,
                    guardStateFile,
                    vergePath,
                    backup: dnsBackup,
                    pendingReload,
                    reason: error?.message ?? 'dns repair verification failed',
                    failure: error,
                    restoreBackup,
                  });
                  repairs.delete('dns-override-persisted');
                  if (!customRestart && executable && appWasStopped) {
                    await ensureClashVergeRunningWindows(executable).catch(() => {});
                  }
                  if (rollback.restoreError) {
                    detect('dns-repair-rollback');
                    detect('dns-repair-rollback-failed');
                    return {
                      ...result('error'),
                      rollback: rollback.record,
                      backupPath: rollback.record.backupPath,
                    };
                  }
                  detect('dns-repair-rollback');
                  return { ...result('blocked'), rollback: rollback.record };
                }
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
    // 目录不可信时既不读也不写用户配置：直接 blocked，等待人工确认。
    try {
      await validateClashVergeAppDir(appDir);
    } catch (error) {
      if (error?.code !== 'GUARDRAIL_DIR_UNTRUSTED') throw error;
      detect('clash-verge-appdir-untrusted');
      return { ...result('blocked'), code: error.code, guardrailReason: error.reason };
    }
    if (!appDir || !await pathExists(vergePath) || !await pathExists(profilesPath)) {
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
          let dnsBackup = null;
          try {
            if (dns.enabled || dns.globalEnabled || pendingReload.phase === 'repair-required') {
              if (!customRestart) {
                executable = await stopClashVergeIfRunningWindows(executable);
                appWasStopped = true;
              }
              const freshDns = await inspectDnsOverrideFile(vergePath, profileUid);
              if (freshDns.enabled || freshDns.globalEnabled) {
                if (freshDns.mutations.length === 0) throw new Error('dns override changed before repair');
                // 先确保备份存在再写配置：即使写入中途失败，回滚也有完整原文。
                dnsBackup = await ensureGuardrailBackup(vergePath);
                await applyFixedMutations(vergePath, freshDns.mutations, freshDns.metadata);
                recordDnsBackup(guardState, dnsBackup);
                repairs.add('dns-override-persisted');
              }
              dns = await inspectDnsOverrideFile(vergePath, profileUid);
              if (dns.enabled || dns.globalEnabled) throw new Error('dns override repair was not persisted');
              pendingReload = {
                ...pendingReload,
                phase: 'reload-required',
                executable,
                ...(dnsBackup ? { dnsBackup } : {}),
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
            const refreshed = await waitForFileRefresh(
              runtimeConfigPath, pendingReload.runtimeStamp, dnsStartupTimeoutMs,
            );
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
          } catch (error) {
            if (dnsBackup) {
              // 修复已落盘但重启/复核失败：自动回滚到备份，避免留下半修状态。
              const rollback = await rollbackDnsRepair({
                guardState,
                guardStateFile,
                vergePath,
                backup: dnsBackup,
                pendingReload,
                reason: error?.message ?? 'dns repair verification failed',
                failure: error,
                restoreBackup,
              });
              repairs.delete('dns-override-persisted');
              if (!customRestart && executable && appWasStopped) {
                await ensureClashVergeRunningWindows(executable).catch(() => {});
              }
              if (rollback.restoreError) {
                detect('dns-repair-rollback');
                detect('dns-repair-rollback-failed');
                return {
                  ...result('error'),
                  rollback: rollback.record,
                  backupPath: rollback.record.backupPath,
                };
              }
              detect('dns-repair-rollback');
              return { ...result('blocked'), rollback: rollback.record };
            }
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
