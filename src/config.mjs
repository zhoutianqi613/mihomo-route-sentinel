import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const CURRENT_CONFIG_VERSION = 7;

export const defaults = Object.freeze({
  configVersion: CURRENT_CONFIG_VERSION,
  controller: {
    transport: 'auto',
    url: 'http://127.0.0.1:9090',
    pipePath: '',
    pipePattern: '^verge-mihomo-(production|sidecar-release)-',
    secretEnv: 'MIHOMO_CONTROLLER_SECRET',
    requestTimeoutMs: 5000,
  },
  groups: {
    target: 'CHANGE_ME_TARGET_SELECTOR',
    candidates: 'CHANGE_ME_CANDIDATE_GROUP',
  },
  probes: {
    urls: ['https://chatgpt.com/', 'https://api.openai.com/v1/models'],
    controlUrls: ['https://cp.cloudflare.com/generate_204'],
    timeoutMs: 5000,
    discoveryTimeoutMs: 1200,
    scanDeadlineMs: 3000,
    preSwitchValidationDeadlineMs: 3000,
    currentRounds: 2,
    currentMinSuccessRate: 1,
    currentMaxAverageMs: 800,
    currentMaxSingleMs: 1500,
    scanRounds: 1,
    scanUrlCount: 2,
    validationRounds: 2,
    topCandidates: 6,
    maxValidationCandidates: 18,
    parallelism: 8,
    candidateMinSuccessRate: 1,
    candidateMaxAverageMs: 600,
    candidateMaxSingleMs: 1200,
    includeRegex: '',
    excludeRegex: '',
  },
  policy: {
    intervalSeconds: 30,
    partialFailureCycles: 2,
    latencyFailureCycles: 3,
    degradationWindowCycles: 10,
    degradationWindowFailures: 3,
    optimizationIntervalSeconds: 900,
    hardFailureConfirmSeconds: 5,
    minimumDwellSeconds: 120,
    minimumImprovementMs: 200,
    minimumImprovementRatio: 0.2,
    failedNodeQuarantineSeconds: 900,
    maxSwitchAttempts: 3,
    postSwitchDelaySeconds: 2,
    postSwitchRounds: 2,
    rollbackOnFailure: true,
    emergencySuccessRate: 0.5,
    emergencyMaxAverageMs: 3000,
    immediateMaxSingleMs: 2500,
    candidateScanBackoffSeconds: 120,
    switchBudgetCount: 3,
    switchBudgetWindowSeconds: 600,
    upstreamFailureMinCandidates: 3,
    candidateSnapshotRefreshSeconds: 60,
    candidateSnapshotMaxAgeSeconds: 120,
    emergencySwitchDeadlineMs: 1000,
  },
  logging: {
    maxBytes: 5242880,
    retainedFiles: 14,
  },
  telemetry: {
    enabled: true,
    proxyUrl: 'http://127.0.0.1:7897',
    httpsUrl: 'https://chatgpt.com/',
    websocketUrl: 'wss://chatgpt.com/backend-api/codex/responses',
    timeoutMs: 5000,
  },
  guardrails: {
    enabled: true,
    autoRepair: true,
    expectedRuntimeMode: 'rule',
    runtimeModeCheckIntervalSeconds: 5,
    ensureClashVergeRunning: false,
    clashVergeExecutable: '',
    clashVergeStartBackoffSeconds: 30,
    clashVergeStartupTimeoutSeconds: 20,
    disableClashVergeDnsOverride: true,
    clashVergeAppDir: '',
    restartClashVergeOnDnsRepair: true,
  },
  files: {
    state: './var/state.json',
    log: './var/watchdog.ndjson',
    lock: './var/watchdog.lock',
    guardrailState: './var/guardrails.json',
  },
});

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(base?.[key] ?? {}, value)
      : value;
  }
  return result;
}

function requireNumber(value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} 必须是不小于 ${minimum} 的数字`);
  }
}

function requireInteger(value, name, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
  }
}

function requireRate(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} 必须是 0 到 1 之间的数字`);
  }
}

function requireBoolean(value, name) {
  if (typeof value !== 'boolean') throw new Error(`${name} 必须是布尔值`);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} 必须是 JSON 对象`);
  }
}

function requireKnownKeys(value, template, name) {
  const allowed = new Set(Object.keys(template));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${name} 包含未知字段：${unknown.join(', ')}`);
  }
}

function requireUrl(value, name, protocols) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} 必须是有效 URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} 协议必须是 ${protocols.join(' 或 ')}`);
  }
  return parsed;
}

function requireUrlList(value, name, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} ${allowEmpty ? '必须是 URL 数组' : '至少需要一个 URL'}`);
  }
  value.forEach((url, index) => requireUrl(url, `${name}[${index}]`, ['http:', 'https:']));
}

function requireRegex(value, name) {
  if (typeof value !== 'string') throw new Error(`${name} 必须是字符串`);
  if (!value) return;
  try {
    new RegExp(value, 'i');
  } catch (error) {
    throw new Error(`${name} 不是有效正则表达式：${error.message}`);
  }
}

function migrate(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('配置根节点必须是 JSON 对象');
  }
  const version = parsed.configVersion ?? 1;
  requireInteger(version, 'configVersion', 1);
  if (version > CURRENT_CONFIG_VERSION) {
    throw new Error(`配置版本 ${version} 高于当前程序支持的 ${CURRENT_CONFIG_VERSION}，请先升级程序`);
  }
  if (version < 1) throw new Error(`不支持配置版本 ${version}`);

  // 旧版本升级时不应在未明确选择的情况下开始修改第三方客户端配置。
  // 新安装使用示例中的显式 guardrails.enabled=true；迁移不会回写原文件。
  const migrated = { ...parsed, configVersion: CURRENT_CONFIG_VERSION };
  if (version < 3 && parsed.guardrails === undefined) {
    migrated.guardrails = { enabled: false };
  }
  if (version < 5) {
    migrated.probes = {
      ...(parsed.probes ?? {}),
      // v1-v4 未配置该字段时的默认值为 1；保持旧行为，避免单 URL 配置升级后失效。
      scanUrlCount: parsed.probes?.scanUrlCount ?? 1,
    };
  }
  return migrated;
}

function validate(config) {
  requireKnownKeys(config, defaults, '配置根节点');
  for (const section of ['controller', 'groups', 'probes', 'policy', 'logging', 'telemetry', 'guardrails', 'files']) {
    requireObject(config[section], section);
    requireKnownKeys(config[section], defaults[section], section);
  }
  requireInteger(config.configVersion, 'configVersion', CURRENT_CONFIG_VERSION);
  if (config.configVersion !== CURRENT_CONFIG_VERSION) {
    throw new Error(`configVersion 必须是 ${CURRENT_CONFIG_VERSION}`);
  }
  if (!['auto', 'pipe', 'http'].includes(config.controller.transport)) {
    throw new Error('controller.transport 必须是 auto、pipe 或 http');
  }
  requireUrl(config.controller.url, 'controller.url', ['http:', 'https:']);
  if (typeof config.controller.pipePath !== 'string') {
    throw new Error('controller.pipePath 必须是字符串');
  }
  requireRegex(config.controller.pipePattern, 'controller.pipePattern');
  if (['auto', 'pipe'].includes(config.controller.transport)
      && !config.controller.pipePath && !config.controller.pipePattern) {
    throw new Error('controller.transport 为 auto/pipe 且未指定 pipePath 时，pipePattern 不能为空');
  }
  if (typeof config.controller.secretEnv !== 'string'
      || (config.controller.secretEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.controller.secretEnv))) {
    throw new Error('controller.secretEnv 必须是空字符串或有效的环境变量名');
  }
  requireInteger(config.controller.requestTimeoutMs, 'controller.requestTimeoutMs', 100);

  for (const name of ['target', 'candidates']) {
    const value = config.groups[name];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`groups.${name} 不能为空`);
    }
    if (value.startsWith('CHANGE_ME_')) {
      throw new Error(`groups.${name} 仍是占位值 ${value}；请改为 Mihomo 中实际存在的策略组名`);
    }
  }

  requireUrlList(config.probes.urls, 'probes.urls');
  requireUrlList(config.probes.controlUrls, 'probes.controlUrls');
  for (const [name, minimum] of Object.entries({
    timeoutMs: 100,
    discoveryTimeoutMs: 100,
    scanDeadlineMs: 500,
    preSwitchValidationDeadlineMs: 500,
    currentRounds: 1,
    scanRounds: 1,
    scanUrlCount: 1,
    validationRounds: 1,
    topCandidates: 1,
    maxValidationCandidates: 1,
    parallelism: 1,
  })) requireInteger(config.probes[name], `probes.${name}`, minimum);
  if (config.probes.discoveryTimeoutMs >= config.probes.scanDeadlineMs) {
    throw new Error('probes.discoveryTimeoutMs 必须小于 probes.scanDeadlineMs');
  }
  if (config.probes.scanDeadlineMs > 3000) {
    throw new Error('probes.scanDeadlineMs 不得超过 3000 ms');
  }
  if (config.probes.preSwitchValidationDeadlineMs > 3000) {
    throw new Error('probes.preSwitchValidationDeadlineMs 不得超过 3000 ms');
  }
  requireRate(config.probes.currentMinSuccessRate, 'probes.currentMinSuccessRate');
  requireRate(config.probes.candidateMinSuccessRate, 'probes.candidateMinSuccessRate');
  for (const name of ['currentMaxAverageMs', 'currentMaxSingleMs', 'candidateMaxAverageMs', 'candidateMaxSingleMs']) {
    requireNumber(config.probes[name], `probes.${name}`, 1);
  }
  requireRegex(config.probes.includeRegex, 'probes.includeRegex');
  requireRegex(config.probes.excludeRegex, 'probes.excludeRegex');
  if (config.probes.scanUrlCount > config.probes.urls.length) {
    throw new Error('probes.scanUrlCount 不能大于 probes.urls 的数量');
  }
  if (config.probes.candidateMinSuccessRate < config.probes.currentMinSuccessRate) {
    throw new Error('probes.candidateMinSuccessRate 不应低于 probes.currentMinSuccessRate');
  }
  if (config.probes.candidateMaxAverageMs > config.probes.currentMaxAverageMs
      || config.probes.candidateMaxSingleMs > config.probes.currentMaxSingleMs) {
    throw new Error('候选节点延迟准入线不应宽于当前节点健康线');
  }
  if (config.probes.currentMaxSingleMs < config.probes.currentMaxAverageMs
      || config.probes.candidateMaxSingleMs < config.probes.candidateMaxAverageMs) {
    throw new Error('单次延迟上限不应小于平均延迟上限');
  }

  for (const [name, minimum] of Object.entries({
    intervalSeconds: 5,
    partialFailureCycles: 1,
    latencyFailureCycles: 1,
    degradationWindowCycles: 1,
    degradationWindowFailures: 1,
    optimizationIntervalSeconds: 0,
    hardFailureConfirmSeconds: 0,
    minimumDwellSeconds: 0,
    minimumImprovementMs: 0,
    failedNodeQuarantineSeconds: 0,
    maxSwitchAttempts: 1,
    postSwitchDelaySeconds: 0,
    postSwitchRounds: 1,
    emergencyMaxAverageMs: 1,
    immediateMaxSingleMs: 1,
    candidateScanBackoffSeconds: 0,
    switchBudgetCount: 1,
    switchBudgetWindowSeconds: 1,
    upstreamFailureMinCandidates: 1,
    candidateSnapshotRefreshSeconds: 5,
    candidateSnapshotMaxAgeSeconds: 5,
    emergencySwitchDeadlineMs: 300,
  })) requireInteger(config.policy[name], `policy.${name}`, minimum);
  requireRate(config.policy.minimumImprovementRatio, 'policy.minimumImprovementRatio');
  requireRate(config.policy.emergencySuccessRate, 'policy.emergencySuccessRate');
  requireBoolean(config.policy.rollbackOnFailure, 'policy.rollbackOnFailure');
  if (config.policy.emergencySuccessRate >= config.probes.currentMinSuccessRate) {
    throw new Error('policy.emergencySuccessRate 必须低于 probes.currentMinSuccessRate');
  }
  if (config.policy.emergencyMaxAverageMs <= config.probes.currentMaxAverageMs) {
    throw new Error('policy.emergencyMaxAverageMs 必须高于 probes.currentMaxAverageMs');
  }
  if (config.policy.immediateMaxSingleMs <= config.probes.currentMaxSingleMs) {
    throw new Error('policy.immediateMaxSingleMs 必须高于 probes.currentMaxSingleMs');
  }
  if (config.probes.topCandidates < config.policy.maxSwitchAttempts) {
    throw new Error('probes.topCandidates 不能小于 policy.maxSwitchAttempts');
  }
  if (config.probes.maxValidationCandidates < config.probes.topCandidates) {
    throw new Error('probes.maxValidationCandidates 不能小于 probes.topCandidates');
  }
  if (config.policy.degradationWindowFailures > config.policy.degradationWindowCycles) {
    throw new Error('policy.degradationWindowFailures 不能大于 policy.degradationWindowCycles');
  }
  if (config.policy.candidateSnapshotMaxAgeSeconds < config.policy.candidateSnapshotRefreshSeconds) {
    throw new Error('policy.candidateSnapshotMaxAgeSeconds 不能小于 candidateSnapshotRefreshSeconds');
  }
  if (config.policy.emergencySwitchDeadlineMs > 1000) {
    throw new Error('policy.emergencySwitchDeadlineMs 不得超过 1000 ms');
  }
  requireInteger(config.logging.maxBytes, 'logging.maxBytes', 1024);
  requireInteger(config.logging.retainedFiles, 'logging.retainedFiles', 1);

  requireBoolean(config.telemetry.enabled, 'telemetry.enabled');
  const proxyUrl = requireUrl(config.telemetry.proxyUrl, 'telemetry.proxyUrl', ['http:']);
  const httpsUrl = requireUrl(config.telemetry.httpsUrl, 'telemetry.httpsUrl', ['https:']);
  const websocketUrl = requireUrl(config.telemetry.websocketUrl, 'telemetry.websocketUrl', ['wss:']);
  if (proxyUrl.username || proxyUrl.password || httpsUrl.username || httpsUrl.password
      || websocketUrl.username || websocketUrl.password) {
    throw new Error('telemetry URL 不允许包含凭据；请使用安全的环境变量或凭据存储');
  }
  requireInteger(config.telemetry.timeoutMs, 'telemetry.timeoutMs', 100);

  requireBoolean(config.guardrails.enabled, 'guardrails.enabled');
  requireBoolean(config.guardrails.autoRepair, 'guardrails.autoRepair');
  if (!['rule', 'global'].includes(config.guardrails.expectedRuntimeMode)) {
    throw new Error('guardrails.expectedRuntimeMode 必须是 rule 或 global；不允许 direct');
  }
  requireInteger(
    config.guardrails.runtimeModeCheckIntervalSeconds,
    'guardrails.runtimeModeCheckIntervalSeconds',
    2,
  );
  requireBoolean(config.guardrails.ensureClashVergeRunning, 'guardrails.ensureClashVergeRunning');
  if (typeof config.guardrails.clashVergeExecutable !== 'string') {
    throw new Error('guardrails.clashVergeExecutable 必须是字符串');
  }
  if (config.guardrails.clashVergeExecutable
      && (!path.isAbsolute(config.guardrails.clashVergeExecutable)
        || path.basename(config.guardrails.clashVergeExecutable).toLowerCase() !== 'clash-verge.exe')) {
    throw new Error('guardrails.clashVergeExecutable 必须是 clash-verge.exe 的绝对路径或空字符串');
  }
  if (config.guardrails.ensureClashVergeRunning && !config.guardrails.clashVergeExecutable) {
    throw new Error('启用 guardrails.ensureClashVergeRunning 时必须配置 guardrails.clashVergeExecutable');
  }
  requireInteger(
    config.guardrails.clashVergeStartBackoffSeconds,
    'guardrails.clashVergeStartBackoffSeconds',
    5,
  );
  requireInteger(
    config.guardrails.clashVergeStartupTimeoutSeconds,
    'guardrails.clashVergeStartupTimeoutSeconds',
    1,
  );
  requireBoolean(
    config.guardrails.disableClashVergeDnsOverride,
    'guardrails.disableClashVergeDnsOverride',
  );
  if (typeof config.guardrails.clashVergeAppDir !== 'string') {
    throw new Error('guardrails.clashVergeAppDir 必须是字符串');
  }
  if (config.guardrails.clashVergeAppDir && !path.isAbsolute(config.guardrails.clashVergeAppDir)) {
    throw new Error('guardrails.clashVergeAppDir 必须是绝对路径或空字符串');
  }
  requireBoolean(
    config.guardrails.restartClashVergeOnDnsRepair,
    'guardrails.restartClashVergeOnDnsRepair',
  );

  for (const name of ['state', 'log', 'lock', 'guardrailState']) {
    if (typeof config.files[name] !== 'string' || !config.files[name].trim()) {
      throw new Error(`files.${name} 不能为空`);
    }
  }
  return config;
}

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  const config = validate(merge(defaults, migrate(parsed)));
  const baseDir = path.dirname(absolutePath);
  for (const key of ['state', 'log', 'lock', 'guardrailState']) {
    config.files[key] = path.resolve(baseDir, config.files[key]);
  }
  if (new Set(Object.values(config.files)).size !== Object.keys(config.files).length) {
    throw new Error('files.state、files.log、files.lock 和 files.guardrailState 必须指向不同文件');
  }
  config.configPath = absolutePath;
  return config;
}
