import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProbeScheduler,
  mapLimit,
  sleep,
  waitUntil,
} from '../src/probe-scheduler.mjs';

const baseProbes = { parallelism: 2, timeoutMs: 100 };

function makeScheduler(controller, probeOverrides = {}) {
  return createProbeScheduler({
    controller,
    config: { probes: { ...baseProbes, ...probeOverrides } },
    logger: async () => {},
  });
}

test('mapLimit keeps per-batch concurrency at the limit and preserves result order', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 3, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(10);
    active -= 1;
    return item * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 3);
});

test('waitUntil resolves before the deadline and rejects with SCAN_DEADLINE after it', async () => {
  assert.equal(await waitUntil(Promise.resolve(42), Date.now() + 500, '不应超时'), 42);
  await assert.rejects(
    waitUntil(new Promise(() => {}), Date.now() + 25, '探测截止测试'),
    (error) => error.code === 'SCAN_DEADLINE' && /探测截止测试/.test(error.message),
  );
  const transportError = Object.assign(new Error('socket closed'), { code: 'ECONNRESET' });
  await assert.rejects(
    waitUntil(Promise.reject(transportError), Date.now() + 500, '不应替代底层错误'),
    (error) => error.code === 'ECONNRESET',
  );
});

test('probeNode aggregates round/url samples from successes and failures', async () => {
  const calls = [];
  const controller = {
    async getDelay(node, url, timeoutMs) {
      calls.push({ node, url, timeoutMs });
      if (url === 'https://fail.example/') throw Object.assign(new Error('timeout'), { status: 504 });
      return 120;
    },
  };
  const scheduler = makeScheduler(controller);
  const result = await scheduler.probeNode('node-a', 2, ['https://ok.example/', 'https://fail.example/']);

  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://ok.example/', 'https://fail.example/', 'https://ok.example/', 'https://fail.example/',
  ]);
  assert.deepEqual(result.samples.map((sample) => [sample.round, sample.url, sample.ok]), [
    [1, 'https://ok.example/', true],
    [1, 'https://fail.example/', false],
    [2, 'https://ok.example/', true],
    [2, 'https://fail.example/', false],
  ]);
  assert.equal(result.samples[1].error, 504);
  assert.equal(result.attempts, 4);
  assert.equal(result.successes, 2);
  assert.equal(result.successRate, 0.5);
});

test('probeCandidatesInParallel serializes one node while running different nodes concurrently', async () => {
  const activeByNode = new Map();
  const maxByNode = new Map();
  let active = 0;
  let peak = 0;
  const controller = {
    async getDelay(node) {
      active += 1;
      peak = Math.max(peak, active);
      const nodeActive = (activeByNode.get(node) ?? 0) + 1;
      activeByNode.set(node, nodeActive);
      maxByNode.set(node, Math.max(maxByNode.get(node) ?? 0, nodeActive));
      await sleep(15);
      activeByNode.set(node, nodeActive - 1);
      active -= 1;
      return 111;
    },
  };
  const scheduler = makeScheduler(controller);
  const results = await scheduler.probeCandidatesInParallel(
    ['node-a', 'node-b'], 2, ['https://service.example/'], Date.now() + 1000,
  );

  assert.equal(results.length, 2);
  assert.equal(maxByNode.get('node-a'), 1);
  assert.equal(maxByNode.get('node-b'), 1);
  assert.equal(peak, 2);
  assert.deepEqual(results.probeStats, {
    method: 'per-node',
    logicalAttempts: 4,
    controllerRequests: 4,
    completedAttempts: 4,
    skippedAttempts: 0,
    peakConcurrency: 2,
  });
  assert.equal(results[0].successRate, 1);
  assert.equal(results[0].attempts, 2);
});

test('probeCandidatesInParallel shares the node lock across concurrent calls', async () => {
  let active = 0;
  let peak = 0;
  const controller = {
    async getDelay() {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(20);
      active -= 1;
      return 90;
    },
  };
  const scheduler = makeScheduler(controller);
  const [first, second] = await Promise.all([
    scheduler.probeNode('same-node', 1, ['https://service.example/']),
    scheduler.probeNode('same-node', 1, ['https://service.example/']),
  ]);
  assert.equal(first.successRate, 1);
  assert.equal(second.successRate, 1);
  assert.equal(peak, 1);
});

test('probeCandidatesInParallel marks every attempt as SCAN_DEADLINE when the deadline has passed', async () => {
  let requests = 0;
  const controller = {
    async getDelay() { requests += 1; return 100; },
  };
  const scheduler = makeScheduler(controller);
  const results = await scheduler.probeCandidatesInParallel(
    ['node-a', 'node-b'], 2, ['https://a.example/', 'https://b.example/'], Date.now() - 1,
  );

  assert.equal(requests, 0);
  assert.equal(results.every((entry) => entry.successRate === 0), true);
  assert.equal(results.every((entry) => entry.samples.every((sample) => sample.error === 'SCAN_DEADLINE')), true);
  assert.equal(results.probeStats.controllerRequests, 0);
  assert.equal(results.probeStats.skippedAttempts, 8);
});

test('failed requests release candidate capacity for later probes', async () => {
  const requestedNodes = [];
  const controller = {
    async getDelay(node) {
      requestedNodes.push(node);
      if (node !== 'node-ok') throw new Error('candidate unreachable');
      return 88;
    },
  };
  const scheduler = makeScheduler(controller, { parallelism: 1 });
  const failed = await scheduler.probeCandidatesInParallel(
    ['node-fail-a', 'node-fail-b'], 1, ['https://a.example/'], Date.now() + 2000,
  );
  assert.equal(failed.every((entry) => entry.successRate === 0), true);

  const recovered = await scheduler.probeCandidatesInParallel(
    ['node-ok'], 1, ['https://a.example/'], Date.now() + 300,
  );
  assert.equal(recovered[0].successRate, 1);
  assert.equal(recovered.probeStats.controllerRequests, 1);
  assert.deepEqual(requestedNodes, ['node-fail-a', 'node-fail-b', 'node-ok']);
});
