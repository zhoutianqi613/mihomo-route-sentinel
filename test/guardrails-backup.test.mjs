import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  enforceGuardrails,
  inspectClashVergeDnsOverride,
  restoreGuardrailBackup,
  validateClashVergeAppDir,
} from '../src/guardrails.mjs';

const baseGuardrails = Object.freeze({
  enabled: true,
  autoRepair: true,
  expectedRuntimeMode: 'rule',
  ensureClashVergeRunning: false,
  clashVergeExecutable: '',
  clashVergeStartBackoffSeconds: 30,
  clashVergeStartupTimeoutSeconds: 20,
  disableClashVergeDnsOverride: true,
  clashVergeAppDir: '',
  restartClashVergeOnDnsRepair: true,
});

class MockController {
  constructor({ mode = 'rule', kind = 'pipe' } = {}) {
    this.mode = mode;
    this.kind = kind;
    this.patches = [];
  }

  describe() { return { kind: this.kind }; }
  async getConfigs() { return { mode: this.mode }; }
  async patchConfigs(patch) { this.patches.push(patch); this.mode = patch.mode; }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function vergeContent({ dnsEnabled = true, marker = 'theme_mode: system' } = {}) {
  return [
    'enable_dns_settings: false',
    'profile_dns_settings:',
    '  active-profile:',
    `    enabled: ${dnsEnabled}`,
    ...(dnsEnabled ? ['    confirmation: provider-dns'] : []),
    '  other-profile:',
    '    enabled: true',
    'webdav_password: fixture-value-must-remain-opaque',
    marker,
    '',
  ].join('\n');
}

async function createAppDir(parent, name = 'app', options = {}) {
  const directory = path.join(parent, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'profiles.yaml'), 'current: active-profile\n', 'utf8');
  await writeFile(path.join(directory, 'config.yaml'), 'mode: rule\nmixed-port: 7897\n', 'utf8');
  await writeFile(path.join(directory, 'clash-verge.yaml'), 'mode: rule\ndns: {}\n', 'utf8');
  await writeFile(path.join(directory, 'verge.yaml'), vergeContent(options), 'utf8');
  return directory;
}

async function createFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-backup-'));
  t.after(async () => {
    // Windows 上 chmod 会置只读属性，先恢复再删除。
    for (const name of ['verge.yaml', 'verge.yaml.sentinel.bak']) {
      await chmod(path.join(root, 'app', name), 0o644).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });
  const appDir = await createAppDir(root, 'app', { dnsEnabled: true });
  return { root, appDir, vergePath: path.join(appDir, 'verge.yaml') };
}

async function markRuntimeConfigReloaded(appDir) {
  const runtimePath = path.join(appDir, 'clash-verge.yaml');
  const before = await stat(runtimePath);
  const refreshedAt = new Date(Math.max(Date.now() + 1000, before.mtimeMs + 1000));
  await utimes(runtimePath, refreshedAt, refreshedAt);
}

function repairOptions(appDir) {
  return {
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: appDir },
    guardStateFile: path.join(appDir, 'sentinel-guard-state.json'),
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      await markRuntimeConfigReloaded(appDir);
      return true;
    },
  };
}

async function readGuardState(appDir) {
  return JSON.parse(await readFile(path.join(appDir, 'sentinel-guard-state.json'), 'utf8'));
}

async function listTempFiles(appDir) {
  return (await readdir(appDir)).filter((name) => name.includes('.tmp'));
}

test('符号链接/联接点形式的 appDir 被拒绝，且不修改任何配置文件', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realDir = await createAppDir(root, 'real', { dnsEnabled: true });
  const linkPath = path.join(root, 'link');
  await symlink(realDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readFile(path.join(realDir, 'verge.yaml'), 'utf8');

  const error = await validateClashVergeAppDir(linkPath).then(() => null, (reason) => reason);
  assert.equal(error?.code, 'GUARDRAIL_DIR_UNTRUSTED');
  assert.equal(error?.reason, 'app-dir-symlink');

  const result = await enforceGuardrails({
    ...repairOptions(linkPath),
    guardrails: { ...baseGuardrails, clashVergeAppDir: linkPath },
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'GUARDRAIL_DIR_UNTRUSTED');
  assert.ok(result.unresolved.includes('clash-verge-appdir-untrusted'));
  // 未写入、未生成备份。
  assert.equal(await readFile(path.join(realDir, 'verge.yaml'), 'utf8'), before);
  assert.deepEqual((await readdir(realDir)).filter((name) => name.includes('.sentinel.bak')), []);
  assert.deepEqual((await readdir(realDir)).filter((name) => name.includes('.tmp')), []);
});

test('缺少 verge.yaml 的目录被拒绝为 blocked', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app');
  await mkdir(appDir, { recursive: true });
  await writeFile(path.join(appDir, 'profiles.yaml'), 'current: active-profile\n', 'utf8');
  await writeFile(path.join(appDir, 'clash-verge.yaml'), 'mode: rule\ndns: {}\n', 'utf8');

  const error = await validateClashVergeAppDir(appDir).then(() => null, (reason) => reason);
  assert.equal(error?.code, 'GUARDRAIL_DIR_UNTRUSTED');
  assert.equal(error?.reason, 'missing-verge.yaml');

  const result = await enforceGuardrails(repairOptions(appDir));
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'GUARDRAIL_DIR_UNTRUSTED');
  assert.equal(result.guardrailReason, 'missing-verge.yaml');
  assert.deepEqual((await readdir(appDir)).filter((name) => name.includes('.sentinel.bak')), []);
});

test('首次修复前生成 .sentinel.bak，内容等于原文并记录 sha256', async (t) => {
  const { appDir, vergePath } = await createFixture(t);
  const original = await readFile(vergePath);

  const result = await enforceGuardrails(repairOptions(appDir));

  assert.equal(result.status, 'repaired-restart');
  const backupPath = `${vergePath}.sentinel.bak`;
  assert.equal(await readFile(backupPath, 'utf8'), original.toString('utf8'));
  const state = await readGuardState(appDir);
  assert.equal(state.lastDnsBackup.path, backupPath);
  assert.equal(state.lastDnsBackup.created, true);
  assert.equal(state.lastDnsBackup.sha256, sha256(original));
  // 修复本身生效且未残留临时文件。
  assert.equal(inspectClashVergeDnsOverride(await readFile(vergePath, 'utf8'), 'active-profile').enabled, false);
  assert.deepEqual(await listTempFiles(appDir), []);
});

test('二次修复不覆盖已存在的备份', async (t) => {
  const { appDir, vergePath } = await createFixture(t);
  const firstOriginal = await readFile(vergePath, 'utf8');
  const first = await enforceGuardrails(repairOptions(appDir));
  assert.equal(first.status, 'repaired-restart');

  // 再次制造 DNS 覆写，内容与首轮不同，用于区分备份是否被覆盖。
  const secondContent = vergeContent({ dnsEnabled: true, marker: 'theme_mode: light' });
  assert.notEqual(secondContent, firstOriginal);
  await writeFile(vergePath, secondContent, 'utf8');

  const second = await enforceGuardrails(repairOptions(appDir));

  assert.equal(second.status, 'repaired-restart');
  const backupPath = `${vergePath}.sentinel.bak`;
  assert.equal(await readFile(backupPath, 'utf8'), firstOriginal);
  const state = await readGuardState(appDir);
  assert.equal(state.lastDnsBackup.created, false);
  assert.equal(state.lastDnsBackup.sha256, sha256(Buffer.from(firstOriginal, 'utf8')));
  assert.match(await readFile(vergePath, 'utf8'), /theme_mode: light/);
  assert.deepEqual(await listTempFiles(appDir), []);
});

test('restoreGuardrailBackup 原子恢复原文并返回 sha256', async (t) => {
  const { appDir, vergePath } = await createFixture(t);
  const original = await readFile(vergePath);
  const backupPath = `${vergePath}.sentinel.bak`;
  await writeFile(backupPath, original);
  await writeFile(vergePath, 'enable_dns_settings: true\n', 'utf8');

  const result = await restoreGuardrailBackup(backupPath, vergePath);

  assert.equal(result.restored, true);
  assert.equal(result.sha256, sha256(original));
  assert.equal(await readFile(vergePath, 'utf8'), original.toString('utf8'));
  assert.deepEqual(await listTempFiles(appDir), []);
});

test('备份缺失时 restoreGuardrailBackup 明确报错且不改目标文件', async (t) => {
  const { appDir, vergePath } = await createFixture(t);
  const current = 'enable_dns_settings: true\n';
  await writeFile(vergePath, current, 'utf8');

  const error = await restoreGuardrailBackup(`${vergePath}.missing.bak`, vergePath)
    .then(() => null, (reason) => reason);

  assert.equal(error?.code, 'GUARDRAIL_BACKUP_INVALID');
  assert.equal(await readFile(vergePath, 'utf8'), current);
  assert.deepEqual(await listTempFiles(appDir), []);
});

test('恢复写入失败时清理临时文件，不留下半份内容', async (t) => {
  const { appDir, vergePath } = await createFixture(t);
  const backupPath = `${vergePath}.sentinel.bak`;
  await writeFile(backupPath, 'mode: rule\n', 'utf8');
  const directoryTarget = path.join(appDir, 'not-a-file');
  await mkdir(directoryTarget);

  await assert.rejects(restoreGuardrailBackup(backupPath, directoryTarget));
  assert.deepEqual((await readdir(appDir)).filter((name) => name.includes('.restore.tmp')), []);
  // 目标目录本身不被破坏。
  assert.equal((await stat(directoryTarget)).isDirectory(), true);
});

test('修复写入失败时保留完整备份且不残留临时文件', async (t) => {
  const { appDir, vergePath } = await createFixture(t);
  const original = await readFile(vergePath);
  // 只读目标文件使定长写入在 open('r+') 阶段失败。
  await chmod(vergePath, 0o444);

  const result = await enforceGuardrails(repairOptions(appDir));

  assert.equal(result.status, 'blocked');
  assert.deepEqual(await listTempFiles(appDir), []);
  // 备份要么不存在，要么必须是完整原文；绝不允许半份备份。
  const backupPath = `${vergePath}.sentinel.bak`;
  const backupExists = (await readdir(appDir)).includes('verge.yaml.sentinel.bak');
  if (backupExists) assert.equal(await readFile(backupPath, 'utf8'), original.toString('utf8'));
  assert.equal(await readFile(vergePath, 'utf8'), original.toString('utf8'));
});
