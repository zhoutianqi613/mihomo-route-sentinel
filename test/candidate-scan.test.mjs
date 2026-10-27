import assert from 'node:assert/strict';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { summarizeSamples, Watchdog } from '../src/watchdog.mjs';

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function makeWatchdog(controller, overrides = {}) {
  const config = structuredClone(defaults);
  Object.assign(config.probes, {
    urls: ['https://service-a.example/', 'https://service-b.example/'],
    scanUrlCount: 2,
    scanRounds: 1,
    validationRounds: 2,
    parallelism: 2,
    maxValidationCandidates: 2,
    discoveryTimeoutMs: 100,
    timeoutMs: 100,
    scanDeadlineMs: 40,
    ...overrides,
  });
  return new Watchdog({ controller, config, logger: async () => {} });
}

function abortableDelay(signal, milliseconds, value = 100) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('探测取消'), { code: 'ABORT_ERR' }));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

test('候选扫描仅探测候选，逐节点串行采集全部轮次与业务 URL', async () => {
  const active = new Map();
  const calls = new Map();
  let totalActive = 0;
  let peak = 0;
  let groupCalls = 0;
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'a', 'b', 'c'] }; },
    async getGroupDelays() {
      groupCalls += 1;
      throw new Error('整组请求会同时扰动当前健康节点与其他候选');
    },
    async getDelay(node, url, timeoutMs, { signal }) {
      assert.equal(active.get(node) ?? 0, 0, `${node} 出现重叠探测`);
      active.set(node, 1);
      totalActive += 1;
      peak = Math.max(peak, totalActive);
      calls.set(node, [...(calls.get(node) ?? []), url]);
      try { return await abortableDelay(signal, 8); }
      finally { active.set(node, 0); totalActive -= 1; }
    },
  });

  const result = await watchdog.findCandidates('current', new Set(), { background: true });

  assert.equal(groupCalls, 0);
  assert.equal(calls.has('current'), false);
  assert.equal(peak, 2);
  assert.equal(result.stable.length, 2);
  assert.equal(result.probeStats.discovery.method, 'per-node');
  assert.equal(result.probeStats.discovery.controllerRequests, 6);
  assert.equal(result.probeStats.validation.controllerRequests, 8);
  for (const candidate of result.stable) {
    assert.equal(candidate.samples.length, 4);
    assert.deepEqual(candidate.samples.map(({ round }) => round), [1, 1, 2, 2]);
    assert.deepEqual(calls.get(candidate.node), [
      ...watchdog.config.probes.urls,
      ...watchdog.config.probes.urls,
      ...watchdog.config.probes.urls,
    ]);
  }
});

test('后台完整验证使用现配置推导的有限截止，独立于快速发现窗口', async () => {
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'a'] }; },
    async getDelay(node, url, timeoutMs, { signal }) { return abortableDelay(signal, 15); },
  });

  const result = await watchdog.findCandidates('current', new Set(), { background: true });

  assert.equal(result.deadlineMs, 40 + (1 * 1 * 2 * 100) + (1 * 2 * 2 * 100));
  assert.ok(result.durationMs > watchdog.config.probes.scanDeadlineMs);
  assert.ok(result.durationMs < result.deadlineMs);
  assert.equal(result.deadlineReached, false);
  assert.equal(result.stable.length, 1);
  assert.equal(result.stable[0].attempts, 4);
});

test('后台发现保留超过快速初筛超时的可达节点，不能冒充严格合格', async () => {
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'slow'] }; },
    async getDelay(node, url, timeoutMs, { signal }) {
      return abortableDelay(signal, 60, 1300);
    },
  }, { discoveryTimeoutMs: 20, timeoutMs: 150 });

  const result = await watchdog.findCandidates('current', new Set(), { background: true });

  assert.equal(result.sampled[0].successRate, 1);
  assert.equal(result.sampled[0].averageMs, 1300);
  assert.equal(result.deadlineMs, 40 + (2 * 150) + (4 * 150));
  assert.deepEqual(result.stable, []);
  assert.deepEqual(result.provisional, []);
});

test('候选发现记录失败类别，区分接口超时与没有候选', async () => {
  const events = [];
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'unreachable'] }; },
    async getDelay() { throw Object.assign(new Error('模拟超时'), { status: 504 }); },
  });
  watchdog.log = async (level, event, details) => events.push({ event, details });

  await watchdog.findCandidates('current');

  const discovery = events.find(({ event }) => event === 'candidate-discovery-completed');
  assert.deepEqual(discovery.details.failureReasons, { HTTP_504: 2 });
});

test('前台仍受原绝对截止约束，缺少严格样本只保留实时初筛证据', async () => {
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'a'] }; },
    async getDelay(node, url, timeoutMs, { signal }) { return abortableDelay(signal, 18); },
  }, { scanDeadlineMs: 85, candidateMinSuccessRate: 0.25, currentMinSuccessRate: 0.25 });

  const result = await watchdog.findCandidates('current');

  assert.equal(result.deadlineMs, 85);
  assert.ok(result.durationMs < 200, `前台耗时 ${result.durationMs} ms`);
  assert.equal(result.sampled[0].successRate, 1);
  assert.equal(result.validated[0].attempts, 4);
  assert.ok(result.validated[0].samples.some((sample) => sample.error === 'SCAN_DEADLINE'));
  assert.deepEqual(result.stable, []);
  assert.deepEqual(result.provisional, []);
});

test('后台扫描未结束时当前健康节点仍可反复检查', async () => {
  let started;
  const candidateStarted = new Promise((resolve) => { started = resolve; });
  let healthyCalls = 0;
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'candidate'] }; },
    async getDelay(node, url, timeoutMs, { signal }) {
      if (node === 'candidate') {
        started();
        return abortableDelay(signal, 500);
      }
      healthyCalls += 1;
      return 100;
    },
  }, { discoveryTimeoutMs: 1000, timeoutMs: 1000 });
  const scan = watchdog.startBackgroundCandidateScan({ selection: 'current', leaf: 'current' });
  await candidateStarted;

  const startedAt = performance.now();
  for (let index = 0; index < 3; index += 1) {
    assert.equal((await watchdog.probeNode('current', 1, watchdog.config.probes.urls)).successRate, 1);
  }
  assert.ok(performance.now() - startedAt < 150);
  assert.equal(healthyCalls, 6);
  assert.equal(scan.completed, false);
  scan.cancel();
  await scan.promise;
  assert.equal(scan.completed, true);
});

test('健康检查抢占同节点后台请求，等待实际取消完成后开始', async () => {
  let started;
  const backgroundStarted = new Promise((resolve) => { started = resolve; });
  let active = 0;
  let calls = 0;
  let aborts = 0;
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'candidate'] }; },
    async getDelay(node, url, timeoutMs, { signal }) {
      assert.equal(active, 0);
      active += 1;
      calls += 1;
      try {
        if (calls === 1) {
          started();
          signal.addEventListener('abort', () => { aborts += 1; }, { once: true });
          return await abortableDelay(signal, 1000);
        }
        return 100;
      } finally { active -= 1; }
    },
  }, { discoveryTimeoutMs: 1000 });
  const scan = watchdog.startBackgroundCandidateScan({ selection: 'current', leaf: 'current' });
  await backgroundStarted;

  const result = await watchdog.probeNode('candidate', 1, watchdog.config.probes.urls);
  await scan.promise;

  assert.equal(result.successRate, 1);
  assert.equal(aborts, 1);
  assert.equal(active, 0);
});

test('并发的健康检查与切前复核在同一实例内逐节点互斥', async () => {
  let active = 0;
  const watchdog = makeWatchdog({
    async getDelay(node, url, timeoutMs, { signal }) {
      assert.equal(active, 0);
      active += 1;
      try { return await abortableDelay(signal, 8); }
      finally { active -= 1; }
    },
  });

  const [health, candidates] = await Promise.all([
    watchdog.probeNode('a', 1, watchdog.config.probes.urls),
    watchdog.probeCandidatesInParallel(['a'], 2, watchdog.config.probes.urls, Date.now() + 500),
  ]);

  assert.equal(health.successRate, 1);
  assert.equal(candidates[0].successRate, 1);
});

test('底层忽略取消时锁持续有效，前台自身截止保证健康检查不会永久挂起', async () => {
  let finish;
  let underlyingSignal;
  let calls = 0;
  const watchdog = makeWatchdog({
    async getDelay(node, url, timeoutMs, { signal }) {
      calls += 1;
      if (calls > 1) return 100;
      underlyingSignal = signal;
      return new Promise((resolve) => { finish = resolve; });
    },
  }, { timeoutMs: 30 });

  const background = await watchdog.probeCandidatesInParallel(
    ['a'], 1, ['https://service-a.example/'], Date.now() + 20, { background: true },
  );
  assert.equal(background[0].successes, 0);
  assert.equal(underlyingSignal.aborted, true);
  const startedAt = performance.now();
  const health = await watchdog.probeNode('a', 1, ['https://service-a.example/']);
  assert.ok(performance.now() - startedAt < 150);
  assert.equal(health.successes, 0);
  assert.equal(calls, 1);

  finish(100);
  await pause(0);
  assert.equal((await watchdog.probeNode('a', 1, ['https://service-a.example/'])).successRate, 1);
  assert.equal(calls, 2);
});

test('取消后台扫描会取消在途并补齐未启动样本，不能产生严格候选', async () => {
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'a', 'b', 'c'] }; },
    async getDelay(node, url, timeoutMs, { signal }) {
      calls += 1;
      started();
      return abortableDelay(signal, 1000);
    },
  }, { discoveryTimeoutMs: 1000 });
  const scan = watchdog.startBackgroundCandidateScan({ selection: 'current', leaf: 'current' });
  await requestStarted;
  scan.cancel();
  await scan.promise;

  assert.equal(calls, 2);
  assert.deepEqual(scan.result.stable, []);
  assert.equal(scan.result.sampled.length, 3);
  assert.ok(scan.result.sampled.every((entry) => entry.attempts === 2 && entry.successes === 0));
  assert.equal(scan.result.probeStats.discovery.skippedAttempts, 4);
});

test('合法旧配置的一轮验证实际采样至少两轮，后台截止使用实际轮数', async () => {
  let calls = 0;
  const watchdog = makeWatchdog({
    async getProxy() { return { all: ['current', 'a'] }; },
    async getDelay() { calls += 1; return 100; },
  }, { validationRounds: 1 });

  const result = await watchdog.findCandidates('current', new Set(), { background: true });

  assert.equal(result.stable.length, 1);
  assert.equal(result.stable[0].attempts, 4);
  assert.equal(calls, 6);
  assert.equal(result.deadlineMs, 40 + (1 * 1 * 2 * 100) + (1 * 2 * 2 * 100));
});

test('严格证据必须逐轮完整覆盖业务 URL，重复样本不能补缺失轮次或目标', async () => {
  const watchdog = makeWatchdog({ async getProxy() { return { all: ['current', 'a'] }; } });
  const [firstUrl, secondUrl] = watchdog.config.probes.urls;
  for (const pairs of [
    [[1, firstUrl], [1, secondUrl], [1, firstUrl], [1, secondUrl]],
    [[1, firstUrl], [1, firstUrl], [2, secondUrl], [2, secondUrl]],
  ]) {
    watchdog.discoverCandidates = async (nodes, probeUrls, deadlineAt, options) => [
      summarizeSamples('a', (options.event
        ? pairs
        : [[1, firstUrl], [1, secondUrl]])
        .map(([round, url]) => ({ node: 'a', round, url, ok: true, delay: 100 }))),
    ];
    const result = await watchdog.findCandidates('current');
    assert.equal(result.validated[0].attempts, 4);
    assert.deepEqual(result.stable, []);
    assert.deepEqual(result.provisional, []);
  }
});

test('底层忽略取消且延迟结束时，跨节点真实在途请求仍不超过 parallelism', async () => {
  let active = 0;
  let peak = 0;
  let started = 0;
  const watchdog = makeWatchdog({
    async getDelay() {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      try { await pause(90); return 100; }
      finally { active -= 1; }
    },
  }, { parallelism: 2, timeoutMs: 15 });

  const result = await watchdog.probeCandidatesInParallel(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 1,
    ['https://service-a.example/'], Date.now() + 100,
  );
  await pause(100);

  assert.ok(peak <= 2, `底层真实峰值 ${peak}`);
  assert.equal(result.probeStats.peakConcurrency, peak);
  assert.equal(result.probeStats.controllerRequests, started);
  assert.ok(result.probeStats.skippedAttempts > 0);
  assert.equal(active, 0);
});

test('候选容量由实例共享，等待容量可取消且不会阻断其他节点健康检查', async () => {
  let finishFirst;
  let firstStarted;
  const firstRequest = new Promise((resolve) => { firstStarted = resolve; });
  const candidateCalls = [];
  const watchdog = makeWatchdog({
    async getDelay(node) {
      if (node === 'current') return 100;
      candidateCalls.push(node);
      if (node === 'a') {
        firstStarted();
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      return 100;
    },
  }, { parallelism: 1, timeoutMs: 100 });
  const first = watchdog.probeCandidatesInParallel(
    ['a'], 1, ['https://service-a.example/'], Date.now() + 20, { background: true },
  );
  await firstRequest;
  const abortController = new AbortController();
  const waiting = watchdog.probeCandidatesInParallel(
    ['b'], 1, ['https://service-a.example/'], Date.now() + 200,
    { signal: abortController.signal },
  );
  const healthStarted = performance.now();
  const health = await watchdog.probeNode('current', 1, ['https://service-a.example/']);
  assert.equal(health.successRate, 1);
  assert.ok(performance.now() - healthStarted < 100);
  abortController.abort();
  const [firstResult, waitingResult] = await Promise.all([first, waiting]);
  finishFirst(100);
  await pause(0);

  assert.equal(firstResult[0].successes, 0);
  assert.equal(waitingResult[0].samples[0].error, 'PROBE_CANCELLED');
  assert.equal(waitingResult.probeStats.controllerRequests, 0);
  assert.deepEqual(candidateCalls, ['a']);
  const afterRelease = await watchdog.probeCandidatesInParallel(
    ['c'], 1, ['https://service-a.example/'], Date.now() + 100,
  );
  assert.equal(afterRelease[0].successRate, 1);
  assert.deepEqual(candidateCalls, ['a', 'c']);
});

test('候选容量占满时，健康检查可抢占同节点排队后台而不等容量释放', async () => {
  let finishOccupied;
  const calls = [];
  const watchdog = makeWatchdog({
    async getDelay(node) {
      calls.push(node);
      if (node === 'occupied') return new Promise((resolve) => { finishOccupied = resolve; });
      return 100;
    },
  }, { parallelism: 1, timeoutMs: 100 });
  await watchdog.probeCandidatesInParallel(
    ['occupied'], 1, ['https://service-a.example/'], Date.now() + 20, { background: true },
  );
  const queued = watchdog.probeCandidatesInParallel(
    ['current'], 1, ['https://service-a.example/'], Date.now() + 500,
    { background: true, timeoutMs: 500 },
  );
  await pause(0);
  assert.equal(watchdog.activeNodeProbes.get('current')?.background, true);

  const startedAt = performance.now();
  const health = await watchdog.probeNode('current', 1, ['https://service-a.example/']);
  assert.ok(performance.now() - startedAt < 100);
  const queuedResult = await queued;
  assert.equal(health.successRate, 1);
  assert.equal(queuedResult[0].samples[0].error, 'PROBE_CANCELLED');
  assert.equal(queuedResult.probeStats.controllerRequests, 0);
  assert.deepEqual(calls, ['occupied', 'current']);
  assert.equal(watchdog.activeCandidateRequests, 1);
  finishOccupied(100);
  await pause(0);
  assert.equal(watchdog.activeCandidateRequests, 0);
});

test('候选容量等待遵守调用方截止，超时排队不能在释放容量后补发', async () => {
  let finishOccupied;
  const calls = [];
  const watchdog = makeWatchdog({
    async getDelay(node) {
      calls.push(node);
      if (node === 'occupied') return new Promise((resolve) => { finishOccupied = resolve; });
      return 100;
    },
  }, { parallelism: 1 });
  await watchdog.probeCandidatesInParallel(
    ['occupied'], 1, ['https://service-a.example/'], Date.now() + 15,
  );
  const startedAt = performance.now();
  const expired = await watchdog.probeCandidatesInParallel(
    ['expired'], 1, ['https://service-a.example/'], Date.now() + 20,
  );
  assert.ok(performance.now() - startedAt < 100);
  assert.equal(expired[0].samples[0].error, 'SCAN_DEADLINE');
  assert.equal(expired.probeStats.controllerRequests, 0);
  assert.equal(watchdog.candidateCapacityWaiters.size, 0);
  finishOccupied(100);
  await pause(0);
  assert.deepEqual(calls, ['occupied']);
  assert.equal(watchdog.activeCandidateRequests, 0);
});
