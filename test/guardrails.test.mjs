import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  enforceClashVergeAvailability,
  enforceGuardrails,
  enforceRuntimeMode,
  inspectClashVergeDnsOverride,
  replaceTopLevelScalar,
} from '../src/guardrails.mjs';
import { applyFixedMutations, inspectDnsOverrideFile } from '../src/dns-config.mjs';

class MockController {
  constructor({ mode = 'rule', kind = 'pipe', refusePatch = false } = {}) {
    this.mode = mode;
    this.kind = kind;
    this.refusePatch = refusePatch;
    this.patches = [];
  }

  describe() { return { kind: this.kind }; }
  async getConfigs() { return { mode: this.mode }; }
  async patchConfigs(patch) {
    this.patches.push(patch);
    if (!this.refusePatch) this.mode = patch.mode;
  }
}

class RecoveringController extends MockController {
  constructor(events) {
    super();
    this.available = false;
    this.events = events;
  }

  async getConfigs() {
    if (!this.available) {
      this.events.push('get-failed');
      throw new Error('controller unavailable');
    }
    this.events.push('get-ok');
    return { mode: this.mode };
  }
}

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

async function createFakeClashVergeExecutable() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-app-'));
  const executable = path.join(directory, 'clash-verge.exe');
  await writeFile(executable, '', 'utf8');
  return executable;
}

test('客户端进程守卫默认关闭且不检查或启动 Clash Verge', async () => {
  let calls = 0;
  const result = await enforceClashVergeAvailability({
    controller: new MockController(),
    guardrails: baseGuardrails,
    dryRun: false,
    platform: 'win32',
    resolveRunningExecutable: async () => { calls += 1; return null; },
    startExecutable: async () => { calls += 1; },
  });
  assert.equal(result.status, 'ok');
  assert.equal(calls, 0);
});

test('客户端进程守卫可隐藏拉起缺失的 Clash Verge 并等待 Controller', async () => {
  const executable = await createFakeClashVergeExecutable();
  let running = false;
  const starts = [];
  const controller = new MockController();
  const supervisorState = {};
  const guardrails = {
    ...baseGuardrails,
    ensureClashVergeRunning: true,
    clashVergeExecutable: executable,
    clashVergeStartBackoffSeconds: 30,
    clashVergeStartupTimeoutSeconds: 2,
  };
  const dependencies = {
    resolveRunningExecutable: async () => running ? executable : null,
    startExecutable: async (target) => { starts.push(target); running = true; },
  };

  const repaired = await enforceClashVergeAvailability({
    controller,
    guardrails,
    dryRun: false,
    platform: 'win32',
    supervisorState,
    ...dependencies,
  });
  assert.equal(repaired.status, 'repaired');
  assert.deepEqual(repaired.repairs, ['clash-verge-started']);
  assert.deepEqual(starts, [executable]);

  const healthy = await enforceClashVergeAvailability({
    controller,
    guardrails,
    dryRun: false,
    platform: 'win32',
    supervisorState,
    ...dependencies,
  });
  assert.equal(healthy.status, 'ok');
  assert.equal(starts.length, 1);
});

test('客户端进程自动启动失败后进入退避且保持 fail-closed', async () => {
  const executable = await createFakeClashVergeExecutable();
  let attempts = 0;
  const supervisorState = {};
  const guardrails = {
    ...baseGuardrails,
    ensureClashVergeRunning: true,
    clashVergeExecutable: executable,
    clashVergeStartBackoffSeconds: 30,
    clashVergeStartupTimeoutSeconds: 1,
  };
  const dependencies = {
    controller: new MockController(),
    guardrails,
    dryRun: false,
    platform: 'win32',
    supervisorState,
    now: () => 1000,
    resolveRunningExecutable: async () => null,
    startExecutable: async () => { attempts += 1; throw new Error('start failed'); },
  };

  const failed = await enforceClashVergeAvailability(dependencies);
  const backedOff = await enforceClashVergeAvailability(dependencies);
  assert.equal(failed.status, 'blocked');
  assert.ok(failed.unresolved.includes('clash-verge-start-failed'));
  assert.equal(backedOff.status, 'blocked');
  assert.ok(backedOff.unresolved.includes('clash-verge-start-backoff'));
  assert.equal(attempts, 1);
});

test('启动命令返回但客户端进程未存活时不能误报修复成功', async () => {
  const executable = await createFakeClashVergeExecutable();
  let clock = 1000;
  let starts = 0;
  const supervisorState = {};
  const result = await enforceClashVergeAvailability({
    controller: new MockController(),
    guardrails: {
      ...baseGuardrails,
      ensureClashVergeRunning: true,
      clashVergeExecutable: executable,
      clashVergeStartupTimeoutSeconds: 1,
    },
    dryRun: false,
    platform: 'win32',
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    supervisorState,
    resolveRunningExecutable: async () => null,
    startExecutable: async () => { starts += 1; },
  });

  assert.equal(result.status, 'blocked');
  assert.ok(result.unresolved.includes('clash-verge-startup-timeout'));
  assert.equal(starts, 1);

  const backedOff = await enforceClashVergeAvailability({
    controller: new MockController(),
    guardrails: {
      ...baseGuardrails,
      ensureClashVergeRunning: true,
      clashVergeExecutable: executable,
      clashVergeStartBackoffSeconds: 30,
      clashVergeStartupTimeoutSeconds: 1,
    },
    dryRun: false,
    platform: 'win32',
    now: () => clock,
    wait: async (milliseconds) => { clock += milliseconds; },
    supervisorState,
    resolveRunningExecutable: async () => null,
    startExecutable: async () => { starts += 1; },
  });
  assert.equal(backedOff.status, 'blocked');
  assert.ok(backedOff.unresolved.includes('clash-verge-start-backoff'));
  assert.equal(starts, 1);
});

test('Dry Run 只报告 Clash Verge 预计启动且不修改外部状态', async () => {
  const executable = await createFakeClashVergeExecutable();
  let starts = 0;
  const result = await enforceClashVergeAvailability({
    controller: new MockController(),
    guardrails: {
      ...baseGuardrails,
      ensureClashVergeRunning: true,
      clashVergeExecutable: executable,
    },
    dryRun: true,
    platform: 'win32',
    resolveRunningExecutable: async () => null,
    startExecutable: async () => { starts += 1; },
  });
  assert.equal(result.status, 'would-repair');
  assert.equal(result.ready, false);
  assert.equal(starts, 0);
});

test('独立运行模式守卫可在长周期之间快速修复 direct', async () => {
  const controller = new MockController({ mode: 'direct', kind: 'http' });
  const result = await enforceRuntimeMode({
    controller,
    expectedMode: 'rule',
    autoRepair: true,
    dryRun: false,
  });
  assert.equal(result.status, 'repaired');
  assert.equal(result.ready, true);
  assert.equal(controller.mode, 'rule');
});

async function createClashVergeFixture({ dnsEnabled = false, mode = 'rule' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-guard-'));
  await writeFile(path.join(directory, 'profiles.yaml'), 'current: active-profile\n', 'utf8');
  await writeFile(path.join(directory, 'config.yaml'), `mode: ${mode}\nmixed-port: 7897\n`, 'utf8');
  await writeFile(path.join(directory, 'clash-verge.yaml'), `mode: ${mode}\ndns: {}\n`, 'utf8');
  await writeFile(path.join(directory, 'verge.yaml'), [
    'enable_dns_settings: false',
    'profile_dns_settings:',
    '  active-profile:',
    `    enabled: ${dnsEnabled}`,
    ...(dnsEnabled ? ['    confirmation: provider-dns'] : []),
    '  other-profile:',
    '    enabled: true',
    'webdav_password: fixture-value-must-remain-opaque',
    'theme_mode: system',
    '',
  ].join('\n'), 'utf8');
  return directory;
}

function guardStateFile(directory) {
  return path.join(directory, 'sentinel-guard-state.json');
}

async function markRuntimeConfigReloaded(directory) {
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  const before = await stat(runtimePath);
  const refreshedAt = new Date(Math.max(Date.now() + 1000, before.mtimeMs + 1000));
  await utimes(runtimePath, refreshedAt, refreshedAt);
}

async function expirePendingBackoff(directory) {
  const statePath = guardStateFile(directory);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.pendingDnsReload.nextAttemptAt = '1970-01-01T00:00:00.000Z';
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

test('DNS 覆写检查和修复仅影响当前订阅（生产路径）', async (t) => {
  // 旧入口的独立 splice 实现已删除：断言改为走 inspectDnsOverrideFile + applyFixedMutations。
  const directory = await mkdtemp(path.join(os.tmpdir(), 'route-sentinel-dns-prod-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'verge.yaml');
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
  await writeFile(filePath, source, 'utf8');
  assert.equal(inspectClashVergeDnsOverride(source, 'active-profile').enabled, true);

  const inspected = await inspectDnsOverrideFile(filePath, 'active-profile');
  const applied = await applyFixedMutations(filePath, inspected.mutations, inspected.metadata);
  const repaired = await readFile(filePath, 'utf8');

  assert.equal(inspectClashVergeDnsOverride(repaired, 'active-profile').enabled, false);
  assert.match(repaired, /other-profile:\n    enabled: true/);
  // 确认字段被注释后不再生效，而不是删除行。
  assert.doesNotMatch(repaired, /^ {4,}confirmation:/m);
  assert.equal(await readFile(applied.backup.path, 'utf8'), source);

  // 幂等：再次解析不再产生补丁，内容保持不变。
  const second = await inspectDnsOverrideFile(filePath, 'active-profile');
  assert.deepEqual(second.mutations, []);
  await applyFixedMutations(filePath, second.mutations, second.metadata);
  assert.equal(await readFile(filePath, 'utf8'), repaired);
});

test('顶层模式替换保留其余配置', () => {
  const source = 'mode: direct # manual\nmixed-port: 7897\n';
  const repaired = replaceTopLevelScalar(source, 'mode', 'rule');
  assert.equal(repaired.changed, true);
  assert.equal(repaired.content, 'mode: rule # manual\nmixed-port: 7897\n');
});

test('Dry Run 发现 direct 和 DNS 覆写但不修改', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true, mode: 'direct' });
  const before = await readFile(path.join(directory, 'verge.yaml'), 'utf8');
  const controller = new MockController({ mode: 'direct' });
  const result = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    dryRun: true,
    platform: 'win32',
  });
  assert.equal(result.status, 'would-repair');
  assert.equal(result.ready, false);
  assert.deepEqual(controller.patches, []);
  assert.equal(await readFile(path.join(directory, 'verge.yaml'), 'utf8'), before);
});

test('自动修复并复核运行时 direct 模式', async () => {
  const directory = await createClashVergeFixture({ mode: 'direct' });
  const controller = new MockController({ mode: 'direct' });
  const result = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: guardStateFile(directory),
    dryRun: false,
    platform: 'win32',
  });
  assert.equal(result.status, 'repaired');
  assert.equal(result.ready, true);
  assert.deepEqual(controller.patches, [{ mode: 'rule' }]);
  assert.equal(controller.mode, 'rule');
});

test('DNS 覆写修复后重启 Clash Verge 并暂停当前周期', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const originalSize = (await stat(vergePath)).size;
  let restarts = 0;
  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: guardStateFile(directory),
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      restarts += 1;
      await markRuntimeConfigReloaded(directory);
      return true;
    },
  });
  assert.equal(result.status, 'repaired-restart');
  assert.equal(result.ready, false);
  assert.equal(restarts, 1);
  const repaired = await readFile(vergePath, 'utf8');
  assert.equal(inspectClashVergeDnsOverride(repaired, 'active-profile').enabled, false);
  assert.equal((await stat(vergePath)).size, originalSize);
  assert.match(repaired, /webdav_password: fixture-value-must-remain-opaque/);
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes('.tmp')), []);
});

test('DNS 修复后无法自动重载时 fail-closed', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true });
  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: {
      ...baseGuardrails,
      clashVergeAppDir: directory,
      restartClashVergeOnDnsRepair: false,
    },
    guardStateFile: guardStateFile(directory),
    dryRun: false,
    platform: 'linux',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.ready, false);
  assert.ok(result.unresolved.includes('dns-repair-unsupported'));
  const unchanged = await readFile(path.join(directory, 'verge.yaml'), 'utf8');
  assert.equal(inspectClashVergeDnsOverride(unchanged, 'active-profile').enabled, true);
});

test('Clash Verge 重启失败时保持阻止状态并自动回滚配置', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true });
  const vergePath = path.join(directory, 'verge.yaml');
  const original = await readFile(vergePath, 'utf8');
  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: guardStateFile(directory),
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => false,
  });
  assert.equal(result.status, 'blocked');
  assert.ok(result.issues.includes('dns-repair-rollback'));
  assert.equal(result.rollback?.restored, true);
  assert.equal(await readFile(vergePath, 'utf8'), original);
  const state = JSON.parse(await readFile(guardStateFile(directory), 'utf8'));
  assert.equal(state.dnsRepairRollback.event, 'dns-repair-rollback');
  assert.equal(state.pendingDnsReload.phase, 'repair-required');
});

test('DNS 重载债务跨周期和进程重启保持 fail-closed', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true });
  const stateFile = guardStateFile(directory);
  const controller = new MockController();
  const failedRestart = async () => false;

  const first = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: failedRestart,
  });
  assert.equal(first.status, 'blocked');

  const second = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: failedRestart,
  });
  assert.equal(second.status, 'blocked');
  assert.ok(second.unresolved.includes('dns-reload-pending'));

  await expirePendingBackoff(directory);
  const recovered = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      await markRuntimeConfigReloaded(directory);
      return true;
    },
  });
  assert.equal(recovered.status, 'repaired-restart');

  const final = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
  });
  assert.equal(final.status, 'ok');
  assert.equal(final.ready, true);
});

test('repair-required 债务可从字段修改前的进程中断继续完成', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true });
  const stateFile = guardStateFile(directory);
  const runtimeStamp = { mtimeMs: (await stat(path.join(directory, 'clash-verge.yaml'))).mtimeMs };
  await writeFile(stateFile, `${JSON.stringify({
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'repair-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp,
      nextAttemptAt: '1970-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');

  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      await markRuntimeConfigReloaded(directory);
      return true;
    },
  });

  assert.equal(result.status, 'repaired-restart');
  const repaired = await readFile(path.join(directory, 'verge.yaml'), 'utf8');
  assert.equal(inspectClashVergeDnsOverride(repaired, 'active-profile').enabled, false);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pendingDnsReload, undefined);
});

for (const phase of ['repair-required', 'reload-required']) {
  test(`${phase} 债务在 Controller 首次不可达时仍先恢复 Clash Verge`, async () => {
    const directory = await createClashVergeFixture({ dnsEnabled: phase === 'repair-required' });
    const stateFile = guardStateFile(directory);
    const runtimePath = path.join(directory, 'clash-verge.yaml');
    const events = [];
    const controller = new RecoveringController(events);
    await writeFile(stateFile, `${JSON.stringify({
      pendingDnsReload: {
        kind: 'dns-reload-required',
        phase,
        appDir: directory,
        executable: null,
        createdAt: '2026-10-23T00:00:00.000Z',
        runtimeStamp: { mtimeMs: (await stat(runtimePath)).mtimeMs },
        nextAttemptAt: '1970-01-01T00:00:00.000Z',
      },
    }, null, 2)}\n`, 'utf8');

    const result = await enforceGuardrails({
      controller,
      guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
      guardStateFile: stateFile,
      dryRun: false,
      platform: 'win32',
      restartClashVerge: async () => {
        events.push('restart');
        controller.available = true;
        await markRuntimeConfigReloaded(directory);
        return true;
      },
    });

    assert.equal(result.status, 'repaired-restart');
    assert.deepEqual(events.slice(0, 2), ['get-failed', 'restart']);
    assert.ok(events.includes('get-ok'));
    assert.equal(inspectClashVergeDnsOverride(
      await readFile(path.join(directory, 'verge.yaml'), 'utf8'),
      'active-profile',
    ).enabled, false);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pendingDnsReload, undefined);
  });
}

test('运行配置已刷新但 Controller 已掉线时仍恢复进程并清除债务', async () => {
  const directory = await createClashVergeFixture();
  const stateFile = guardStateFile(directory);
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  const events = [];
  const controller = new RecoveringController(events);
  await writeFile(stateFile, `${JSON.stringify({
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'reload-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp: { mtimeMs: (await stat(runtimePath)).mtimeMs },
      nextAttemptAt: '1970-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');
  await markRuntimeConfigReloaded(directory);

  const result = await enforceGuardrails({
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      events.push('restart');
      controller.available = true;
      return true;
    },
  });

  assert.equal(result.status, 'repaired-restart');
  assert.deepEqual(events.slice(0, 2), ['get-failed', 'restart']);
  assert.ok(events.includes('get-ok'));
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pendingDnsReload, undefined);
});

test('运行配置已刷新且 Controller 可达时不会无意义重复重启', async () => {
  const directory = await createClashVergeFixture();
  const stateFile = guardStateFile(directory);
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  await writeFile(stateFile, `${JSON.stringify({
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'reload-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp: { mtimeMs: (await stat(runtimePath)).mtimeMs },
      nextAttemptAt: '1970-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');
  await markRuntimeConfigReloaded(directory);
  let restarts = 0;

  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => { restarts += 1; return true; },
  });

  assert.equal(result.status, 'repaired');
  assert.equal(result.ready, true);
  assert.equal(restarts, 0);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pendingDnsReload, undefined);
});

test('恢复动作成功但 Controller 尚未就绪时通过退避避免连续重启', async () => {
  const directory = await createClashVergeFixture();
  const stateFile = guardStateFile(directory);
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  await writeFile(stateFile, `${JSON.stringify({
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'reload-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp: { mtimeMs: (await stat(runtimePath)).mtimeMs },
      nextAttemptAt: '1970-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');
  await markRuntimeConfigReloaded(directory);
  const controller = new RecoveringController([]);
  let restarts = 0;
  const options = {
    controller,
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => { restarts += 1; return true; },
  };

  const first = await enforceGuardrails(options);
  const second = await enforceGuardrails(options);

  assert.equal(first.status, 'blocked');
  assert.equal(second.status, 'blocked');
  assert.ok(second.unresolved.includes('dns-repair-backoff'));
  assert.equal(restarts, 1);
});

test('pending 期间重新开启 DNS 覆写会转回 repair phase 并遵守退避', async () => {
  const directory = await createClashVergeFixture({ dnsEnabled: true });
  const stateFile = guardStateFile(directory);
  await writeFile(stateFile, `${JSON.stringify({
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'reload-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp: { mtimeMs: 0 },
      nextAttemptAt: '2999-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');
  let restarts = 0;

  const backedOff = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => { restarts += 1; return true; },
  });
  assert.equal(backedOff.status, 'blocked');
  assert.ok(backedOff.unresolved.includes('dns-repair-backoff'));
  assert.equal(restarts, 0);
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pendingDnsReload.phase, 'repair-required');

  await expirePendingBackoff(directory);
  const recovered = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      restarts += 1;
      await markRuntimeConfigReloaded(directory);
      return true;
    },
  });
  assert.equal(recovered.status, 'repaired-restart');
  assert.equal(restarts, 1);
});

test('重载后内容相同但 mtime 前进仍可清除债务', async () => {
  const directory = await createClashVergeFixture();
  const stateFile = guardStateFile(directory);
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  const originalContent = await readFile(runtimePath, 'utf8');
  const runtimeStamp = { mtimeMs: (await stat(runtimePath)).mtimeMs };
  await writeFile(stateFile, `${JSON.stringify({
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'reload-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp,
      nextAttemptAt: '1970-01-01T00:00:00.000Z',
    },
  }, null, 2)}\n`, 'utf8');

  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: false,
    platform: 'win32',
    restartClashVerge: async () => {
      await markRuntimeConfigReloaded(directory);
      return true;
    },
  });
  assert.equal(result.status, 'repaired-restart');
  assert.equal(await readFile(runtimePath, 'utf8'), originalContent);
});

test('Dry Run 即使确认 pending 已外部解决也不改写债务状态', async () => {
  const directory = await createClashVergeFixture();
  const stateFile = guardStateFile(directory);
  const runtimePath = path.join(directory, 'clash-verge.yaml');
  const beforeStamp = (await stat(runtimePath)).mtimeMs;
  const state = {
    pendingDnsReload: {
      kind: 'dns-reload-required',
      phase: 'reload-required',
      appDir: directory,
      executable: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      runtimeStamp: { mtimeMs: beforeStamp },
    },
  };
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await markRuntimeConfigReloaded(directory);
  const beforeState = await readFile(stateFile, 'utf8');

  const result = await enforceGuardrails({
    controller: new MockController(),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: stateFile,
    dryRun: true,
    platform: 'win32',
  });
  assert.equal(result.status, 'would-repair');
  assert.equal(result.ready, false);
  assert.equal(await readFile(stateFile, 'utf8'), beforeState);
});

test('已完成的运行模式修复不能抵消未解决的配置错误', async () => {
  const directory = await createClashVergeFixture();
  await writeFile(path.join(directory, 'verge.yaml'), 'enable_dns_settings: invalid\n', 'utf8');
  const result = await enforceGuardrails({
    controller: new MockController({ mode: 'direct' }),
    guardrails: { ...baseGuardrails, clashVergeAppDir: directory },
    guardStateFile: guardStateFile(directory),
    dryRun: false,
    platform: 'win32',
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.ready, false);
  assert.ok(result.repairs.includes('runtime-mode'));
  assert.ok(result.unresolved.includes('clash-verge-config-invalid'));
});

test('普通 Named Pipe 不会被误识别为 Clash Verge', async () => {
  const result = await enforceGuardrails({
    controller: new MockController({ kind: 'pipe' }),
    guardrails: baseGuardrails,
    dryRun: false,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.ready, true);
});

test('运行时模式修复后复核失败则阻止节点切换', async () => {
  const controller = new MockController({ mode: 'direct', kind: 'http', refusePatch: true });
  const result = await enforceGuardrails({
    controller,
    guardrails: baseGuardrails,
    dryRun: false,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.ready, false);
});

test('普通 HTTP Mihomo 不会误改本机 Clash Verge 文件', async () => {
  const result = await enforceGuardrails({
    controller: new MockController({ kind: 'http' }),
    guardrails: baseGuardrails,
    dryRun: false,
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.ready, true);
});
