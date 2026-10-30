// 探测调度：节点锁、候选在途容量、逐节点探测与截止控制。
// 从 watchdog.mjs 原样迁出（逻辑未改），实例状态收进工厂闭包，便于单独测试与后续拆分。
import { summarizeSamples } from './health-policy.mjs';

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function waitUntil(promise, deadlineAt, message, clock = null) {
  const now = typeof clock?.now === 'function' ? clock.now : Date.now;
  const schedule = typeof clock?.setTimeout === 'function' ? clock.setTimeout : setTimeout;
  const cancelTimer = typeof clock?.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout;
  const remainingMs = Math.max(0, deadlineAt - now());
  return await new Promise((resolve, reject) => {
    const timer = schedule(() => reject(Object.assign(new Error(message), { code: 'SCAN_DEADLINE' })), remainingMs);
    promise.then(
      (value) => {
        cancelTimer(timer);
        resolve(value);
      },
      (error) => {
        cancelTimer(timer);
        reject(error);
      },
    );
  });
}

export function createProbeScheduler({ controller, config, logger, clock } = {}) {
  const probeClock = {
    now: typeof clock?.now === 'function' ? clock.now : Date.now,
    setTimeout: typeof clock?.setTimeout === 'function' ? clock.setTimeout : setTimeout,
    clearTimeout: typeof clock?.clearTimeout === 'function' ? clock.clearTimeout : clearTimeout,
  };
  const now = () => probeClock.now();
  const nodeProbeTails = new Map();
  const activeNodeProbes = new Map();
  let activeCandidateRequests = 0;
  const candidateCapacityWaiters = new Set();

  // 锁随真实 Controller 请求结束才释放；取消等待不能假装底层请求已停止。
  const requestNodeDelay = async (node, url, timeoutMs, deadlineAt, {
    background = false, candidate = false, signal, onStart = () => {}, onComplete = () => {},
  } = {}) => {
    const previous = nodeProbeTails.get(node) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    nodeProbeTails.set(node, tail);
    void tail.then(() => {
      if (nodeProbeTails.get(node) === tail) nodeProbeTails.delete(node);
    });
    const abortController = new AbortController();
    let rejectCancellation;
    const cancellation = new Promise((resolve, reject) => { rejectCancellation = reject; });
    const cancel = () => {
      abortController.abort();
      rejectCancellation(Object.assign(new Error('节点探测已取消'), { code: 'PROBE_CANCELLED' }));
    };
    // 先注册取消分支，已取消的 signal 也不会产生未处理 rejection。
    const ready = Promise.race([previous, cancellation]);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    if (!background && activeNodeProbes.get(node)?.background) {
      activeNodeProbes.get(node).cancel();
    }
    let request;
    let active;
    let releaseCapacity = () => {};
    try {
      await waitUntil(ready, deadlineAt, '节点探测等待超过截止时间', probeClock);
      active = { background, cancel };
      activeNodeProbes.set(node, active);
      if (candidate) {
        // 逻辑 worker 超时后可能继续运行；容量必须绑定仍未结束的真实请求。
        while (activeCandidateRequests >= config.probes.parallelism) {
          let wake;
          const capacityReady = new Promise((resolve) => { wake = resolve; });
          candidateCapacityWaiters.add(wake);
          try {
            await waitUntil(Promise.race([capacityReady, cancellation]), deadlineAt,
              '候选探测等待容量超过截止时间', probeClock);
          } finally {
            candidateCapacityWaiters.delete(wake);
          }
        }
      }
      if (abortController.signal.aborted || now() >= deadlineAt) {
        throw Object.assign(new Error('节点探测超过截止时间'), { code: 'SCAN_DEADLINE' });
      }
      if (candidate) {
        activeCandidateRequests += 1;
        releaseCapacity = () => {
          activeCandidateRequests -= 1;
          for (const wake of candidateCapacityWaiters) wake();
        };
      }
      onStart();
      request = Promise.resolve().then(() => controller.getDelay(
        node, url, Math.max(1, Math.min(timeoutMs, deadlineAt - now())),
        { signal: abortController.signal },
      ));
      void request.then(onComplete, onComplete).finally(() => {
        if (activeNodeProbes.get(node) === active) activeNodeProbes.delete(node);
        releaseCapacity();
        release();
      });
      return await waitUntil(
        Promise.race([request, cancellation]), deadlineAt, '节点探测超过截止时间', probeClock,
      );
    } finally {
      signal?.removeEventListener('abort', cancel);
      abortController.abort();
      if (!request) {
        if (activeNodeProbes.get(node) === active) activeNodeProbes.delete(node);
        releaseCapacity();
        release();
      }
    }
  };

  const probeNode = async (node, rounds, urls, { timeoutMs = config.probes.timeoutMs } = {}) => {
    const samples = [];
    for (let round = 1; round <= rounds; round += 1) {
      for (const url of urls) {
        try {
          const delay = await scheduler.requestNodeDelay(
            node, url, timeoutMs, now() + timeoutMs,
          );
          samples.push({ round, url, ok: true, delay });
        } catch (error) {
          samples.push({ round, url, ok: false, error: error.status ?? error.message });
        }
      }
    }
    return summarizeSamples(node, samples);
  };

  const probeCandidatesInParallel = async (nodes, rounds, urls, deadlineAt, {
    timeoutMs = config.probes.timeoutMs,
    background = false,
    signal,
  } = {}) => {
    const uniqueNodes = [...new Set(nodes)];
    const logicalAttempts = uniqueNodes.length * rounds * urls.length;
    let active = 0;
    let peakConcurrency = 0;
    let startedAttempts = 0;
    let completedAttempts = 0;
    // 同一节点的多轮/多 URL 探测必须串行，避免 Mihomo 同时对一个节点执行多个 URLTest 时互相争用；
    // 不同节点仍由 parallelism 控制并发，从而在截止内优先完整验证排名靠前的节点。
    const samplesByNode = await mapLimit(uniqueNodes, config.probes.parallelism, async (node) => {
      const nodeSamples = [];
      for (let round = 1; round <= rounds; round += 1) {
        for (const url of urls) {
          if (now() >= deadlineAt || signal?.aborted) {
            nodeSamples.push({ node, round, url, ok: false,
              error: signal?.aborted ? 'PROBE_CANCELLED' : 'SCAN_DEADLINE' });
            continue;
          }
          const remainingMs = Math.max(1, deadlineAt - now());
          const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
          try {
            const delay = await scheduler.requestNodeDelay(
              node, url, effectiveTimeoutMs, Math.min(deadlineAt, now() + effectiveTimeoutMs),
              { background, candidate: true, signal,
                onStart: () => {
                  active += 1;
                  startedAttempts += 1;
                  peakConcurrency = Math.max(peakConcurrency, active);
                },
                onComplete: () => { active -= 1; completedAttempts += 1; },
              },
            );
            nodeSamples.push({ node, round, url, ok: true, delay });
          } catch (error) {
            const deadlineReached = now() >= deadlineAt;
            nodeSamples.push({
              node,
              round,
              url,
              ok: false,
              error: deadlineReached ? 'SCAN_DEADLINE' : (error.status ?? error.code ?? error.message),
            });
          }
        }
      }
      return nodeSamples;
    });
    const samples = samplesByNode.flat();
    const results = uniqueNodes.map((node) => summarizeSamples(
      node,
      samples.filter((sample) => sample.node === node),
    ));
    Object.defineProperty(results, 'probeStats', {
      enumerable: false,
      value: {
        method: 'per-node',
        logicalAttempts,
        controllerRequests: startedAttempts,
        completedAttempts,
        skippedAttempts: logicalAttempts - startedAttempts,
        peakConcurrency,
      },
    });
    return results;
  };

  const scheduler = {
    requestNodeDelay,
    probeNode,
    probeCandidatesInParallel,
    waitUntil,
    sleep,
    mapLimit,
  };
  // 兼容既有实例内省（测试/诊断）：只暴露状态引用，不进入工厂返回契约。
  Object.defineProperty(scheduler, '_internals', {
    value: {
      nodeProbeTails,
      activeNodeProbes,
      candidateCapacityWaiters,
      get activeCandidateRequests() { return activeCandidateRequests; },
    },
    enumerable: false,
  });
  return scheduler;
}
