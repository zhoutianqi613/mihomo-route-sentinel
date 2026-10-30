// guard journal：Clash Verge 守卫状态的读取、原子写入，以及审计/债务字段的形状辅助。
// 只处理状态文件与纯数据形状，不依赖 guardrails.mjs。
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const GUARD_AUDIT_LIMIT = 20;
export const DNS_RETRY_BACKOFF_MS = 30_000;

export async function readGuardState(stateFile) {
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

export async function writeGuardState(stateFile, state) {
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

/** 追加审计事件，只保留最近 GUARD_AUDIT_LIMIT 条（默认 20）。 */
export function appendGuardAudit(guardState, record, limit = GUARD_AUDIT_LIMIT) {
  guardState.auditEvents = [
    ...(Array.isArray(guardState.auditEvents) ? guardState.auditEvents : []),
    record,
  ].slice(-limit);
  return record;
}

/** 记录最近一次 DNS 修复备份（无备份时保持原值）。 */
export function recordDnsBackup(guardState, backup) {
  if (!backup) return null;
  guardState.lastDnsBackup = backup;
  return backup;
}

/** 回滚后把 DNS 重载债务转回 repair-required 并设置退避。 */
export function rollbackPendingDnsReload(pendingReload, at, nowMs = Date.now()) {
  return {
    ...(pendingReload ?? { kind: 'dns-reload-required' }),
    phase: 'repair-required',
    nextAttemptAt: new Date(nowMs + DNS_RETRY_BACKOFF_MS).toISOString(),
    lastRollbackAt: at,
  };
}

export function retryIsDue(pending, nowMs = Date.now()) {
  const retryAt = Date.parse(pending?.nextAttemptAt ?? '');
  return !Number.isFinite(retryAt) || retryAt <= nowMs;
}

export function deferPendingRetry(pending, nowMs = Date.now()) {
  return {
    ...pending,
    attemptCount: (Number.isInteger(pending?.attemptCount) ? pending.attemptCount : 0) + 1,
    nextAttemptAt: new Date(nowMs + DNS_RETRY_BACKOFF_MS).toISOString(),
  };
}
