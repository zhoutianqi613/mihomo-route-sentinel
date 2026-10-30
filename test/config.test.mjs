import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CURRENT_CONFIG_VERSION, loadConfig } from '../src/config.mjs';

async function withConfig(value, action) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mihomo-config-'));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(value), 'utf8');
  try {
    return await action(configPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const minimal = {
  configVersion: 5,
  groups: { target: 'PROXY', candidates: 'Candidates' },
};

test('v1 配置可内存迁移到当前版本并补齐新默认值', async () => {
  await withConfig({ groups: minimal.groups }, async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
    assert.equal(config.probes.parallelism, 8);
    assert.deepEqual(config.probes.controlUrls, ['https://cp.cloudflare.com/generate_204']);
    assert.equal(config.policy.switchBudgetCount, 3);
    assert.equal(config.policy.immediateMaxSingleMs, 2500);
    assert.equal(config.policy.intervalSeconds, 30);
    assert.equal(config.policy.candidateSnapshotRefreshSeconds, 60);
    assert.equal(config.policy.candidateSnapshotMaxAgeSeconds, 120);
    assert.equal(config.logging.maxBytes, 5242880);
    assert.equal(config.telemetry.enabled, true);
    assert.equal(config.guardrails.expectedRuntimeMode, 'rule');
    assert.equal(config.guardrails.disableClashVergeDnsOverride, true);
    assert.equal(config.guardrails.ensureClashVergeRunning, false);
    assert.equal(config.guardrails.clashVergeExecutable, '');
  });
});

test('v2 配置可内存迁移到当前版本且不会静默启用外部配置修改', async () => {
  await withConfig({ ...minimal, configVersion: 2 }, async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
    assert.equal(config.guardrails.enabled, false);
    assert.equal(config.guardrails.autoRepair, true);
  });
});

test('v3 配置迁移到当前版本时不会自动启用客户端进程守卫', async () => {
  await withConfig({ ...minimal, configVersion: 3, guardrails: { enabled: true } }, async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
    assert.equal(config.guardrails.enabled, true);
    assert.equal(config.guardrails.ensureClashVergeRunning, false);
  });
});

test('v4 单业务 URL 配置升级后保持旧版单 URL 初筛行为', async () => {
  await withConfig({
    ...minimal,
    configVersion: 4,
    probes: { urls: ['https://service.example/'] },
  }, async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
    assert.equal(config.probes.scanUrlCount, 1);
  });
});

test('未来配置版本被明确拒绝', async () => {
  await withConfig({ ...minimal, configVersion: 99 }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /高于当前程序支持/);
  });
});

test('硬故障确认默认使用三轮采样且单目标超时两秒', async () => {
  await withConfig({ ...minimal, configVersion: CURRENT_CONFIG_VERSION }, async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.probes.confirmRounds, 3);
    assert.equal(config.probes.confirmTimeoutMs, 2000);
  });
});

test('示例占位组名会给出可操作错误', async () => {
  await withConfig({ configVersion: CURRENT_CONFIG_VERSION }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /仍是占位值.*实际存在的策略组名/);
  });
});

for (const [label, override, expected] of [
  ['轮数必须为整数', { probes: { currentRounds: 1.5 } }, /currentRounds.*整数/],
  ['确认轮数必须为整数', { probes: { confirmRounds: 2.5 } }, /confirmRounds.*整数/],
  ['确认轮数不得超过十轮', { probes: { confirmRounds: 11 } }, /confirmRounds.*不得超过 10/],
  ['确认超时至少一毫秒', { probes: { confirmTimeoutMs: 0 } }, /confirmTimeoutMs.*不小于 1/],
  ['并发数必须为正整数', { probes: { parallelism: 0 } }, /parallelism.*整数/],
  ['周期必须为整数', { policy: { intervalSeconds: 5.5 } }, /intervalSeconds.*整数/],
  ['切换预算必须为整数', { policy: { switchBudgetCount: 2.5 } }, /switchBudgetCount.*整数/],
  ['成功率必须在范围内', { probes: { currentMinSuccessRate: 1.1 } }, /currentMinSuccessRate.*0 到 1/],
  ['正则必须可编译', { probes: { includeRegex: '[' } }, /includeRegex.*有效正则/],
  ['凭据环境变量名必须合法', { controller: { secretEnv: 'BAD-NAME' } }, /secretEnv.*环境变量名/],
  ['业务探测只允许 HTTP', { probes: { urls: ['ftp://example.com/'] } }, /probes\.urls\[0\].*http:/],
  ['HTTPS 遥测目标必须为 HTTPS', { telemetry: { httpsUrl: 'http://example.com/' } }, /telemetry\.httpsUrl.*https:/],
  ['WebSocket 遥测目标必须为 WSS', { telemetry: { websocketUrl: 'ws://example.com/' } }, /telemetry\.websocketUrl.*wss:/],
  ['代理遥测只允许 HTTP', { telemetry: { proxyUrl: 'https://example.com/' } }, /telemetry\.proxyUrl.*http:/],
  ['遥测 URL 不得内嵌凭据', { telemetry: { proxyUrl: 'http://user:pass@example.com/' } }, /telemetry URL.*凭据/],
  ['配置守卫禁止 direct 目标模式', { guardrails: { expectedRuntimeMode: 'direct' } }, /expectedRuntimeMode.*不允许 direct/],
  ['Clash Verge 配置目录必须是绝对路径', { guardrails: { clashVergeAppDir: './relative' } }, /clashVergeAppDir.*绝对路径/],
  ['Clash Verge 自动启动要求绝对可执行文件路径', { guardrails: { ensureClashVergeRunning: true } }, /ensureClashVergeRunning.*clashVergeExecutable/],
  ['Clash Verge 可执行文件名必须匹配', { guardrails: { clashVergeExecutable: 'C:\\Tools\\other.exe' } }, /clashVergeExecutable.*clash-verge\.exe/],
  ['Clash Verge 启动退避必须至少五秒', { guardrails: { clashVergeStartBackoffSeconds: 4 } }, /clashVergeStartBackoffSeconds.*5/],
  ['扫描 URL 数不得超过 URL 数组', { probes: { scanUrlCount: 3 } }, /scanUrlCount.*urls/],
  ['发现超时必须小于扫描截止', { probes: { discoveryTimeoutMs: 3000 } }, /discoveryTimeoutMs.*scanDeadlineMs/],
  ['扫描截止不得超过三秒', { probes: { scanDeadlineMs: 3001 } }, /scanDeadlineMs.*3000/],
  ['切前并行验证截止不得超过三秒', { probes: { preSwitchValidationDeadlineMs: 3001 } }, /preSwitchValidationDeadlineMs.*3000/],
  ['候选节点门槛不得更宽', { probes: { candidateMaxAverageMs: 900 } }, /候选节点延迟准入线/],
  ['候选短名单必须覆盖尝试数', { probes: { topCandidates: 2 } }, /topCandidates.*maxSwitchAttempts/],
  ['候选验证上限不得小于单批数量', { probes: { maxValidationCandidates: 5 } }, /maxValidationCandidates.*topCandidates/],
  ['滚动退化次数不得超过窗口', { policy: { degradationWindowCycles: 2, degradationWindowFailures: 3 } }, /degradationWindowFailures.*degradationWindowCycles/],
  ['立即响应尖峰必须高于当前单次健康线', { policy: { immediateMaxSingleMs: 1500 } }, /immediateMaxSingleMs.*currentMaxSingleMs/],
  ['候选快照最大年龄不得小于刷新周期', { policy: { candidateSnapshotRefreshSeconds: 60, candidateSnapshotMaxAgeSeconds: 30 } }, /candidateSnapshotMaxAgeSeconds.*candidateSnapshotRefreshSeconds/],
  ['紧急切换截止不得超过一秒', { policy: { emergencySwitchDeadlineMs: 1001 } }, /emergencySwitchDeadlineMs.*1000/],
]) {
  test(label, async () => {
    await withConfig({ ...minimal, ...override }, async (configPath) => {
      await assert.rejects(loadConfig(configPath), expected);
    });
  });
}

test('运行文件路径不能相互覆盖', async () => {
  await withConfig({
    ...minimal,
    files: { state: './same.json', log: './same.json', lock: './lock' },
  }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /files\.state.*不同文件/);
  });
});

test('未知字段会在启动时报错而不是静默忽略', async () => {
  await withConfig({ ...minimal, probes: { paralellism: 99 } }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /probes 包含未知字段：paralellism/);
  });
});

test('配置分区必须是 JSON 对象', async () => {
  await withConfig({ ...minimal, telemetry: false }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /telemetry 必须是 JSON 对象/);
  });
});

test('README 逐项解释示例配置中的全部字段', async () => {
  const example = JSON.parse(await readFile(path.resolve('config.example.json'), 'utf8'));
  const readme = await readFile(path.resolve('README.md'), 'utf8');
  const paths = [];

  function collect(value, prefix = '') {
    for (const [key, child] of Object.entries(value)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (child && typeof child === 'object' && !Array.isArray(child)) collect(child, field);
      else paths.push(field);
    }
  }

  collect(example);
  for (const field of paths) {
    assert.ok(readme.includes(`\`${field}\``), `README 缺少配置字段说明：${field}`);
  }
});
