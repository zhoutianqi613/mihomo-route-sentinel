import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 1;

const STATE_VERSION_UNSUPPORTED = 'STATE_VERSION_UNSUPPORTED';
// 退避重试间隔：杀毒软件/索引服务在 Windows 上会短暂持有目标文件（EPERM/EBUSY）。
const RENAME_RETRY_DELAYS_MS = [30, 100, 300];
const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY']);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 顶层结构校验。字段缺失视为合法（旧版本状态文件即为此形状），
 * 只有字段出现且类型不符时才判定为损坏，避免把"尚未产生该字段"误判成损坏。
 */
const SHAPE_RULES = [
  ['switchHistory', Array.isArray, 'array'],
  ['quarantinedNodes', isPlainObject, 'object'],
  ['degradationWindow', Array.isArray, 'array'],
  ['consecutiveFailures', isFiniteNumber, 'number'],
];

export function createDefaultState() {
  return { consecutiveFailures: 0, lastSwitchAt: null, stateVersion: STATE_VERSION };
}

function unsupportedVersionError(stateVersion) {
  return Object.assign(
    new Error(`状态文件版本 ${stateVersion} 高于当前支持的版本 ${STATE_VERSION}`),
    { code: STATE_VERSION_UNSUPPORTED, stateVersion, supportedStateVersion: STATE_VERSION },
  );
}

export function inspectState(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'not-an-object' };
  if (value.stateVersion !== undefined) {
    if (!Number.isInteger(value.stateVersion) || value.stateVersion < 0) {
      return { ok: false, reason: 'invalid-state-version' };
    }
    // fail-closed：更高版本可能带有本实现不认识的语义，继续读会被静默降级。
    if (value.stateVersion > STATE_VERSION) {
      return { ok: false, reason: 'unsupported-state-version', stateVersion: value.stateVersion };
    }
  }
  for (const [field, valid, expected] of SHAPE_RULES) {
    if (value[field] === undefined) continue;
    if (!valid(value[field])) return { ok: false, reason: `invalid-${field}`, field, expected };
  }
  return { ok: true };
}

function quarantineCandidates(stateFile) {
  const stamp = new Date().toISOString();
  const candidates = [`${stateFile}.corrupt.${stamp}.json`];
  // Windows 文件名不允许 ':'，ISO 时间戳需要降级为连字符形式；仍然保留 .corrupt.<ISO>.json 的语义。
  const portable = stamp.replaceAll(':', '-');
  if (portable !== stamp) candidates.push(`${stateFile}.corrupt.${portable}.json`);
  return candidates;
}

async function quarantineStateFile(stateFile) {
  for (const candidate of quarantineCandidates(stateFile)) {
    try {
      await rename(stateFile, candidate);
      return candidate;
    } catch {
      // 重命名是尽力而为：目标名不被平台接受或被占用时尝试下一个候选，最后放弃但不阻断启动。
    }
  }
  return null;
}

async function recoverState(stateFile, reason) {
  const quarantinedTo = await quarantineStateFile(stateFile);
  return { state: createDefaultState(), recovery: { reason, quarantinedTo } };
}

/**
 * 读取并校验状态文件。
 * 返回 { state, recovery }：recovery 为 null 表示原样读到合法状态或文件尚不存在；
 * 否则 state 是默认骨架，recovery 说明自愈原因与被改名的原文件路径。
 * stateVersion 高于本实现时抛 STATE_VERSION_UNSUPPORTED（fail-closed，不改名、不覆盖）。
 */
export async function loadState(stateFile) {
  let raw;
  try {
    raw = await readFile(stateFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { state: createDefaultState(), recovery: null };
    return await recoverState(stateFile, `unreadable-${error.code ?? error.name}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return await recoverState(stateFile, 'invalid-json');
  }
  const inspected = inspectState(parsed);
  if (!inspected.ok) {
    if (inspected.reason === 'unsupported-state-version') throw unsupportedVersionError(inspected.stateVersion);
    return await recoverState(stateFile, inspected.reason);
  }
  return { state: parsed, recovery: null };
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!RENAME_RETRYABLE_CODES.has(error.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Linux/macOS 上 fsync 目录可确认目录项落盘；Windows 不允许对目录取只读句柄（EPERM/EISDIR）。
    // 目录项持久化是尽力而为，任何失败都不阻断状态写入。
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * 备份只在"尚无备份"或"版本变化"时写入：正常运行时不产生额外的每周期写入。
 */
async function refreshBackup(stateFile, payload, version) {
  const backupFile = `${stateFile}.bak`;
  try {
    const parsed = JSON.parse(await readFile(backupFile, 'utf8'));
    if (parsed?.stateVersion === version) return;
  } catch {
    // 备份缺失或不可解析：重建。
  }
  try {
    await writeFile(backupFile, payload, 'utf8');
  } catch {
    // 备份是尽力而为，写不了不影响主状态。
  }
}

/**
 * 原子写入：唯一临时文件 → 写入并 fsync → rename 覆盖 → 目录 fsync → 尽力维护 .bak。
 * 读者只会看到完整 JSON：旧文件在 rename 成功前保持原样，失败也不会留下半个状态。
 */
export async function saveState(stateFile, state) {
  const payload = `${JSON.stringify({ ...state, stateVersion: STATE_VERSION }, null, 2)}\n`;
  const directory = path.dirname(stateFile);
  await mkdir(directory, { recursive: true });
  // pid + UUID：同一进程内并发保存（如前后台同时落盘）也不会共用临时文件。
  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, stateFile);
  } finally {
    // 成功路径 rename 已移走临时文件，force 让这里变成无害的兜底。
    await rm(temporary, { force: true }).catch(() => {});
  }
  await syncDirectory(directory);
  await refreshBackup(stateFile, payload, STATE_VERSION);
}
