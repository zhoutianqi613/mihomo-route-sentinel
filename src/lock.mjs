import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const LOCK_VERSION = 1;

// 锁被占用且内容可回收时最多重试的次数，避免持续竞争下无限循环。
export const MAX_RECLAIM_ATTEMPTS = 3;

/**
 * Controller 身份指纹：绑定传输方式、连接端点与目标策略组。
 * 两份配置只有指向同一 Controller 且操作同一目标组时指纹才相同。
 */
export function controllerFingerprint({ controller, groups }) {
  const transportKind = controller?.transport ?? '';
  const endpoint = controller?.pipePath || new URL(controller.url).origin;
  const targetGroup = groups?.target ?? '';
  // 分隔符避免组件拼接歧义（例如 pipePath 尾部和组名前缀互相吞并）。
  return createHash('sha256')
    .update([transportKind, endpoint, targetGroup].join('\n'), 'utf8')
    .digest('hex');
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 表示进程存在但当前用户无权发信号，仍然视为存活，绝不能回收其锁。
    return error?.code === 'EPERM';
  }
}

/**
 * 读取锁文件；文件不存在或内容无法解析时返回 null。
 */
export async function readLock(lockFile) {
  let raw;
  try {
    raw = await readFile(lockFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

async function writeTempLock(tmpFile, payload) {
  const handle = await open(tmpFile, 'wx');
  try {
    await handle.writeFile(payload, 'utf8');
    // 先落盘再 link，避免第二个实例看到空文件并把它当作陈旧锁回收。
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function moveStaleLock(lockFile) {
  // 用 rename 而不是 unlink，回收动作可被其他竞争者观察到且不会误删新锁。
  const staleFile = `${lockFile}.stale.${Date.now()}`;
  try {
    await rename(lockFile, staleFile);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function reclaimStaleLock(lockFile, fingerprint) {
  const existing = await readLock(lockFile);
  if (!existing) {
    // 空文件或坏 JSON：无法证明有活实例，按陈旧锁回收后重试。
    await moveStaleLock(lockFile);
    return;
  }
  const existingFingerprint = typeof existing.controllerFingerprint === 'string'
    ? existing.controllerFingerprint
    : '';
  if (fingerprint && existingFingerprint && existingFingerprint !== fingerprint) {
    const error = new Error(
      `同一 Controller 只允许一个实例：现有锁 fingerprint=${existingFingerprint}，`
      + `当前配置 fingerprint=${fingerprint}。请先停止 PID ${existing.pid} 的实例。`,
    );
    error.code = 'LOCK_CONTROLLER_BUSY';
    throw error;
  }
  if (isPidAlive(existing.pid)) {
    const error = new Error(`Watchdog 已在运行（PID ${existing.pid}）`);
    error.code = 'LOCK_HELD';
    throw error;
  }
  await moveStaleLock(lockFile);
}

async function releaseLock(lockFile) {
  const existing = await readLock(lockFile);
  if (!existing) return;
  if (existing.pid !== process.pid) {
    // 锁已归属其他实例，绝不删除，只提示调用方。
    console.warn(`锁文件 ${lockFile} 属于 PID ${existing.pid}，当前进程 PID ${process.pid} 不删除他实例锁`);
    return;
  }
  await unlink(lockFile).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

function createRelease(lockFile) {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseLock(lockFile);
  };
}

/**
 * 原子占用锁文件并返回仅能释放本进程锁的 release 函数。
 * meta: { controllerFingerprint, programVersion }
 */
export async function acquireLock(lockFile, meta = {}) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const fingerprint = typeof meta.controllerFingerprint === 'string'
    ? meta.controllerFingerprint
    : '';
  const payload = JSON.stringify({
    version: LOCK_VERSION,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    controllerFingerprint: fingerprint,
    programVersion: meta.programVersion ?? null,
  });

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const tmpFile = `${lockFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeTempLock(tmpFile, payload);
      try {
        // link 是原子的：锁文件一旦出现就已是完整内容，不存在空窗。
        await link(tmpFile, lockFile);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await reclaimStaleLock(lockFile, fingerprint);
        continue;
      }
    } finally {
      // 无论成功、失败还是重试都清理临时文件，避免残留占用目录。
      await unlink(tmpFile).catch(() => {});
    }
    return createRelease(lockFile);
  }

  const error = new Error(
    `获取锁失败：${lockFile} 连续 ${MAX_RECLAIM_ATTEMPTS} 次被其他实例占用`,
  );
  error.code = 'LOCK_CONTENTION';
  throw error;
}
