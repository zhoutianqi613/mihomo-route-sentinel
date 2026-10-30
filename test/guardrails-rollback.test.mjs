import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp, readFile, readdir, rm, stat, utimes, writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  enforceGuardrails,
  inspectClashVergeDnsOverride,
} from '../src/guardrails.mjs';
import {
  applyFixedMutations,
  disableClashVergeDnsOverride,
  inspectDnsOverrideFile,
} from '../src/dns-config.mjs';

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

async function createFixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'profiles.yaml'), 'current: active-profile\n', 'utf8');
  await writeFile(path.join(directory, 'config.yaml'), 'mode: rule\nmixed-port: 7897\n', 'utf8');
  await writeFile(path.join(directory, 'clash-verge.yaml'), 'mode: rule\ndns: {}\n', 'utf8');
  await writeFile(path.join(directory, 'verge.yaml'), vergeContent(options), 'utf8');
  return directory;
}

const guardStateFile = (directory) => path.join(directory, 'sentinel-guard-state.json');

async function markRuntimeConfigReloaded(directory) {
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  const before = await stat(runtimePath);
  const refreshedAt = new Date(Math.max(Date.now() + 1000, before.mtimeMs + 1000));
  await utimes(runtimePath, refreshedAt, refreshedAt);
}

function options(directory, overrides = {}) {
  return {
    controller: new MockController(),
    // 回滚用例让重启等待尽快超时，避免真实等待。
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory, clashVergeStartupTimeoutSeconds: 0 },
    guardStateFile: guardStateFile(directory),
    dryRun: false,
    platform: 'win32',
    ...overrides,
  };
}

async function readGuardState(directory) {
  return JSON.parse(await readFile(guardStateFile(directory), 'utf8'));
}

test('修复成功但重启复核失败时自动恢复原文并写审计', async (t) => {
  const directory = await createFixture(t, { dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const original = await readFile(vergePath, 'utf8');

  const result = await enforceGuardrails(options(directory, {
    // 重启返回成功，但运行配置未刷新 → 复核失败。
    restartClashVerge: async () => true,
  }));

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('dns-repair-rollback'));
  assert.equal(result.rollback?.event, 'dns-repair-rollback');
  assert.equal(result.rollback?.restored, true);
  assert.equal(result.rollback?.backupSha256, sha256(Buffer.from(original, 'utf8')));
  // 配置恢复到修复前，且 override 仍在（等待下一个周期重试）。
  assert.equal(await readFile(vergePath, 'utf8'), original);
  assert.equal(inspectClashVergeDnsOverride(await readFile(vergePath, 'utf8'), 'active-profile').enabled, true);
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes('.restore.tmp')), []);

  const state = await readGuardState(directory);
  assert.equal(state.dnsRepairRollback.event, 'dns-repair-rollback');
  assert.equal(state.auditEvents.at(-1).backupSha256, sha256(Buffer.from(original, 'utf8')));
  assert.equal(state.auditEvents.at(-1).reason, 'runtime config was not refreshed');
  assert.equal(state.pendingDnsReload.phase, 'repair-required');
});

test('回滚恢复失败时返回 error、保留备份路径且不吞错', async (t) => {
  const directory = await createFixture(t, { dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const original = await readFile(vergePath, 'utf8');

  const result = await enforceGuardrails(options(directory, {
    restartClashVerge: async () => true,
    restoreBackup: async () => { throw new Error('模拟恢复失败'); },
  }));

  assert.equal(result.status, 'error');
  assert.ok(result.issues.includes('dns-repair-rollback'));
  assert.ok(result.issues.includes('dns-repair-rollback-failed'));
  assert.equal(result.rollback?.restored, false);
  assert.equal(result.rollback?.restoreError, '模拟恢复失败');
  assert.equal(result.backupPath, `${vergePath}.sentinel.bak`);
  // 备份仍在且完整；文件保持"已修复"状态，但结果明确为 error。
  assert.equal(await readFile(result.backupPath, 'utf8'), original);
  assert.equal(inspectClashVergeDnsOverride(await readFile(vergePath, 'utf8'), 'active-profile').enabled, false);
  const state = await readGuardState(directory);
  assert.equal(state.dnsRepairRollback.restoreError, '模拟恢复失败');
});

test('修复成功且复核通过时不回滚', async (t) => {
  const directory = await createFixture(t, { dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const original = await readFile(vergePath, 'utf8');

  const result = await enforceGuardrails(options(directory, {
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    restartClashVerge: async () => {
      await markRuntimeConfigReloaded(directory);
      return true;
    },
  }));

  assert.equal(result.status, 'repaired-restart');
  assert.equal(result.ready, false);
  assert.equal(result.rollback, undefined);
  assert.equal(inspectClashVergeDnsOverride(await readFile(vergePath, 'utf8'), 'active-profile').enabled, false);
  const state = await readGuardState(directory);
  assert.equal(state.dnsRepairRollback, undefined);
  assert.equal(state.auditEvents, undefined);
  // 修复前原文保存在备份里，可供人工恢复。
  assert.equal(await readFile(`${vergePath}.sentinel.bak`, 'utf8'), original);
});

test('幂等：第二次修复不覆盖首次备份', async (t) => {
  const directory = await createFixture(t, { dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const firstOriginal = await readFile(vergePath, 'utf8');
  const restart = async () => {
    await markRuntimeConfigReloaded(directory);
    return true;
  };

  const first = await enforceGuardrails(options(directory, { restartClashVerge: restart }));
  assert.equal(first.status, 'repaired-restart');
  await markRuntimeConfigReloaded(directory);
  await writeFile(vergePath, vergeContent({ dnsEnabled: true, marker: 'theme_mode: light' }), 'utf8');

  const second = await enforceGuardrails(options(directory, { restartClashVerge: restart }));

  assert.equal(second.status, 'repaired-restart');
  assert.equal(await readFile(`${vergePath}.sentinel.bak`, 'utf8'), firstOriginal);
  const state = await readGuardState(directory);
  assert.equal(state.lastDnsBackup.created, false);
  assert.equal(state.dnsRepairRollback, undefined);
});

test('修复后重新出现 override 时按复核失败回滚', async (t) => {
  const directory = await createFixture(t, { dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const original = await readFile(vergePath, 'utf8');

  const result = await enforceGuardrails(options(directory, {
    // 客户端重启后把 override 又写回来，模拟"修复后仍检测到 override"。
    restartClashVerge: async () => {
      await markRuntimeConfigReloaded(directory);
      await writeFile(vergePath, vergeContent({ dnsEnabled: true, marker: 'theme_mode: dark' }), 'utf8');
      return true;
    },
  }));

  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('dns-repair-rollback'));
  assert.equal(result.rollback?.restoreRequired, true);
  assert.equal(result.rollback?.restored, true);
  assert.equal(await readFile(vergePath, 'utf8'), original);
  assert.equal(result.rollback?.reason, 'runtime config was not refreshed');
});

test('旧入口与生产入口输出一致（双解析器已统一）', async (t) => {
  const source = [
    'enable_dns_settings: true',
    'profile_dns_settings:',
    '  active-profile:',
    '    enabled: true',
    '    confirmation: provider-dns',
    '  other-profile:',
    '    enabled: true',
    '',
  ].join('\n');
  const directory = await createFixture(t, { dnsEnabled: false });
  const filePath = path.join(directory, 'verge.yaml');

  for (const content of [source, source.replace(/\n/g, '\r\n')]) {
    const legacy = disableClashVergeDnsOverride(content, 'active-profile');
    await writeFile(filePath, content, 'utf8');
    const inspected = await inspectDnsOverrideFile(filePath, 'active-profile');
    await applyFixedMutations(filePath, inspected.mutations, inspected.metadata);
    const production = await readFile(filePath, 'utf8');

    assert.equal(legacy.changed, true);
    assert.equal(legacy.content, production);
    assert.equal(inspectClashVergeDnsOverride(legacy.content, 'active-profile').enabled, false);
  }
});
