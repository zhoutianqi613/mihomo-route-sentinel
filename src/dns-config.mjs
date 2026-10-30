// Clash Verge DNS 配置读写：verge.yaml 的解析/判定（纯函数），以及定长写入、
// 备份/恢复与配置目录校验（文件操作）。文件操作只在被调用时读写用户配置，
// 不依赖 guardrails.mjs，避免循环依赖。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access, lstat, open, readFile, realpath, rename, stat, unlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';

// 与 enforceGuardrails 实际读写/读取的文件保持一致。
const GUARDRAIL_CONFIG_FILES = Object.freeze(['verge.yaml', 'profiles.yaml']);

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

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

function sha256Digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sameFileSystemPath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    // Windows 路径大小写不敏感；其他平台保持严格比较。
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function guardrailDirUntrusted(reason) {
  const error = new Error(`Clash Verge 配置目录不可信：${reason}`);
  error.code = 'GUARDRAIL_DIR_UNTRUSTED';
  error.reason = reason;
  return error;
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

// 生产与旧入口共用的解析器：逐行接收原始行，产出与文件路径完全相同的判定和补丁。
function createDnsOverrideScanner(profileUid) {
  let globalEnabled = false;
  let profileEnabled = null;
  let inProfiles = false;
  let inTarget = false;
  let targetMutations = [];
  const mutations = [];
  const push = (raw, lineOffset) => {
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
  };
  const finish = () => ({
    enabled: profileEnabled ?? globalEnabled,
    globalEnabled,
    profileEnabled,
    mutations: [...mutations, ...(profileEnabled ? targetMutations : [])],
  });
  return { push, finish };
}

// 与 scanLines 完全相同的切行规则，仅用于内存字符串入口。
function scanContentLines(content, visitor) {
  const buffer = Buffer.from(content, 'utf8');
  let offset = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) break;
    const raw = buffer.subarray(offset, newline);
    visitor(raw.at(-1) === 0x0d ? raw.subarray(0, -1) : raw, offset);
    offset = newline + 1;
  }
  if (offset < buffer.length) visitor(buffer.subarray(offset), offset);
  return buffer;
}

function mutationBuffers(mutation) {
  const expected = Buffer.from(mutation.expected, 'utf8');
  const replacement = Buffer.from(mutation.replacement, 'utf8');
  if (expected.length !== replacement.length) throw new Error('mutation length mismatch');
  return { expected, replacement };
}

// 单点补丁校验：文件随机写与内存薄包装共用同一判定，避免出现两套语义。
function patchedBytesForMutation(currentBytes, mutation) {
  const { expected, replacement } = mutationBuffers(mutation);
  if (currentBytes.equals(replacement)) return null;
  if (!currentBytes.equals(expected)) throw new Error('repair target changed');
  return replacement;
}

// 定长补丁的内存实现：与文件写入共享同一组补丁和同一套校验语义。
function applyFixedLengthMutations(buffer, mutations) {
  const patched = Buffer.from(buffer);
  for (const mutation of [...mutations].sort((a, b) => b.offset - a.offset)) {
    const { expected } = mutationBuffers(mutation);
    const current = patched.subarray(mutation.offset, mutation.offset + expected.length);
    const replacement = patchedBytesForMutation(current, mutation);
    if (!replacement) continue;
    patched.set(replacement, mutation.offset);
  }
  return patched;
}

/**
 * 兼容旧测试入口的薄包装：不再有第二套 splice 实现，
 * 判定与补丁全部来自 createDnsOverrideScanner（与 inspectDnsOverrideFile 同源），
 * 应用规则与 applyFixedMutations 相同的定长注释。
 */
export function disableClashVergeDnsOverride(vergeContent, profileUid) {
  const scanner = createDnsOverrideScanner(profileUid);
  const source = scanContentLines(vergeContent, scanner.push);
  const patched = applyFixedLengthMutations(source, scanner.finish().mutations);
  return { changed: !patched.equals(source), content: patched.toString('utf8') };
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

/**
 * 校验 Clash Verge 配置目录是否可信：目录本身不是符号链接/联接点，
 * 真实路径没有被重定向（中间路径若含符号链接，realpath 会与字面路径不一致），
 * 且必须同时包含代码实际使用的 verge.yaml 与 profiles.yaml。
 * 失败统一抛出 code='GUARDRAIL_DIR_UNTRUSTED'，由调用方转成 blocked。
 */
export async function validateClashVergeAppDir(appDir) {
  if (typeof appDir !== 'string' || !appDir.trim() || !path.isAbsolute(appDir)) {
    throw guardrailDirUntrusted('app-dir-invalid');
  }
  const resolved = path.resolve(appDir);
  const directoryStats = await lstat(resolved).catch(() => null);
  if (!directoryStats) throw guardrailDirUntrusted('app-dir-missing');
  if (directoryStats.isSymbolicLink()) throw guardrailDirUntrusted('app-dir-symlink');
  if (!directoryStats.isDirectory()) throw guardrailDirUntrusted('app-dir-not-directory');
  const canonical = await realpath(resolved).catch(() => null);
  if (!canonical) throw guardrailDirUntrusted('app-dir-unresolvable');
  if (!sameFileSystemPath(canonical, resolved)) throw guardrailDirUntrusted('app-dir-redirected');
  for (const name of GUARDRAIL_CONFIG_FILES) {
    const target = path.join(resolved, name);
    const fileStats = await lstat(target).catch(() => null);
    if (!fileStats) throw guardrailDirUntrusted(`missing-${name}`);
    if (fileStats.isSymbolicLink()) throw guardrailDirUntrusted(`symlink-${name}`);
    if (!fileStats.isFile()) throw guardrailDirUntrusted(`not-file-${name}`);
  }
  return resolved;
}

/**
 * 就地定长写入前备份原文件：已存在 <file>.sentinel.bak 时不覆盖，
 * 否则用临时文件 + rename 生成完整备份（中途失败不会留下半份备份）。
 * 返回备份路径、备份内容的 sha256 与本次是否新建。
 */
async function backupBeforeMutation(filePath) {
  const backupPath = `${filePath}.sentinel.bak`;
  if (await exists(backupPath)) {
    const existing = await readFile(backupPath);
    return { path: backupPath, sha256: sha256Digest(existing), created: false };
  }
  const original = await readFile(filePath);
  const temporary = `${backupPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, original);
    await rename(temporary, backupPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { path: backupPath, sha256: sha256Digest(original), created: true };
}

/**
 * 在修复前显式确保备份存在（幂等）：写入失败或需要回滚时，调用方仍持有可用备份。
 */
export async function ensureGuardrailBackup(filePath) {
  return backupBeforeMutation(filePath);
}

/**
 * 从备份原子恢复目标文件（临时文件 + rename）。
 * 只在上层显式调用时执行，不会由守护流程自动触发。
 */
export async function restoreGuardrailBackup(backupPath, targetPath) {
  const invalidBackup = (message) => Object.assign(
    new Error(message),
    { code: 'GUARDRAIL_BACKUP_INVALID' },
  );
  if (typeof backupPath !== 'string' || !backupPath.trim()
      || typeof targetPath !== 'string' || !targetPath.trim()) {
    throw invalidBackup('备份路径与目标路径都必须提供');
  }
  let content;
  try {
    content = await readFile(backupPath);
  } catch (error) {
    throw Object.assign(invalidBackup(`备份不可读取：${error.code ?? error.message}`), { cause: error });
  }
  const temporary = `${targetPath}.${process.pid}.restore.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, targetPath);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { restored: true, sha256: sha256Digest(content) };
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

export async function readTopLevelScalarFile(filePath, key) {
  let value = null;
  const prefix = `${key}:`;
  await scanLines(filePath, (raw) => {
    if (value !== null) return;
    const line = raw.toString('utf8');
    if (line.startsWith(prefix)) value = stripYamlScalar(line.slice(prefix.length));
  });
  return value;
}

export async function inspectDnsOverrideFile(filePath, profileUid) {
  const scanner = createDnsOverrideScanner(profileUid);
  const metadata = await scanLines(filePath, scanner.push);
  const summary = scanner.finish();
  return {
    enabled: summary.enabled,
    globalEnabled: summary.globalEnabled,
    profileEnabled: summary.profileEnabled,
    mutations: summary.mutations,
    metadata: { size: metadata.size, mtimeMs: metadata.mtimeMs },
  };
}

export async function applyFixedMutations(filePath, mutations, expectedMetadata = null) {
  const current = await stat(filePath);
  if (expectedMetadata
      && (current.size !== expectedMetadata.size || current.mtimeMs !== expectedMetadata.mtimeMs)) {
    throw new Error('configuration changed before repair');
  }
  // 真正写入前先落备份；备份失败会直接抛出，原文件保持不动。
  const backup = await backupBeforeMutation(filePath);
  const handle = await open(filePath, 'r+');
  try {
    // 先注释子字段，最后注释 profile 头；任意中断都可用同一 journal 幂等续写。
    for (const mutation of [...mutations].sort((a, b) => b.offset - a.offset)) {
      const { expected } = mutationBuffers(mutation);
      const currentBytes = Buffer.alloc(expected.length);
      await handle.read(currentBytes, 0, currentBytes.length, mutation.offset);
      const replacement = patchedBytesForMutation(currentBytes, mutation);
      if (!replacement) continue;
      await handle.write(replacement, 0, replacement.length, mutation.offset);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { backup };
}
