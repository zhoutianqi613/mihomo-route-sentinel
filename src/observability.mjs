import { appendFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOGGING = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  retainedFiles: 14,
});

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|passwd|secret|token|api[-_]?key|proxy[-_]?authorization)/i;

function redactString(value, redactValues) {
  let result = value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
    .replace(/([?&](?:access_token|api_key|key|secret|token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, '$1[REDACTED]@');
  for (const secret of redactValues) {
    if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function redactSensitive(value, { redactValues = [] } = {}, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value, redactValues);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, { redactValues }, seen));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : redactSensitive(item, { redactValues }, seen);
  }
  return output;
}

async function moveReplacing(source, destination) {
  const sourceExists = await stat(source).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (!sourceExists) return;
  await unlink(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rename(source, destination);
}

export async function rotateLog(logFile, retainedFiles = DEFAULT_LOGGING.retainedFiles) {
  const retained = Math.max(0, Math.trunc(retainedFiles));
  if (retained === 0) {
    await unlink(logFile).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return;
  }
  await unlink(`${logFile}.${retained}`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  for (let index = retained - 1; index >= 1; index -= 1) {
    await moveReplacing(`${logFile}.${index}`, `${logFile}.${index + 1}`);
  }
  await moveReplacing(logFile, `${logFile}.1`);
}

export function createRotatingLogger(logFile, {
  quiet = false,
  maxBytes = DEFAULT_LOGGING.maxBytes,
  retainedFiles = DEFAULT_LOGGING.retainedFiles,
  redactValues = [],
  output = console.log,
} = {}) {
  const sizeLimit = Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.trunc(maxBytes)
    : DEFAULT_LOGGING.maxBytes;
  const retained = Number.isFinite(retainedFiles) && retainedFiles >= 0
    ? Math.trunc(retainedFiles)
    : DEFAULT_LOGGING.retainedFiles;
  let pending = Promise.resolve();

  return async (level, event, details = {}) => {
    const safeDetails = redactSensitive(details, { redactValues });
    const record = {
      ...safeDetails,
      timestamp: new Date().toISOString(),
      level: redactString(String(level), redactValues),
      event: redactString(String(event), redactValues),
    };
    const line = `${JSON.stringify(record)}\n`;
    pending = pending.then(async () => {
      await mkdir(path.dirname(logFile), { recursive: true });
      const currentSize = await stat(logFile).then((value) => value.size).catch((error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > sizeLimit) {
        await rotateLog(logFile, retained);
      }
      await appendFile(logFile, line, 'utf8');
      if (!quiet) {
        const suffix = Object.keys(safeDetails).length ? ` ${JSON.stringify(safeDetails)}` : '';
        output(`[${record.timestamp}] ${record.level.toUpperCase()} ${record.event}${suffix}`);
      }
    });
    return pending;
  };
}

async function readNdjsonTail(logFile, maxBytes) {
  let handle;
  try {
    handle = await open(logFile, 'r');
    const metadata = await handle.stat();
    const bytes = Math.min(metadata.size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, metadata.size - bytes);
    let text = buffer.toString('utf8');
    if (metadata.size > bytes) text = text.slice(text.indexOf('\n') + 1);
    const records = [];
    const warnings = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try { records.push(JSON.parse(line)); } catch { warnings.push('日志包含无法解析的 NDJSON 记录'); }
    }
    return { exists: true, records, warnings: [...new Set(warnings)], bytes };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, records: [], warnings: [], bytes: 0 };
    return { exists: true, records: [], warnings: [`读取日志失败：${error.message}`], bytes: 0 };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readRecentNdjson(logFile, {
  limit = 200,
  maxBytes = 1024 * 1024,
  retainedFiles = DEFAULT_LOGGING.retainedFiles,
} = {}) {
  let records = [];
  let consumedBytes = 0;
  let foundFile = false;
  const warnings = [];
  for (let index = 0; index <= retainedFiles && records.length < limit && consumedBytes < maxBytes; index += 1) {
    const candidate = index === 0 ? logFile : `${logFile}.${index}`;
    const result = await readNdjsonTail(candidate, maxBytes - consumedBytes);
    foundFile ||= result.exists;
    consumedBytes += result.bytes;
    records = [...result.records, ...records];
    warnings.push(...result.warnings);
  }
  if (!foundFile) warnings.push('日志文件不存在');
  return { records: records.slice(-limit), warnings: [...new Set(warnings)] };
}

async function readStateSafely(stateFile) {
  try {
    return { state: JSON.parse(await readFile(stateFile, 'utf8')), warnings: [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: {}, warnings: ['状态文件不存在'] };
    if (error instanceof SyntaxError) return { state: {}, warnings: ['状态文件已损坏，无法解析'] };
    return { state: {}, warnings: [`读取状态失败：${error.message}`] };
  }
}

function latestByEvent(records, event) {
  return records.findLast((record) => record?.event === event) ?? null;
}

const GUARDRAIL_ISSUE_TEXT = Object.freeze({
  'controller-unreachable': 'Mihomo Controller 不可达',
  'runtime-mode': '运行模式不符合预期',
  'clash-verge-config-unavailable': 'Clash Verge 配置目录不可用',
  'clash-verge-config-invalid': 'Clash Verge 配置格式无效或发生并发修改',
  'guardrail-state-invalid': '配置守卫状态文件无效',
  'dns-override': '当前订阅启用了 DNS 覆写',
  'dns-repair-unsupported': '当前平台不支持安全自动修复 DNS 覆写',
  'dns-reload-pending': 'DNS 修复正在等待客户端重载确认',
  'clash-verge-reload-failed': 'Clash Verge 重载或运行态复核失败',
  'clash-verge-autostart-unsupported': '当前平台不支持自动启动 Clash Verge',
  'clash-verge-executable-unavailable': 'Clash Verge 可执行文件不可用',
  'clash-verge-executable-mismatch': '正在运行的 Clash Verge 与配置路径不一致',
  'clash-verge-not-running': 'Clash Verge 未运行',
  'clash-verge-start-backoff': 'Clash Verge 自动启动正在退避',
  'clash-verge-start-failed': 'Clash Verge 自动启动失败',
  'clash-verge-startup-timeout': 'Clash Verge 启动后 Controller 未在限时内就绪',
});

function explainGuardrailIssue(issue) {
  return GUARDRAIL_ISSUE_TEXT[issue] ? `${GUARDRAIL_ISSUE_TEXT[issue]}(${issue})` : issue;
}

function telemetryForEvaluation(records, evaluation) {
  if (!evaluation) return latestByEvent(records, 'link-telemetry');
  const evaluationTimestamp = Date.parse(evaluation.timestamp);
  if (Number.isFinite(evaluationTimestamp)) {
    return records.findLast((record) => (
      record?.event === 'link-telemetry'
      && Number.isFinite(Date.parse(record.timestamp))
      && Date.parse(record.timestamp) <= evaluationTimestamp
    )) ?? null;
  }
  const evaluationIndex = records.lastIndexOf(evaluation);
  return records.slice(0, Math.max(0, evaluationIndex)).findLast(
    (record) => record?.event === 'link-telemetry',
  ) ?? null;
}

function activeQuarantines(entries) {
  const now = Date.now();
  return Object.entries(entries ?? {}).flatMap(([node, entry]) => {
    const untilMs = Date.parse(entry?.until);
    if (!Number.isFinite(untilMs) || untilMs <= now) return [];
    return [{ node, until: entry.until, reason: entry.reason ?? null }];
  });
}

function normalizePolicyState(state, policy = {}) {
  const windowSeconds = policy.switchBudgetWindowSeconds ?? null;
  const cutoff = windowSeconds === null ? null : Date.now() - (windowSeconds * 1000);
  const timestampOf = (entry) => typeof entry === 'string' ? entry : entry?.timestamp;
  const switchHistory = Array.isArray(state.switchHistory)
    ? state.switchHistory.filter((entry) => {
        const parsed = Date.parse(timestampOf(entry));
        return Number.isFinite(parsed) && (cutoff === null || parsed > cutoff);
      })
    : [];
  // 与核心策略一致：恢复性回滚用于审计，但不消耗切换预算；旧版字符串记录仍计入。
  const budgetHistory = switchHistory.filter((entry) => (
    typeof entry === 'string' || (entry.kind !== 'recovery-rollback' && entry.budgetExempt !== true)
  ));
  const used = state.switchesInWindow ?? budgetHistory.length;
  const limit = state.switchBudgetLimit ?? policy.switchBudgetCount ?? null;
  const exhausted = limit !== null && used >= limit;
  const oldestBudgetTimestamp = budgetHistory
    .map((entry) => Date.parse(timestampOf(entry)))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0];
  const derivedBlockedUntil = exhausted && windowSeconds !== null
    && Number.isFinite(oldestBudgetTimestamp)
    ? new Date(oldestBudgetTimestamp + (windowSeconds * 1000)).toISOString()
    : null;
  const rawScanBackoff = state.scanBackoff ?? {
    until: state.candidateScanBackoffUntil ?? state.scanBackoffUntil ?? state.nextCandidateScanAt ?? null,
    failures: state.consecutiveEmptyScans ?? 0,
    reason: state.lastCandidateScanOutcome ?? null,
  };
  const scanBackoffUntil = Date.parse(rawScanBackoff.until);
  return {
    scanBackoff: {
      ...rawScanBackoff,
      until: Number.isFinite(scanBackoffUntil) && scanBackoffUntil > Date.now()
        ? rawScanBackoff.until
        : null,
    },
    switchBudget: state.switchBudget ?? {
      used,
      limit,
      windowSeconds,
      blockedUntil: state.switchBudgetBlockedUntil ?? derivedBlockedUntil,
    },
  };
}

async function getLiveSelection(controller, targetGroup) {
  if (!controller || !targetGroup) return null;
  try {
    const selected = (await controller.getProxy(targetGroup))?.now ?? targetGroup;
    let leaf = selected;
    const visited = new Set();
    for (let depth = 0; depth < 8; depth += 1) {
      if (visited.has(leaf)) break;
      visited.add(leaf);
      const proxy = await controller.getProxy(leaf);
      if (!proxy?.now || proxy.now === leaf) break;
      leaf = proxy.now;
    }
    return { selected, leaf, source: 'controller' };
  } catch (error) {
    return { error: `读取控制器当前节点失败：${error.message}` };
  }
}

export async function buildStatusSnapshot({ stateFile, logFile, controller, targetGroup, policy, retainedFiles }) {
  const [{ state, warnings: stateWarnings }, { records, warnings: logWarnings }, live] = await Promise.all([
    readStateSafely(stateFile),
    readRecentNdjson(logFile, { retainedFiles }),
    getLiveSelection(controller, targetGroup),
  ]);
  const evaluation = latestByEvent(records, 'current-node-evaluated');
  const telemetry = telemetryForEvaluation(records, evaluation);
  const guardrail = latestByEvent(records, 'guardrail-evaluated');
  const processGuard = latestByEvent(records, 'clash-verge-process-guard-evaluated');
  const runtimeModeGuard = latestByEvent(records, 'runtime-mode-guard-evaluated');
  const current = live && !live.error
    ? live
    : {
        selected: state.currentSelection ?? evaluation?.selected ?? state.lastSwitch?.to ?? null,
        leaf: state.currentLeaf ?? evaluation?.leaf ?? state.currentSelection ?? evaluation?.selected ?? state.lastSwitch?.to ?? null,
        source: evaluation ? 'log' : (state.currentSelection || state.lastSwitch?.to ? 'state' : null),
      };
  const warnings = [...stateWarnings, ...logWarnings];
  if (live?.error) warnings.push(live.error);
  const policyState = normalizePolicyState(state, policy);
  const candidateSnapshotAgeMs = Date.now() - Date.parse(state.candidateSnapshot?.at ?? '');
  const candidateSnapshot = state.candidateSnapshot
    ? {
        at: state.candidateSnapshot.at ?? null,
        ageMs: Number.isFinite(candidateSnapshotAgeMs) ? Math.max(0, candidateSnapshotAgeMs) : null,
        maxAgeMs: (policy?.candidateSnapshotMaxAgeSeconds ?? 0) * 1000,
        fresh: Number.isFinite(candidateSnapshotAgeMs)
          && candidateSnapshotAgeMs <= (policy?.candidateSnapshotMaxAgeSeconds ?? 0) * 1000,
        candidateCount: Array.isArray(state.candidateSnapshot.candidates)
          ? state.candidateSnapshot.candidates.length : 0,
        selection: state.candidateSnapshot.selection ?? null,
        leaf: state.candidateSnapshot.leaf ?? null,
      }
    : null;
  const quarantinedNodes = activeQuarantines(state.quarantinedNodes);
  const externalSelectionAdmission = state.externalSelectionPendingAdmission
    ? {
        status: 'pending-or-rejected',
        from: state.externalSelectionPendingAdmission.from ?? null,
        fromLeaf: state.externalSelectionPendingAdmission.fromLeaf ?? null,
        to: state.externalSelectionPendingAdmission.to ?? null,
        leaf: state.externalSelectionPendingAdmission.leaf ?? null,
        detectedAt: state.externalSelectionPendingAdmission.detectedAt ?? null,
      }
    : null;
  if (live && !live.error) {
    const selectionMismatch = state.currentSelection != null
      && state.currentSelection !== live.selected;
    const leafMismatch = state.currentLeaf != null
      && state.currentLeaf !== live.leaf;
    if (selectionMismatch || leafMismatch) {
      warnings.push('控制器当前节点与守护程序同步状态不一致；可能存在外部手动切换或尚未完成的新周期');
    }
  }
  if (current?.leaf && quarantinedNodes.some((entry) => entry.node === current.leaf)) {
    warnings.push('当前叶子节点仍在隔离列表中；后续周期应重新核验并修正状态');
  }
  if (externalSelectionAdmission) {
    warnings.push('外部节点待准入/已拒绝，正在寻找合格候选');
  }
  if (state.provisionalFallback) {
    warnings.push('当前节点尚未通过严格准入；服务会优先执行恢复性复测或切换');
  }
  if (guardrail?.ready === false) {
    const issueText = Array.isArray(guardrail.issues) && guardrail.issues.length
      ? guardrail.issues.map(explainGuardrailIssue).join(', ')
      : 'unknown';
    warnings.push(`配置守卫未就绪，链路探测与节点切换已暂停：${issueText}`);
  }
  if (processGuard?.ready === false) {
    const issueText = Array.isArray(processGuard.issues) && processGuard.issues.length
      ? processGuard.issues.map(explainGuardrailIssue).join(', ')
      : 'unknown';
    warnings.push(`客户端进程守卫未就绪，任何节点切换均被禁止：${issueText}`);
  }
  if (runtimeModeGuard?.ready === false) {
    const issueText = Array.isArray(runtimeModeGuard.issues) && runtimeModeGuard.issues.length
      ? runtimeModeGuard.issues.map(explainGuardrailIssue).join(', ')
      : 'unknown';
    warnings.push(`运行模式守卫未就绪，任何节点切换均被禁止：${issueText}`);
  }
  return {
    generatedAt: new Date().toISOString(),
    runtime: state.runtime ?? null,
    current,
    probe: evaluation ? {
      at: evaluation.timestamp ?? null,
      successRate: evaluation.successRate ?? null,
      averageMs: evaluation.averageMs ?? null,
      maxMs: evaluation.maxMs ?? null,
      jitterMs: evaluation.jitterMs ?? null,
      health: evaluation.health ?? null,
      quality: evaluation.quality ?? null,
    } : null,
    telemetry: telemetry ? {
      at: telemetry.timestamp ?? null,
      ...telemetry.metrics,
    } : null,
    guardrails: guardrail ? {
      at: guardrail.timestamp ?? null,
      status: guardrail.status ?? null,
      ready: guardrail.ready ?? null,
      issues: guardrail.issues ?? [],
      repairs: guardrail.repairs ?? [],
    } : null,
    processGuard: processGuard ? {
      at: processGuard.timestamp ?? null,
      status: processGuard.status ?? null,
      ready: processGuard.ready ?? null,
      issues: processGuard.issues ?? [],
      repairs: processGuard.repairs ?? [],
    } : null,
    externalSelectionAdmission,
    runtimeModeGuard: runtimeModeGuard ? {
      at: runtimeModeGuard.timestamp ?? null,
      status: runtimeModeGuard.status ?? null,
      ready: runtimeModeGuard.ready ?? null,
      issues: runtimeModeGuard.issues ?? [],
      repairs: runtimeModeGuard.repairs ?? [],
    } : null,
    consecutiveFailures: {
      overall: state.consecutiveFailures ?? 0,
      partial: state.consecutivePartialFailures ?? 0,
      latency: state.consecutiveLatencyFailures ?? 0,
    },
    degradationWindow: {
      cycles: Array.isArray(state.degradationWindow) ? state.degradationWindow.length : 0,
      failures: Array.isArray(state.degradationWindow)
        ? state.degradationWindow.filter((entry) => entry?.degraded).length
        : 0,
      required: policy?.degradationWindowFailures ?? null,
      size: policy?.degradationWindowCycles ?? null,
    },
    lastDecision: state.lastDecision ?? null,
    candidateScan: state.candidateScan ?? null,
    candidateSnapshot,
    lastCandidateScan: state.lastCandidateScan ?? null,
    provisionalFallback: state.provisionalFallback ?? null,
    lastSwitch: state.lastSwitch ? { at: state.lastSwitchAt ?? null, ...state.lastSwitch } : null,
    lastSelectionNormalization: state.lastSelectionNormalization ?? null,
    quarantinedNodes,
    ...policyState,
    files: { state: stateFile, log: logFile },
    warnings: [...new Set(warnings)],
  };
}

function display(value, suffix = '') {
  return value === null || value === undefined ? '-' : `${value}${suffix}`;
}

export function formatStatus(snapshot) {
  const quarantine = snapshot.quarantinedNodes.length
    ? snapshot.quarantinedNodes.map((item) => `${item.node}（至 ${item.until}）`).join('；')
    : '无';
  const switchText = snapshot.lastSwitch
    ? `${display(snapshot.lastSwitch.from)} -> ${display(snapshot.lastSwitch.to)} / ${display(snapshot.lastSwitch.reason)} / ${display(snapshot.lastSwitch.at)}`
    : '-';
  const normalizationText = snapshot.lastSelectionNormalization
    ? `${display(snapshot.lastSelectionNormalization.from)} -> ${display(snapshot.lastSelectionNormalization.to)} / ${display(snapshot.lastSelectionNormalization.at)}`
    : '-';
  const backoff = snapshot.scanBackoff?.until
    ? `至 ${snapshot.scanBackoff.until}（原因 ${display(snapshot.scanBackoff.reason)}）`
    : '未启用';
  const budget = snapshot.switchBudget?.limit !== null && snapshot.switchBudget?.limit !== undefined
    ? `${display(snapshot.switchBudget.used, '')}/${snapshot.switchBudget.limit}，阻止至 ${display(snapshot.switchBudget.blockedUntil)}`
    : '未配置或无记录';
  const httpsTelemetry = snapshot.telemetry?.https;
  const websocketTelemetry = snapshot.telemetry?.websocket;
  const guardrailText = snapshot.guardrails
    ? `${display(snapshot.guardrails.status)}，问题 ${snapshot.guardrails.issues.length}，修复 ${snapshot.guardrails.repairs.length}`
    : '尚无数据';
  const processGuardText = snapshot.processGuard
    ? `${display(snapshot.processGuard.status)}，问题 ${snapshot.processGuard.issues.length}，修复 ${snapshot.processGuard.repairs.length}`
    : '尚无检查记录';
  const externalAdmissionText = snapshot.externalSelectionAdmission
    ? `外部节点待准入/已拒绝，正在寻找合格候选：${display(snapshot.externalSelectionAdmission.to)}（叶子 ${display(snapshot.externalSelectionAdmission.leaf)}）`
    : '无';
  const runtimeGuardText = snapshot.runtimeModeGuard
    ? `${display(snapshot.runtimeModeGuard.status)}，问题 ${snapshot.runtimeModeGuard.issues.length}，修复 ${snapshot.runtimeModeGuard.repairs.length}`
    : '尚无检查记录（需确认服务已加载最新版）';
  const decisionText = snapshot.lastDecision
    ? `${display(snapshot.lastDecision.action)} / ${display(snapshot.lastDecision.reason)} / ${display(snapshot.lastDecision.at)}`
    : '-';
  const scanText = snapshot.lastCandidateScan
    ? `${display(snapshot.lastCandidateScan.at)}，原因 ${display(snapshot.lastCandidateScan.reason)}，耗时 ${display(snapshot.lastCandidateScan.durationMs, ' ms')}/${display(snapshot.lastCandidateScan.deadlineMs, ' ms')}，截止 ${snapshot.lastCandidateScan.deadlineReached ? '是' : '否'}，抽样 ${display(snapshot.lastCandidateScan.sampledCount)}，严格复测 ${display(snapshot.lastCandidateScan.validatedCount)}，严格合格 ${(snapshot.lastCandidateScan.stable ?? []).join('、') || '无'}，健康线临时候选 ${(snapshot.lastCandidateScan.provisional ?? []).join('、') || '无'}；淘汰 ${(snapshot.lastCandidateScan.rejected ?? []).slice(0, 3).map((entry) => `${entry.node}[${(entry.reasons ?? []).join('/') || '未知'}]`).join('、') || '无'}`
    : '-';
  const activeScanText = snapshot.candidateScan
    ? `${display(snapshot.candidateScan.status)}，开始 ${display(snapshot.candidateScan.startedAt)}，原因 ${display(snapshot.candidateScan.reason)}`
    : '无';
  const candidateSnapshotText = snapshot.candidateSnapshot
    ? `${snapshot.candidateSnapshot.fresh ? '新鲜' : '过期'}，年龄 ${Math.round((snapshot.candidateSnapshot.ageMs ?? 0) / 1000)} 秒，候选 ${snapshot.candidateSnapshot.candidateCount}，生成 ${display(snapshot.candidateSnapshot.at)}`
    : '无';
  const provisionalText = snapshot.provisionalFallback
    ? `${display(snapshot.provisionalFallback.selection)}（${display(snapshot.provisionalFallback.profile)}，等待严格准入）`
    : '无';
  const lines = [
    'Mihomo Route Sentinel 运行状态',
    `运行版本       : ${display(snapshot.runtime?.version)}（PID ${display(snapshot.runtime?.pid)}，启动 ${display(snapshot.runtime?.startedAt)}）`,
    `当前选择       : ${display(snapshot.current?.selected)}`,
    `当前叶子节点   : ${display(snapshot.current?.leaf)}（来源：${display(snapshot.current?.source)}）`,
    `最近探测       : ${display(snapshot.probe?.at)}`,
    `探测结果       : 成功率 ${snapshot.probe?.successRate == null ? '-' : `${Math.round(snapshot.probe.successRate * 100)}%`}，平均 ${display(snapshot.probe?.averageMs, ' ms')}，最大 ${display(snapshot.probe?.maxMs, ' ms')}`,
    `健康/质量      : ${display(snapshot.probe?.health)} / ${display(snapshot.probe?.quality)}`,
    `连续失败       : 总计 ${snapshot.consecutiveFailures.overall}，部分失败 ${snapshot.consecutiveFailures.partial}，延迟退化 ${snapshot.consecutiveFailures.latency}`,
    `滚动延迟退化   : ${snapshot.degradationWindow.failures}/${snapshot.degradationWindow.cycles}（触发 ${display(snapshot.degradationWindow.required)}/${display(snapshot.degradationWindow.size)}）`,
    `最近决策       : ${decisionText}`,
    `后台候选扫描   : ${activeScanText}`,
    `候选快照       : ${candidateSnapshotText}`,
    `最近候选扫描   : ${scanText}`,
    `临时候选状态   : ${provisionalText}`,
    `最近切换       : ${switchText}`,
    `最近代理组纠正 : ${normalizationText}`,
    `隔离节点       : ${quarantine}`,
    `扫描退避       : ${backoff}`,
    `切换预算       : ${budget}`,
    `HTTPS 真实链路 : ${httpsTelemetry ? `网络 ${httpsTelemetry.networkOk ? '成功' : '失败'}，HTTP ${display(httpsTelemetry.statusCode)}，代理 TCP ${display(httpsTelemetry.connectMs, ' ms')}，CONNECT ${display(httpsTelemetry.tunnelMs, ' ms')}，TLS ${display(httpsTelemetry.tlsMs, ' ms')}，TTFB ${display(httpsTelemetry.ttfbMs, ' ms')}` : '尚无数据'}`,
    `WebSocket 链路 : ${websocketTelemetry ? `网络 ${websocketTelemetry.networkOk ? '成功' : '失败'}，升级 ${websocketTelemetry.websocketOk ? '成功' : '未成功'}，HTTP ${display(websocketTelemetry.statusCode)}，代理 TCP ${display(websocketTelemetry.connectMs, ' ms')}，CONNECT ${display(websocketTelemetry.tunnelMs, ' ms')}，TLS ${display(websocketTelemetry.tlsMs, ' ms')}，TTFB ${display(websocketTelemetry.ttfbMs, ' ms')}` : '尚无数据'}`,
    `配置守卫       : ${guardrailText}`,
    `客户端进程守卫 : ${processGuardText}`,
    `外部节点准入   : ${externalAdmissionText}`,
    `运行模式守卫   : ${runtimeGuardText}`,
    `日志路径       : ${snapshot.files.log}`,
  ];
  if (snapshot.warnings.length) lines.push(`警告           : ${snapshot.warnings.join('；')}`);
  return lines.join('\n');
}
