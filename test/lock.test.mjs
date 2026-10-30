import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { acquireLock, controllerFingerprint, readLock } from '../src/lock.mjs';

const baseController = { transport: 'http', url: 'http://127.0.0.1:9090', pipePath: '' };
const baseGroups = { target: 'PROXY', candidates: 'Candidates' };
const fingerprintFor = (target = baseGroups.target, controller = baseController) => (
  controllerFingerprint({ controller, groups: { ...baseGroups, target } })
);

async function withLockDir(action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mihomo-lock-'));
  try {
    return await action(path.join(root, 'watchdog.lock'), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  return child.pid;
}

async function acquired(lockFile, fingerprint, programVersion = 'test-1.0.0') {
  return acquireLock(lockFile, { controllerFingerprint: fingerprint, programVersion });
}

test('controllerFingerprint 绑定传输方式、端点与目标策略组', () => {
  const baseline = fingerprintFor();
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(baseline, fingerprintFor());
  assert.notEqual(baseline, fingerprintFor('BACKUP'));
  assert.notEqual(baseline, controllerFingerprint({
    controller: { ...baseController, url: 'http://127.0.0.1:9091' },
    groups: baseGroups,
  }));
  assert.notEqual(baseline, controllerFingerprint({
    controller: { ...baseController, transport: 'pipe', pipePath: '\\\\.\\pipe\\verge-mihomo-test' },
    groups: baseGroups,
  }));
});

test('同一 fingerprint 的第二个实例被拒绝且首个实例释放后可重新获取', async () => {
  await withLockDir(async (lockFile) => {
    const fingerprint = fingerprintFor();
    const release = await acquired(lockFile, fingerprint);
    await assert.rejects(acquired(lockFile, fingerprint), (error) => {
      assert.equal(error.code, 'LOCK_HELD');
      assert.match(error.message, /Watchdog 已在运行（PID \d+）/);
      return true;
    });
    await release();
    const releaseAgain = await acquired(lockFile, fingerprint);
    await releaseAgain();
    assert.equal(await readLock(lockFile), null);
  });
});

test('不同 fingerprint 的实例被拒绝并同时报告两组指纹', async () => {
  await withLockDir(async (lockFile) => {
    const ownerFingerprint = fingerprintFor('PROXY');
    const otherFingerprint = fingerprintFor('BACKUP');
    const release = await acquired(lockFile, ownerFingerprint);
    await assert.rejects(acquired(lockFile, otherFingerprint), (error) => {
      assert.equal(error.code, 'LOCK_CONTROLLER_BUSY');
      assert.match(error.message, /同一 Controller 只允许一个实例/);
      assert.ok(error.message.includes(ownerFingerprint));
      assert.ok(error.message.includes(otherFingerprint));
      return true;
    });
    const lock = await readLock(lockFile);
    assert.equal(lock.pid, process.pid);
    await release();
  });
});

test('空锁文件按陈旧锁回收', async () => {
  await withLockDir(async (lockFile) => {
    await writeFile(lockFile, '', 'utf8');
    const fingerprint = fingerprintFor();
    const release = await acquired(lockFile, fingerprint);
    const lock = await readLock(lockFile);
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.controllerFingerprint, fingerprint);
    await release();
  });
});

test('损坏的 JSON 锁文件按陈旧锁回收', async () => {
  await withLockDir(async (lockFile) => {
    await writeFile(lockFile, '{"version":1,"pid":', 'utf8');
    const release = await acquired(lockFile, fingerprintFor());
    const lock = await readLock(lockFile);
    assert.equal(lock.pid, process.pid);
    await release();
  });
});

test('PID 已死的锁文件按陈旧锁回收', async () => {
  await withLockDir(async (lockFile) => {
    const fingerprint = fingerprintFor();
    const stalePid = await deadPid();
    await writeFile(lockFile, JSON.stringify({
      version: 1,
      pid: stalePid,
      startedAt: new Date().toISOString(),
      controllerFingerprint: fingerprint,
      programVersion: 'stale',
    }), 'utf8');
    const release = await acquired(lockFile, fingerprint);
    const lock = await readLock(lockFile);
    assert.equal(lock.pid, process.pid);
    await release();
  });
});

test('release 只删除本进程的锁，不删除他实例锁', async () => {
  await withLockDir(async (lockFile) => {
    const release = await acquired(lockFile, fingerprintFor());
    const otherPid = await deadPid();
    await writeFile(lockFile, JSON.stringify({
      version: 1,
      pid: otherPid,
      startedAt: new Date().toISOString(),
      controllerFingerprint: fingerprintFor(),
      programVersion: 'other',
    }), 'utf8');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      await release();
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /不删除他实例锁/);
    const lock = await readLock(lockFile);
    assert.equal(lock.pid, otherPid);
  });
});

test('锁内容包含版本、PID、启动时间、Controller 指纹和程序版本', async () => {
  await withLockDir(async (lockFile) => {
    const fingerprint = fingerprintFor();
    const release = await acquired(lockFile, fingerprint, '9.9.9');
    const lock = await readLock(lockFile);
    assert.equal(lock.version, 1);
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.controllerFingerprint, fingerprint);
    assert.equal(lock.programVersion, '9.9.9');
    assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
    const raw = await readFile(lockFile, 'utf8');
    assert.equal(JSON.parse(raw).pid, process.pid);
    await release();
  });
});

test('并发获取同一把锁时只有一个实例成功且不残留临时文件', async () => {
  await withLockDir(async (lockFile, root) => {
    const fingerprint = fingerprintFor();
    const results = await Promise.allSettled([
      acquired(lockFile, fingerprint),
      acquired(lockFile, fingerprint),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason.code, 'LOCK_HELD');
    assert.deepEqual(
      (await readdir(root)).filter((name) => name.endsWith('.tmp')),
      [],
    );
    await fulfilled[0].value();
    assert.equal(await readLock(lockFile), null);
  });
});
