import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  configVersion: 2,
  groups: { target: 'PROXY', candidates: 'Candidates' },
};

test('v1 配置可内存迁移到 v2 并补齐新默认值', async () => {
  await withConfig({ groups: minimal.groups }, async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.configVersion, CURRENT_CONFIG_VERSION);
    assert.equal(config.probes.parallelism, 4);
    assert.deepEqual(config.probes.controlUrls, ['https://cp.cloudflare.com/generate_204']);
    assert.equal(config.policy.switchBudgetCount, 3);
    assert.equal(config.logging.maxBytes, 5242880);
    assert.equal(config.telemetry.enabled, true);
  });
});

test('未来配置版本被明确拒绝', async () => {
  await withConfig({ ...minimal, configVersion: 99 }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /高于当前程序支持/);
  });
});

test('示例占位组名会给出可操作错误', async () => {
  await withConfig({ configVersion: 2 }, async (configPath) => {
    await assert.rejects(loadConfig(configPath), /仍是占位值.*实际存在的策略组名/);
  });
});

for (const [label, override, expected] of [
  ['轮数必须为整数', { probes: { currentRounds: 1.5 } }, /currentRounds.*整数/],
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
  ['扫描 URL 数不得超过 URL 数组', { probes: { scanUrlCount: 3 } }, /scanUrlCount.*urls/],
  ['候选节点门槛不得更宽', { probes: { candidateMaxAverageMs: 900 } }, /候选节点延迟准入线/],
  ['候选短名单必须覆盖尝试数', { probes: { topCandidates: 2 } }, /topCandidates.*maxSwitchAttempts/],
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
