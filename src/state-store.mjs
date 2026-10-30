import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const STATE_VERSION = 1;

const STATE_VERSION_UNSUPPORTED = 'STATE_VERSION_UNSUPPORTED';

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

/**
 * 原子写入：临时文件写完再 rename，读者永远不会看到半个 JSON。
 * 写入前统一补齐 stateVersion，避免旧进程写回无版本状态。
 */
export async function saveState(stateFile, state) {
  const payload = `${JSON.stringify({ ...state, stateVersion: STATE_VERSION }, null, 2)}\n`;
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, stateFile);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
