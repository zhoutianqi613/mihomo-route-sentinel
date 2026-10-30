import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DNS_RETRY_BACKOFF_MS,
  GUARD_AUDIT_LIMIT,
  appendGuardAudit,
  deferPendingRetry,
  readGuardState,
  recordDnsBackup,
  retryIsDue,
  rollbackPendingDnsReload,
  writeGuardState,
} from '../src/guard-journal.mjs';

async function createTempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sentinel-guard-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listTempFiles(directory) {
  return (await readdir(directory)).filter((name) => name.includes('.tmp'));
}

test('readGuardState 读取对象、缺失返回空对象、损坏内容明确报错', async (t) => {
  const directory = await createTempDir(t);
  const stateFile = path.join(directory, 'guard.json');

  assert.deepEqual(await readGuardState(stateFile), {});
  assert.deepEqual(await readGuardState(undefined), {});

  await writeFile(stateFile, JSON.stringify({ pendingDnsReload: { phase: 'repair-required' } }), 'utf8');
  assert.deepEqual(await readGuardState(stateFile), { pendingDnsReload: { phase: 'repair-required' } });

  await writeFile(stateFile, '{not-json', 'utf8');
  await assert.rejects(readGuardState(stateFile), /JSON/);

  await writeFile(stateFile, '[]', 'utf8');
  await assert.rejects(readGuardState(stateFile), /guard state must be an object/);
});

test('writeGuardState 原子落盘且失败时不残留临时文件', async (t) => {
  const directory = await createTempDir(t);
  const stateFile = path.join(directory, 'nested', 'guard.json');

  await writeGuardState(stateFile, { auditEvents: [], lastDnsBackup: null });
  assert.equal(
    await readFile(stateFile, 'utf8'),
    `${JSON.stringify({ auditEvents: [], lastDnsBackup: null }, null, 2)}\n`,
  );
  assert.deepEqual(await listTempFiles(path.dirname(stateFile)), []);

  await assert.rejects(writeGuardState(undefined, {}), /not configured/);

  // 目标被目录占用时 rename 失败，临时文件必须被清理。
  const blockedTarget = path.join(directory, 'occupied');
  await mkdir(blockedTarget);
  await assert.rejects(writeGuardState(blockedTarget, { a: 1 }));
  assert.deepEqual(await listTempFiles(directory), []);
});

test('appendGuardAudit 保留最近 20 条并初始化非数组字段', () => {
  assert.equal(GUARD_AUDIT_LIMIT, 20);
  const guardState = {};
  for (let index = 0; index < 25; index += 1) {
    appendGuardAudit(guardState, { event: 'dns-repair-rollback', index });
  }
  assert.equal(guardState.auditEvents.length, 20);
  assert.equal(guardState.auditEvents[0].index, 5);
  assert.equal(guardState.auditEvents.at(-1).index, 24);

  const custom = { auditEvents: [{ index: 0 }] };
  const returned = appendGuardAudit(custom, { index: 1 });
  assert.equal(returned.index, 1);
  assert.deepEqual(custom.auditEvents.map((entry) => entry.index), [0, 1]);
});

test('recordDnsBackup 记录最近备份且空值不覆盖', () => {
  const guardState = {};
  const backup = { path: 'verge.yaml.sentinel.bak', sha256: 'abc', created: true };
  assert.equal(recordDnsBackup(guardState, backup), backup);
  assert.deepEqual(guardState.lastDnsBackup, backup);

  assert.equal(recordDnsBackup(guardState, null), null);
  assert.deepEqual(guardState.lastDnsBackup, backup);
});

test('rollbackPendingDnsReload 回到待修复并设置固定退避', () => {
  const pending = { kind: 'dns-reload-required', appDir: 'C:\\cfg', phase: 'reload-required', attemptCount: 2 };
  const at = '2026-10-31T00:00:00.000Z';
  const nowMs = Date.parse('2026-10-31T00:00:00.000Z');

  const next = rollbackPendingDnsReload(pending, at, nowMs);

  assert.equal(next.kind, 'dns-reload-required');
  assert.equal(next.appDir, 'C:\\cfg');
  assert.equal(next.attemptCount, 2);
  assert.equal(next.phase, 'repair-required');
  assert.equal(next.lastRollbackAt, at);
  assert.equal(next.nextAttemptAt, new Date(nowMs + DNS_RETRY_BACKOFF_MS).toISOString());

  const fromNull = rollbackPendingDnsReload(null, at, nowMs);
  assert.equal(fromNull.kind, 'dns-reload-required');
  assert.equal(fromNull.phase, 'repair-required');
});

test('retryIsDue 与 deferPendingRetry 按 nextAttemptAt 调度', () => {
  const nowMs = Date.parse('2026-10-31T00:00:00.000Z');
  assert.equal(retryIsDue({}, nowMs), true);
  assert.equal(retryIsDue({ nextAttemptAt: 'not-a-date' }, nowMs), true);
  assert.equal(retryIsDue({ nextAttemptAt: new Date(nowMs - 1).toISOString() }, nowMs), true);
  assert.equal(retryIsDue({ nextAttemptAt: new Date(nowMs + 1).toISOString() }, nowMs), false);

  const deferred = deferPendingRetry({ phase: 'repair-required' }, nowMs);
  assert.equal(deferred.phase, 'repair-required');
  assert.equal(deferred.attemptCount, 1);
  assert.equal(deferred.nextAttemptAt, new Date(nowMs + DNS_RETRY_BACKOFF_MS).toISOString());
  assert.equal(deferPendingRetry(deferred, nowMs).attemptCount, 2);
});
