#!/usr/bin/env node
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { MihomoController } from './controller.mjs';
import {
  enforceClashVergeAvailability,
  enforceGuardrails,
  enforceRuntimeMode,
} from './guardrails.mjs';
import { probeRealLinks } from './link-probe.mjs';
import { buildStatusSnapshot, createRotatingLogger, formatStatus } from './observability.mjs';
import { Watchdog } from './watchdog.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = {
    config: path.join(projectRoot, 'config.json'),
    run: false,
    apply: false,
    forceScan: false,
    quiet: false,
    status: false,
    statusJson: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') options.config = argv[++index];
    else if (arg === '--run') options.run = true;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--force-scan') options.forceScan = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--status') options.status = true;
    else if (arg === '--status-json') options.statusJson = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Mihomo Route Sentinel

用法:
  node src/cli.mjs [--config config.json] [--run] [--apply] [--force-scan]
  node src/cli.mjs [--config config.json] --status
  node src/cli.mjs [--config config.json] --status-json

默认只执行一次 Dry Run，不会切换节点。
  --run         持续监控
  --apply       允许真实切换
  --force-scan  即使当前节点健康也扫描候选节点
  --quiet       仅写入日志文件
  --status      输出可读运行状态，不启动守护进程
  --status-json 输出 JSON 运行状态，不启动守护进程`);
}

async function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireLock(lockFile) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  try {
    const handle = await open(lockFile, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    return async () => { await handle.close(); await unlink(lockFile).catch(() => {}); };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const oldPid = Number.parseInt(await readFile(lockFile, 'utf8').catch(() => ''), 10);
    if (await isPidAlive(oldPid)) throw new Error(`Watchdog 已在运行（PID ${oldPid}）`);
    await unlink(lockFile).catch(() => {});
    return acquireLock(lockFile);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const runtime = {
    version: packageMetadata.version,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const config = await loadConfig(options.config);
  if (options.status || options.statusJson) {
    if (options.run || options.apply || options.forceScan) {
      throw new Error('--status/--status-json 不能与 --run、--apply 或 --force-scan 同时使用');
    }
    const controller = new MihomoController(config.controller);
    const snapshot = await buildStatusSnapshot({
      probes: config.probes,
      stateFile: config.files.state,
      logFile: config.files.log,
      controller,
      targetGroup: config.groups.target,
      policy: config.policy,
      retainedFiles: config.logging.retainedFiles,
    });
    console.log(options.statusJson ? JSON.stringify(snapshot, null, 2) : formatStatus(snapshot));
    return;
  }
  const releaseLock = await acquireLock(config.files.lock);
  const logger = createRotatingLogger(config.files.log, {
    quiet: options.quiet,
    maxBytes: config.logging?.maxBytes,
    retainedFiles: config.logging?.retainedFiles,
  });
  const controller = new MihomoController(config.controller);
  // null 强制首轮独立检查落日志，状态页才能证明 5 秒守卫确实在运行。
  let lastProcessGuardSignature = null;
  let lastRuntimeGuardStatus = null;
  // 进程/运行模式守卫与 DNS 修复共享队列，避免 DNS 原位修改期间被进程守卫提前拉起客户端。
  let guardQueue = Promise.resolve();
  const enqueueGuard = (execute) => {
    const next = guardQueue.then(execute, execute);
    guardQueue = next.catch(() => {});
    return next;
  };
  const clashVergeSupervisorState = {};
  const runRuntimeGuard = () => enqueueGuard(async () => {
      const processGuard = await enforceClashVergeAvailability({
        controller,
        guardrails: config.guardrails,
        dryRun: !options.apply,
        supervisorState: clashVergeSupervisorState,
      });
      const processGuardSignature = JSON.stringify({
        status: processGuard.status,
        issues: processGuard.issues,
        unresolved: processGuard.unresolved,
      });
      if (processGuardSignature !== lastProcessGuardSignature || processGuard.repairs.length > 0) {
        await logger(
          processGuard.ready ? 'info' : 'warn',
          'clash-verge-process-guard-evaluated',
          processGuard,
        );
      }
      lastProcessGuardSignature = processGuardSignature;
      if (!processGuard.ready) return processGuard;

      const runtimeGuard = await enforceRuntimeMode({
        controller,
        expectedMode: config.guardrails.expectedRuntimeMode,
        autoRepair: config.guardrails.autoRepair,
        dryRun: !options.apply,
      });
      if (runtimeGuard.status !== 'ok' || lastRuntimeGuardStatus !== runtimeGuard.status) {
        await logger(
          runtimeGuard.ready ? 'info' : 'warn',
          'runtime-mode-guard-evaluated',
          runtimeGuard,
        );
      }
      lastRuntimeGuardStatus = runtimeGuard.status;
      return runtimeGuard;
  });
  const watchdog = new Watchdog({
    controller,
    config,
    logger,
    runtime,
    beforeSwitch: async () => {
      if (!config.guardrails.enabled) return;
      const runtimeGuard = await runRuntimeGuard();
      if (!runtimeGuard.ready) {
        const error = new Error('运行模式守卫未就绪，禁止节点切换');
        error.code = 'GUARDRAIL_BLOCKED';
        throw error;
      }
    },
  });
  await logger('info', 'watchdog-started', {
    runtime,
    mode: options.run ? 'continuous' : 'once',
    apply: options.apply,
    controller: controller.describe(),
  });

  if (config.guardrails.enabled) {
    try {
      await runRuntimeGuard();
    } catch (error) {
      await logger('error', 'runtime-guard-initialization-failed', {
        errorType: error?.name ?? 'Error',
      });
    }
  }

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    await logger('info', 'watchdog-stopping', { signal });
    await releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  const runtimeGuardTimer = options.run && options.apply && config.guardrails.enabled
    ? setInterval(async () => {
        if (stopping) return;
        try {
          await runRuntimeGuard();
        } catch (error) {
          // 定时守卫不能产生未处理的 Promise 拒绝；失败状态会在切换前再次核验并保持 fail-closed。
          await logger('error', 'runtime-mode-guard-failed', {
            errorType: error?.name ?? 'Error',
          });
        }
      }, config.guardrails.runtimeModeCheckIntervalSeconds * 1000)
    : null;
  runtimeGuardTimer?.unref();

  try {
    do {
      const cycleStartedAt = Date.now();
      let backgroundWake = null;
      try {
        const guardrail = await enqueueGuard(() => enforceGuardrails({
          controller,
          guardrails: config.guardrails,
          guardStateFile: config.files.guardrailState,
          dryRun: !options.apply,
        }));
        await logger(guardrail.ready ? 'info' : 'warn', 'guardrail-evaluated', guardrail);
        if (!guardrail.ready) {
          await logger('warn', 'watchdog-cycle-completed', { status: guardrail.status });
        } else {
          let linkTelemetry = null;
          if (config.telemetry?.enabled) {
            try {
              linkTelemetry = await probeRealLinks(config.telemetry);
              await logger('info', 'link-telemetry', { metrics: linkTelemetry });
            } catch (error) {
              // 遥测只提供辅助信号；任何意外都不能阻断节点健康检查与故障恢复。
              linkTelemetry = { enabled: true, error: 'telemetry-cycle-error' };
              await logger('warn', 'link-telemetry-failed', { errorType: error?.name ?? 'Error' });
            }
          }
          const result = await watchdog.runOnce({
            dryRun: !options.apply,
            forceScan: options.forceScan,
            linkTelemetry,
            backgroundScan: options.run,
          });
          backgroundWake = result.backgroundWake ?? null;
          await logger('info', 'watchdog-cycle-completed', { status: result.status });
        }
      } catch (error) {
        let recoveredController = false;
        if (options.run && config.guardrails.enabled && error?.code === 'ENOENT') {
          try {
            const recovery = await runRuntimeGuard();
            recoveredController = recovery.ready;
          } catch {
            recoveredController = false;
          }
        }
        if (recoveredController) {
          await logger('warn', 'watchdog-cycle-interrupted-by-client-restart', {
            errorType: error?.code ?? error?.name ?? 'Error',
          });
        } else {
          await logger('error', 'watchdog-cycle-failed', { error: error.message });
        }
        if (!options.run) throw error;
      }
      if (!options.run || stopping) break;
      const cycleElapsedMs = Date.now() - cycleStartedAt;
      const waitMs = Math.max(0, (config.policy.intervalSeconds * 1000) - cycleElapsedMs);
      if (waitMs > 0) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, waitMs);
          if (backgroundWake) {
            backgroundWake.finally(() => {
              clearTimeout(timer);
              resolve();
            });
          }
        });
      }
    } while (!stopping);
  } finally {
    if (runtimeGuardTimer) clearInterval(runtimeGuardTimer);
    if (!stopping) await releaseLock();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
