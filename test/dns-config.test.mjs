import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyFixedMutations,
  disableClashVergeDnsOverride,
  inspectClashVergeDnsOverride,
  inspectDnsOverrideFile,
  replaceTopLevelScalar,
  restoreGuardrailBackup,
  validateClashVergeAppDir,
} from '../src/dns-config.mjs';

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const vergeLines = ({ enabled = true } = {}) => [
  'enable_dns_settings: false',
  'profile_dns_settings:',
  '  active-profile:',
  `    enabled: ${enabled}`,
  ...(enabled ? ['    confirmation: provider-dns'] : []),
  '  other-profile:',
  '    enabled: true',
  'webdav_password: fixture-value-must-remain-opaque',
  'theme_mode: system',
  '',
];

async function createTempDir(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-dns-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeVerge(directory, { enabled = true, newline = '\n' } = {}) {
  const filePath = path.join(directory, 'verge.yaml');
  await writeFile(filePath, vergeLines({ enabled }).join(newline), 'utf8');
  return filePath;
}

test('inspectDnsOverrideFile 判定确认行、忽略注释行，并兼容 CRLF', async (t) => {
  const directory = await createTempDir(t);
  const filePath = await writeVerge(directory, { enabled: true, newline: '\r\n' });

  const inspected = await inspectDnsOverrideFile(filePath, 'active-profile');

  assert.equal(inspected.globalEnabled, false);
  assert.equal(inspected.profileEnabled, true);
  assert.equal(inspected.enabled, true);
  // 需要注释 profile 头 + 两个子字段。
  assert.ok(inspected.mutations.length >= 3);
  assert.equal(inspected.metadata.size, (await stat(filePath)).size);

  // CRLF 文件的偏移必须仍然正确：写完后保留 CRLF 且 profile 头被注释。
  await applyFixedMutations(filePath, inspected.mutations, inspected.metadata);
  const repaired = await readFile(filePath, 'utf8');
  assert.match(repaired, /##active-profile:/);
  assert.doesNotMatch(repaired, /(^|[^\r])\n/);
  assert.equal((await inspectDnsOverrideFile(filePath, 'active-profile')).enabled, false);
});

test('inspectDnsOverrideFile 对全注释内容不产生 mutation', async (t) => {
  const directory = await createTempDir(t);
  const filePath = path.join(directory, 'verge.yaml');
  await writeFile(filePath, [
    '# enable_dns_settings: true',
    '#profile_dns_settings:',
    '#  active-profile:',
    '#    enabled: true',
    '',
  ].join('\n'), 'utf8');

  const inspected = await inspectDnsOverrideFile(filePath, 'active-profile');

  assert.equal(inspected.globalEnabled, false);
  assert.equal(inspected.enabled, false);
  assert.deepEqual(inspected.mutations, []);
});

test('applyFixedMutations 首次写入前留备份，重复执行幂等且不覆盖备份', async (t) => {
  const directory = await createTempDir(t);
  const filePath = await writeVerge(directory, { enabled: true });
  const original = await readFile(filePath, 'utf8');

  const inspected = await inspectDnsOverrideFile(filePath, 'active-profile');
  const applied = await applyFixedMutations(filePath, inspected.mutations, inspected.metadata);
  assert.equal(applied.backup.created, true);
  assert.equal(applied.backup.path, `${filePath}.sentinel.bak`);
  assert.equal(await readFile(applied.backup.path, 'utf8'), original);
  assert.equal(applied.backup.sha256, sha256(Buffer.from(original, 'utf8')));

  const repaired = await readFile(filePath, 'utf8');
  assert.match(repaired, /##active-profile:/);
  const second = await inspectDnsOverrideFile(filePath, 'active-profile');
  assert.equal(second.enabled, false);
  assert.deepEqual(second.mutations, []);

  const secondApply = await applyFixedMutations(filePath, second.mutations, second.metadata);
  assert.equal(secondApply.backup.created, false);
  assert.equal(await readFile(filePath, 'utf8'), repaired);
});

test('restoreGuardrailBackup 复原原文并返回 sha256；备份缺失时明确报错', async (t) => {
  const directory = await createTempDir(t);
  const targetPath = path.join(directory, 'verge.yaml');
  const backupPath = `${targetPath}.sentinel.bak`;
  const original = 'enable_dns_settings: false\nprofile_dns_settings: {}\n';
  await writeFile(backupPath, original, 'utf8');
  await writeFile(targetPath, 'broken: true\n', 'utf8');

  const restored = await restoreGuardrailBackup(backupPath, targetPath);

  assert.equal(restored.restored, true);
  assert.equal(restored.sha256, sha256(Buffer.from(original, 'utf8')));
  assert.equal(await readFile(targetPath, 'utf8'), original);

  const error = await restoreGuardrailBackup(`${targetPath}.missing.bak`, targetPath)
    .then(() => null, (reason) => reason);
  assert.equal(error?.code, 'GUARDRAIL_BACKUP_INVALID');
  assert.equal(await readFile(targetPath, 'utf8'), original);
});

test('validateClashVergeAppDir 拒绝 symlink 目录与缺失文件', async (t) => {
  const root = await createTempDir(t);
  const realDir = path.join(root, 'real');
  await mkdir(realDir);
  await writeFile(path.join(realDir, 'profiles.yaml'), 'current: active-profile\n', 'utf8');
  await writeFile(path.join(realDir, 'verge.yaml'), 'enable_dns_settings: false\n', 'utf8');
  const linkPath = path.join(root, 'link');
  await symlink(realDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

  const linkError = await validateClashVergeAppDir(linkPath).then(() => null, (reason) => reason);
  assert.equal(linkError?.code, 'GUARDRAIL_DIR_UNTRUSTED');
  assert.equal(linkError?.reason, 'app-dir-symlink');

  const missingDir = path.join(root, 'missing');
  await mkdir(missingDir);
  await writeFile(path.join(missingDir, 'profiles.yaml'), 'current: active-profile\n', 'utf8');
  const missingError = await validateClashVergeAppDir(missingDir).then(() => null, (reason) => reason);
  assert.equal(missingError?.code, 'GUARDRAIL_DIR_UNTRUSTED');
  assert.equal(missingError?.reason, 'missing-verge.yaml');

  assert.equal(await validateClashVergeAppDir(realDir), path.resolve(realDir));
});

test('replaceTopLevelScalar 精确替换并保留行尾注释与 CRLF', () => {
  const source = 'mode: direct # manual\nmixed-port: 7897\n';
  const replaced = replaceTopLevelScalar(source, 'mode', 'rule');
  assert.equal(replaced.changed, true);
  assert.equal(replaced.found, true);
  assert.equal(replaced.content, 'mode: rule # manual\nmixed-port: 7897\n');

  const missing = replaceTopLevelScalar(source, 'allow-lan', 'true');
  assert.deepEqual(missing, { changed: false, found: false, content: source });

  const same = replaceTopLevelScalar('mode: rule\n', 'mode', 'rule');
  assert.equal(same.changed, false);
  assert.equal(same.found, true);

  const crlf = replaceTopLevelScalar('mode: direct\r\nmixed-port: 7897\r\n', 'mode', 'rule');
  assert.equal(crlf.content, 'mode: rule\r\nmixed-port: 7897\r\n');
});

test('inspectClashVergeDnsOverride 与 disableClashVergeDnsOverride 只影响当前订阅', () => {
  const source = vergeLines({ enabled: true }).join('\n');
  assert.equal(inspectClashVergeDnsOverride(source, 'active-profile').enabled, true);

  const disabled = disableClashVergeDnsOverride(source, 'active-profile');

  assert.equal(disabled.changed, true);
  assert.equal(inspectClashVergeDnsOverride(disabled.content, 'active-profile').enabled, false);
  assert.match(disabled.content, /other-profile:\n    enabled: true/);
  assert.doesNotMatch(disabled.content, /confirmation:/);
});
