import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { consumeSwitchBudget, getSwitchBudget, recordRecoveryRollback } from './switch-budget.mjs';
import { synchronizeDecisionState } from './decision-state.mjs';

const GROUP_TYPES = new Set(['Selector', 'URLTest', 'Fallback', 'LoadBalance']);
const SELECTION_ADMISSION_VERSION = 1;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function mapLimit(items, limit, worker) {
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

async function waitUntil(promise, deadlineAt, message) {
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'SCAN_DEADLINE' })), remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function summarizeSamples(node, samples) {
  const successful = samples.filter((sample) => sample.ok);
  const delays = successful.map((sample) => sample.delay);
  const successRate = samples.length ? successful.length / samples.length : 0;
  const averageMs = delays.length ? delays.reduce((sum, value) => sum + value, 0) / delays.length : Infinity;
  const maxMs = delays.length ? Math.max(...delays) : Infinity;
  const variance = delays.length
    ? delays.reduce((sum, value) => sum + ((value - averageMs) ** 2), 0) / delays.length
    : Infinity;
  const jitterMs = Number.isFinite(variance) ? Math.sqrt(variance) : Infinity;
  const score = ((1 - successRate) * 1_000_000) + averageMs + (maxMs * 0.25) + (jitterMs * 0.5);
  return {
    node,
    attempts: samples.length,
    successes: successful.length,
    successRate,
    averageMs,
    maxMs,
    jitterMs,
    score,
    samples,
  };
}

function isStable(result, thresholds) {
  return result.successRate >= thresholds.minSuccessRate
    && result.averageMs <= thresholds.maxAverageMs
    && result.maxMs <= thresholds.maxSingleMs;
}

function isStableAcrossRounds(result, thresholds) {
  const samplesByRound = new Map();
  for (const sample of result.samples ?? []) {
    const round = sample.round ?? 1;
    if (!samplesByRound.has(round)) samplesByRound.set(round, []);
    samplesByRound.get(round).push(sample);
  }
  return samplesByRound.size > 0
    && [...samplesByRound.values()].every((samples) => isStable(
      summarizeSamples(result.node, samples),
      thresholds,
    ));
}

function hasCompleteProbeRounds(result, urls, minimumRounds) {
  const byRound = new Map();
  for (const sample of result?.samples ?? []) {
    if (['SCAN_DEADLINE', 'PROBE_CANCELLED', 'ABORT_ERR'].includes(sample.error)) return false;
    if (!byRound.has(sample.round)) byRound.set(sample.round, []);
    byRound.get(sample.round).push(sample.url);
  }
  const expected = JSON.stringify([...urls].sort());
  return byRound.size >= minimumRounds
    && Array.from({ length: minimumRounds }, (_, index) => index + 1)
      .every((round) => byRound.has(round))
    && [...byRound.values()].every((roundUrls) => JSON.stringify(roundUrls.sort()) === expected);
}

function hasStrictAdmissionEvidence(result, probes, thresholds) {
  return hasCompleteProbeRounds(result, probes.urls, Math.max(2, probes.validationRounds))
    && isStableAcrossRounds(result, thresholds);
}

function compareAvailability(a, b) {
  return b.successRate - a.successRate
    || a.averageMs - b.averageMs
    || a.maxMs - b.maxMs
    || a.jitterMs - b.jitterMs
    || a.node.localeCompare(b.node);
}

function isAvailabilityImprovement(candidate, current, policy) {
  if (candidate.successes <= 0 || candidate.successRate <= 0) return false;
  if (candidate.successRate > current.successRate) return true;
  if (candidate.successRate < current.successRate) return false;
  const required = Math.min(
    policy.minimumImprovementMs,
    current.averageMs * policy.minimumImprovementRatio,
  );
  return Number.isFinite(candidate.averageMs)
    && candidate.averageMs <= current.averageMs - required;
}

function explainRoundStability(result, thresholds) {
  const samplesByRound = new Map();
  for (const sample of result.samples ?? []) {
    const round = sample.round ?? 1;
    if (!samplesByRound.has(round)) samplesByRound.set(round, []);
    samplesByRound.get(round).push(sample);
  }
  const rounds = [...samplesByRound.entries()].map(([round, samples]) => {
    const summary = summarizeSamples(result.node, samples);
    const reasons = [];
    if (summary.successRate < thresholds.minSuccessRate) reasons.push('success-rate');
    if (summary.averageMs > thresholds.maxAverageMs) reasons.push('average-latency');
    if (summary.maxMs > thresholds.maxSingleMs) reasons.push('single-latency');
    return {
      round,
      stable: reasons.length === 0,
      reasons,
      successRate: summary.successRate,
      averageMs: Number.isFinite(summary.averageMs) ? Math.round(summary.averageMs) : null,
      maxMs: Number.isFinite(summary.maxMs) ? summary.maxMs : null,
    };
  });
  return {
    stable: rounds.length > 0 && rounds.every((round) => round.stable),
    reasons: [...new Set(rounds.flatMap((round) => round.reasons))],
    rounds,
  };
}

function recordDegradation(state, health, policy) {
  const windowSize = policy.degradationWindowCycles ?? 10;
  const degraded = health.status === 'latency-degraded' || health.status === 'latency-spike';
  state.degradationWindow = [
    ...(Array.isArray(state.degradationWindow) ? state.degradationWindow : []),
    { at: new Date().toISOString(), degraded, status: health.status },
  ].slice(-windowSize);
  const failures = state.degradationWindow.filter((entry) => entry.degraded).length;
  return {
    cycles: state.degradationWindow.length,
    failures,
    required: policy.degradationWindowFailures ?? 3,
    triggered: failures >= (policy.degradationWindowFailures ?? 3),
  };
}

function classifyHealth(result, thresholds, policy) {
  const emergency = result.successRate <= policy.emergencySuccessRate
    || result.averageMs > policy.emergencyMaxAverageMs;
  const latencySpike = !emergency && result.maxMs > policy.immediateMaxSingleMs;
  const stable = !emergency && !latencySpike && isStable(result, thresholds);
  const quality = emergency
    ? 'hard-failure'
    : (result.successRate < 1 ? 'partial-failure'
      : (result.averageMs <= 500 && result.maxMs <= 1000 ? 'excellent'
        : (result.averageMs <= 800 && result.maxMs <= 1500 ? 'acceptable'
          : (result.averageMs <= 1200 && result.maxMs <= 2500 ? 'degraded' : 'unacceptable'))));
  const status = stable
    ? 'healthy'
    : (emergency ? 'hard-failure'
      : (latencySpike ? 'latency-spike'
        : (result.successRate < thresholds.minSuccessRate ? 'partial-failure' : 'latency-degraded')));
  return { stable, emergency, status, quality };
}

function requiresImmediateResponse(health) {
  return health.status === 'hard-failure' || health.status === 'latency-spike';
}

function getActiveQuarantines(state) {
  state.quarantinedNodes ??= {};
  const now = Date.now();
  for (const [node, entry] of Object.entries(state.quarantinedNodes)) {
    if (!entry?.until || Date.parse(entry.until) <= now) delete state.quarantinedNodes[node];
  }
  return new Set(Object.keys(state.quarantinedNodes));
}

function quarantineNode(state, node, seconds, reason) {
  if (!node || seconds <= 0) return;
  state.quarantinedNodes ??= {};
  state.quarantinedNodes[node] = {
    until: new Date(Date.now() + (seconds * 1000)).toISOString(),
    reason,
  };
}

function activateCandidateScanBackoff(state, policy, reason) {
  const seconds = policy.candidateScanBackoffSeconds ?? 120;
  if (seconds <= 0) return;
  state.candidateScanBackoffUntil = new Date(Date.now() + (seconds * 1000)).toISOString();
  state.lastCandidateScanOutcome = reason;
}

function clearCandidateScanBackoff(state) {
  delete state.candidateScanBackoffUntil;
  delete state.lastCandidateScanOutcome;
}

export function createLogger(logFile, { quiet = false } = {}) {
  return async (level, event, details = {}) => {
    const record = { timestamp: new Date().toISOString(), level, event, ...details };
    await mkdir(path.dirname(logFile), { recursive: true });
    await appendFile(logFile, `${JSON.stringify(record)}\n`, 'utf8');
    if (!quiet) {
      const suffix = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
      console.log(`[${record.timestamp}] ${level.toUpperCase()} ${event}${suffix}`);
    }
  };
}

async function readState(stateFile) {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { consecutiveFailures: 0, lastSwitchAt: null };
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporary, stateFile);
}

export class Watchdog {
  constructor({ controller, config, logger, beforeSwitch = async () => {}, runtime = null }) {
    this.controller = controller;
    this.config = config;
    this.log = logger;
    this.beforeSwitch = beforeSwitch;
    this.runtime = runtime;
    this.activeCandidateScan = null;
    this.nodeProbeTails = new Map();
    this.activeNodeProbes = new Map();
    this.activeCandidateRequests = 0;
    this.candidateCapacityWaiters = new Set();
    // 锁随真实 Controller 请求结束才释放；取消等待不能假装底层请求已停止。
    this.requestNodeDelay = async (node, url, timeoutMs, deadlineAt, {
      background = false, candidate = false, signal, onStart = () => {}, onComplete = () => {},
    } = {}) => {
      const previous = this.nodeProbeTails.get(node) ?? Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const tail = previous.then(() => gate);
      this.nodeProbeTails.set(node, tail);
      void tail.then(() => {
        if (this.nodeProbeTails.get(node) === tail) this.nodeProbeTails.delete(node);
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
      if (!background && this.activeNodeProbes.get(node)?.background) {
        this.activeNodeProbes.get(node).cancel();
      }
      let request;
      let active;
      let releaseCapacity = () => {};
      try {
        await waitUntil(ready, deadlineAt, '节点探测等待超过截止时间');
        active = { background, cancel };
        this.activeNodeProbes.set(node, active);
        if (candidate) {
          // 逻辑 worker 超时后可能继续运行；容量必须绑定仍未结束的真实请求。
          while (this.activeCandidateRequests >= this.config.probes.parallelism) {
            let wake;
            const capacityReady = new Promise((resolve) => { wake = resolve; });
            this.candidateCapacityWaiters.add(wake);
            try {
              await waitUntil(Promise.race([capacityReady, cancellation]), deadlineAt,
                '候选探测等待容量超过截止时间');
            } finally {
              this.candidateCapacityWaiters.delete(wake);
            }
          }
        }
        if (abortController.signal.aborted || Date.now() >= deadlineAt) {
          throw Object.assign(new Error('节点探测超过截止时间'), { code: 'SCAN_DEADLINE' });
        }
        if (candidate) {
          this.activeCandidateRequests += 1;
          releaseCapacity = () => {
            this.activeCandidateRequests -= 1;
            for (const wake of this.candidateCapacityWaiters) wake();
          };
        }
        onStart();
        request = Promise.resolve().then(() => this.controller.getDelay(
          node, url, Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now())),
          { signal: abortController.signal },
        ));
        void request.then(onComplete, onComplete).finally(() => {
          if (this.activeNodeProbes.get(node) === active) this.activeNodeProbes.delete(node);
          releaseCapacity();
          release();
        });
        return await waitUntil(
          Promise.race([request, cancellation]), deadlineAt, '节点探测超过截止时间',
        );
      } finally {
        signal?.removeEventListener('abort', cancel);
        abortController.abort();
        if (!request) {
          if (this.activeNodeProbes.get(node) === active) this.activeNodeProbes.delete(node);
          releaseCapacity();
          release();
        }
      }
    };
  }

  candidateScanMatches(scan, selection, leaf) {
    return scan?.selection === selection && scan?.leaf === leaf;
  }

  startBackgroundCandidateScan({
    selection,
    leaf,
    excludedNodes,
    allowProvisionalRecovery,
    reason,
    recovery = allowProvisionalRecovery,
  }) {
    this.activeCandidateScan?.cancel?.();
    const abortController = new AbortController();
    const scan = {
      selection,
      leaf,
      reason,
      recovery,
      startedAt: new Date().toISOString(),
      completed: false,
      invalidated: false,
      result: null,
      error: null,
      cancel: () => abortController.abort(),
    };
    scan.promise = this.findCandidates(leaf, excludedNodes, {
      allowProvisionalRecovery, background: true, signal: abortController.signal,
    })
      .then((result) => {
        result.completedAt ??= new Date().toISOString();
        scan.result = result;
        scan.completedAt = result.completedAt;
        scan.completed = true;
        return scan;
      })
      .catch((error) => {
        scan.error = error;
        scan.completed = true;
        return scan;
      });
    this.activeCandidateScan = scan;
    return scan;
  }

  async resolveLeaf(name) {
    const visited = new Set();
    let current = name;
    for (let depth = 0; depth < 8; depth += 1) {
      if (visited.has(current)) throw new Error(`代理组形成循环：${current}`);
      visited.add(current);
      const proxy = await this.controller.getProxy(current);
      if (!GROUP_TYPES.has(proxy.type) || !proxy.now || proxy.now === current) return current;
      current = proxy.now;
    }
    throw new Error(`代理组层级过深：${name}`);
  }

  async probeNode(node, rounds, urls) {
    const samples = [];
    for (let round = 1; round <= rounds; round += 1) {
      for (const url of urls) {
        try {
          const delay = await this.requestNodeDelay(
            node, url, this.config.probes.timeoutMs, Date.now() + this.config.probes.timeoutMs,
          );
          samples.push({ round, url, ok: true, delay });
        } catch (error) {
          samples.push({ round, url, ok: false, error: error.status ?? error.message });
        }
      }
    }
    return summarizeSamples(node, samples);
  }

  async probeCandidatesInParallel(nodes, rounds, urls, deadlineAt, {
    timeoutMs = this.config.probes.timeoutMs,
    background = false,
    signal,
  } = {}) {
    const uniqueNodes = [...new Set(nodes)];
    const logicalAttempts = uniqueNodes.length * rounds * urls.length;
    let active = 0;
    let peakConcurrency = 0;
    let startedAttempts = 0;
    let completedAttempts = 0;
    // 同一节点的多轮/多 URL 探测必须串行，避免 Mihomo 同时对一个节点执行多个 URLTest 时互相争用；
    // 不同节点仍由 parallelism 控制并发，从而在截止内优先完整验证排名靠前的节点。
    const samplesByNode = await mapLimit(uniqueNodes, this.config.probes.parallelism, async (node) => {
      const nodeSamples = [];
      for (let round = 1; round <= rounds; round += 1) {
        for (const url of urls) {
          if (Date.now() >= deadlineAt || signal?.aborted) {
            nodeSamples.push({ node, round, url, ok: false,
              error: signal?.aborted ? 'PROBE_CANCELLED' : 'SCAN_DEADLINE' });
            continue;
          }
          const remainingMs = Math.max(1, deadlineAt - Date.now());
          const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remainingMs));
          try {
            const delay = await this.requestNodeDelay(
              node, url, effectiveTimeoutMs, Math.min(deadlineAt, Date.now() + effectiveTimeoutMs),
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
            const deadlineReached = Date.now() >= deadlineAt;
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
  }

  createCandidateSnapshot(search, selection, leaf) {
    const compact = (result) => ({
      node: result.node,
      attempts: result.attempts,
      successes: result.successes,
      successRate: result.successRate,
      averageMs: Number.isFinite(result.averageMs) ? result.averageMs : null,
      maxMs: Number.isFinite(result.maxMs) ? result.maxMs : null,
      jitterMs: Number.isFinite(result.jitterMs) ? result.jitterMs : null,
      score: Number.isFinite(result.score) ? result.score : null,
    });
    const strictNames = new Set(search.stable.map((entry) => entry.node));
    const provisionalNames = new Set((search.provisional ?? []).map((entry) => entry.node));
    return {
      at: search.completedAt ?? new Date().toISOString(),
      selection,
      leaf,
      durationMs: search.durationMs,
      deadlineMs: search.deadlineMs,
      deadlineReached: search.deadlineReached,
      probeStats: search.probeStats ?? null,
      candidates: (search.validated ?? []).map((entry) => ({
        ...compact(entry),
        profile: strictNames.has(entry.node)
          ? 'strict'
          : (provisionalNames.has(entry.node) ? 'current-health' : 'rejected'),
      })),
      sampled: (search.sampled ?? []).map(compact),
    };
  }

  searchFromCandidateSnapshot(snapshot, selection, leaf) {
    if (!snapshot || snapshot.selection !== selection || snapshot.leaf !== leaf) return null;
    const ageMs = Date.now() - Date.parse(snapshot.at ?? '');
    if (!Number.isFinite(ageMs)
        || ageMs > this.config.policy.candidateSnapshotMaxAgeSeconds * 1000) return null;
    const inflate = (entry) => ({
      ...entry,
      averageMs: entry.averageMs ?? Infinity,
      maxMs: entry.maxMs ?? Infinity,
      jitterMs: entry.jitterMs ?? Infinity,
      score: entry.score ?? Infinity,
      samples: [],
    });
    const validated = (snapshot.candidates ?? []).map(inflate);
    return {
      stable: validated.filter((entry) => entry.profile === 'strict'),
      provisional: validated.filter((entry) => entry.profile === 'current-health'),
      validated,
      sampled: (snapshot.sampled ?? []).map(inflate),
      rejected: validated.filter((entry) => entry.profile === 'rejected')
        .map((entry) => ({ node: entry.node, reasons: ['cached-rejected'] })),
      durationMs: snapshot.durationMs,
      deadlineMs: snapshot.deadlineMs,
      deadlineReached: snapshot.deadlineReached,
      probeStats: snapshot.probeStats ?? null,
      completedAt: snapshot.at,
      source: 'candidate-snapshot',
      ageMs,
    };
  }

  currentThresholds() {
    return {
      minSuccessRate: this.config.probes.currentMinSuccessRate,
      maxAverageMs: this.config.probes.currentMaxAverageMs,
      maxSingleMs: this.config.probes.currentMaxSingleMs,
    };
  }

  candidateThresholds() {
    return {
      minSuccessRate: this.config.probes.candidateMinSuccessRate,
      maxAverageMs: this.config.probes.candidateMaxAverageMs,
      maxSingleMs: this.config.probes.candidateMaxSingleMs,
    };
  }

  filterCandidates(candidates, currentLeaf, excludedNodes = new Set()) {
    const include = this.config.probes.includeRegex ? new RegExp(this.config.probes.includeRegex, 'i') : null;
    const exclude = this.config.probes.excludeRegex ? new RegExp(this.config.probes.excludeRegex, 'i') : null;
    return [...new Set(candidates)].filter((name) => name !== currentLeaf
      && !excludedNodes.has(name)
      && (!include || include.test(name))
      && (!exclude || !exclude.test(name)));
  }

  async discoverCandidates(candidates, scanUrls, deadlineAt, {
    rounds = this.config.probes.scanRounds,
    timeoutMs = this.config.probes.discoveryTimeoutMs,
    event = 'candidate-discovery-completed',
    background = false,
    signal,
  } = {}) {
    const startedAt = Date.now();
    // 组级 delay 会隐式探测当前节点，无法与健康检查逐节点互斥。
    // 仅探测候选池，确保每个节点的轮次与业务目标始终串行。
    const results = await this.probeCandidatesInParallel(
      candidates, rounds, scanUrls, deadlineAt, { timeoutMs, background, signal },
    );
    const probeStats = results.probeStats;
    const failureReasons = {};
    for (const sample of results.flatMap((result) => result.samples)) {
      if (sample.ok) continue;
      const reason = Number.isInteger(sample.error) ? `HTTP_${sample.error}`
        : (/^[A-Z][A-Z0-9_]{0,63}$/.test(sample.error) ? sample.error : 'OTHER');
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
    await this.log('info', event, {
      method: probeStats.method,
      durationMs: Date.now() - startedAt,
      candidateCount: candidates.length,
      responsiveCount: results.filter((result) => result.successes > 0).length,
      failureReasons,
      probeStats,
    });
    return results;
  }

  async findCandidates(currentLeaf, excludedNodes = new Set(), {
    allowProvisionalRecovery = false, background = false, signal,
  } = {}) {
    const scanStartedAt = Date.now();
    let deadlineMs = this.config.probes.scanDeadlineMs;
    let deadlineAt = scanStartedAt + deadlineMs;
    const source = await waitUntil(
      this.controller.getProxy(this.config.groups.candidates),
      deadlineAt,
      '候选组读取超过扫描截止时间',
    );
    if (!Array.isArray(source.all) || source.all.length === 0) {
      await this.log('error', 'candidate-source-empty', { group: this.config.groups.candidates });
      return {
        stable: [],
        provisional: [],
        sampled: [],
        validated: [],
        rejected: [],
        durationMs: Date.now() - scanStartedAt,
        deadlineMs: this.config.probes.scanDeadlineMs,
        deadlineReached: false,
      };
    }
    const candidates = this.filterCandidates(source.all, currentLeaf, excludedNodes);
    const scanUrls = this.config.probes.urls.slice(0, this.config.probes.scanUrlCount);
    // 后台发现须能保留慢速可达出口；快速初筛超时不能成为救援资格门槛。
    const discoveryTimeoutMs = background
      ? Math.max(this.config.probes.discoveryTimeoutMs, this.config.probes.timeoutMs)
      : this.config.probes.discoveryTimeoutMs;
    if (background) {
      // 后台允许完成现有配置要求的全部样本；紧急发现仍由原 scanDeadlineMs 约束。
      const batches = (count) => Math.ceil(count / this.config.probes.parallelism);
      deadlineMs += batches(candidates.length) * this.config.probes.scanRounds
        * scanUrls.length * discoveryTimeoutMs;
      deadlineMs += batches(Math.min(candidates.length, this.config.probes.maxValidationCandidates))
        * Math.max(2, this.config.probes.validationRounds)
        * this.config.probes.urls.length * this.config.probes.timeoutMs;
      deadlineAt = scanStartedAt + deadlineMs;
    }
    await this.log('info', 'candidate-scan-started', {
      count: candidates.length, background, deadlineMs,
    });
    const quickResults = await this.discoverCandidates(candidates, scanUrls, deadlineAt, {
      background, signal, timeoutMs: discoveryTimeoutMs,
    });
    const ranked = quickResults
      .filter((result) => result.successes > 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, this.config.probes.maxValidationCandidates);
    await this.log('info', 'candidate-shortlist', {
      nodes: ranked.map((result) => ({
        node: result.node,
        successRate: result.successRate,
        averageMs: Math.round(result.averageMs),
      })),
    });
    const validated = await this.discoverCandidates(
      ranked.map((result) => result.node),
      this.config.probes.urls,
      deadlineAt,
      {
        rounds: Math.max(2, this.config.probes.validationRounds),
        timeoutMs: this.config.probes.timeoutMs,
        event: 'candidate-validation-probes-completed',
        background, signal,
      },
    );
    const validationProbeStats = validated.probeStats ?? {
      method: 'per-node',
      logicalAttempts: 0,
      controllerRequests: 0,
      completedRequests: 0,
      peakConcurrency: 0,
    };
    const stable = [];
    const provisional = [];
    const hasCompleteSamples = (result) => hasCompleteProbeRounds(
      result, this.config.probes.urls, Math.max(2, this.config.probes.validationRounds),
    );
    const strictResults = validated.filter((result) => hasStrictAdmissionEvidence(
      result, this.config.probes, this.candidateThresholds(),
    ));
    stable.push(...strictResults);
    provisional.push(...validated.filter((result) => !strictResults.includes(result)
      && hasCompleteSamples(result)
      && isStableAcrossRounds(result, this.currentThresholds())));
    stable.sort((a, b) => a.score - b.score);
    provisional.sort((a, b) => a.score - b.score);
    const rejected = validated
      .filter((result) => !stable.includes(result))
      .map((result) => ({ node: result.node, ...explainRoundStability(result, this.candidateThresholds()) }));
    await this.log('info', 'candidate-validation-completed', {
      validatedCount: validated.length,
      stable: stable.map((result) => ({
        node: result.node,
        successRate: result.successRate,
        averageMs: Math.round(result.averageMs),
        maxMs: result.maxMs,
      })),
      provisional: provisional.map((result) => ({
        node: result.node,
        successRate: result.successRate,
        averageMs: Math.round(result.averageMs),
        maxMs: result.maxMs,
      })),
      rejected,
      probeStats: {
        discovery: quickResults.probeStats ?? null,
        validation: validationProbeStats,
      },
      durationMs: Date.now() - scanStartedAt,
      deadlineMs,
      deadlineReached: Date.now() >= deadlineAt,
    });
    return {
      stable,
      provisional,
      sampled: quickResults,
      validated,
      rejected,
      probeStats: {
        discovery: quickResults.probeStats ?? null,
        validation: validationProbeStats,
      },
      durationMs: Date.now() - scanStartedAt,
      deadlineMs,
      deadlineReached: Date.now() >= deadlineAt,
    };
  }

  async detectUpstreamOutage(currentLeaf, current, sampledCandidates) {
    const controlUrls = this.config.probes.controlUrls ?? [];
    const minimumCandidates = this.config.policy.upstreamFailureMinCandidates ?? 3;
    if (controlUrls.length === 0 || current.successRate > 0) return null;
    const failedCandidates = sampledCandidates.filter((result) => result.successRate === 0);
    if (failedCandidates.length < minimumCandidates) return null;
    const control = await this.probeNode(currentLeaf, 1, controlUrls);
    if (control.successRate < 1) return null;
    return {
      control,
      failedCandidateCount: failedCandidates.length,
      minimumCandidates,
    };
  }

  async runOnce({ dryRun = true, forceScan = false, linkTelemetry, backgroundScan = false } = {}) {
    const state = await readState(this.config.files.state);
    if (!this.activeCandidateScan && state.candidateScan?.status === 'running') delete state.candidateScan;
    if (this.runtime) state.runtime = this.runtime;
    const setDecision = (action, reason, details = {}) => {
      state.lastDecision = { at: new Date().toISOString(), action, reason, ...details };
    };
    const persistState = async () => {
      synchronizeDecisionState(state, this.config.policy, { probes: this.config.probes });
      if (!dryRun) await writeState(this.config.files.state, state);
    };
    const recordEvaluation = (result, evaluatedHealth, selected, leaf, linkFailures = []) => {
      state.lastEvaluation = {
        timestamp: new Date().toISOString(), selected, leaf,
        successRate: result.successRate,
        averageMs: Number.isFinite(result.averageMs) ? result.averageMs : null,
        maxMs: Number.isFinite(result.maxMs) ? result.maxMs : null,
        health: evaluatedHealth.status, quality: evaluatedHealth.quality,
        stable: evaluatedHealth.stable,
        linkFailures,
      };
    };
    const recordAdmission = (profile, selection, leaf) => {
      state.selectionAdmission = {
        profile, selection, leaf, at: new Date().toISOString(),
        verified: profile === 'strict', requiresStrictAdmission: profile !== 'strict',
      };
    };
    const target = await this.controller.getProxy(this.config.groups.target);
    const previousSelection = target.now;
    const currentLeaf = await this.resolveLeaf(previousSelection);
    const nestedSelection = previousSelection !== currentLeaf;
    const nestedLeafSelectable = Array.isArray(target.all) && target.all.includes(currentLeaf);
    const nestedNormalizationRequired = nestedSelection && nestedLeafSelectable;
    getActiveQuarantines(state);
    const acceptedSelection = state.currentSelection ?? null;
    const acceptedLeaf = state.currentLeaf ?? null;
    const baselineRevalidationRequired = Boolean(acceptedSelection || acceptedLeaf)
      && (state.selectionAdmissionVersion !== SELECTION_ADMISSION_VERSION
        || !state.selectionAdmission);
    const selectionChanged = Boolean(acceptedSelection && acceptedSelection !== previousSelection);
    const leafChanged = Boolean(acceptedLeaf && acceptedLeaf !== currentLeaf);
    const pendingMatchesObserved = state.externalSelectionPendingAdmission?.to === previousSelection
      && state.externalSelectionPendingAdmission?.leaf === currentLeaf;
    let externalChangeDetected = false;
    let baselineRevalidationStarted = false;
    if ((selectionChanged || leafChanged || nestedNormalizationRequired) && !pendingMatchesObserved) {
      externalChangeDetected = true;
      state.externalSelectionPendingAdmission = {
        from: acceptedSelection,
        fromLeaf: acceptedLeaf,
        to: previousSelection,
        leaf: currentLeaf,
        detectedAt: new Date().toISOString(),
        source: 'external',
      };
      await this.log('warn', 'external-selection-detected', {
        expected: acceptedSelection,
        expectedLeaf: acceptedLeaf,
        observed: previousSelection,
        observedLeaf: currentLeaf,
      });
    } else if (state.externalSelectionPendingAdmission
        && !pendingMatchesObserved
        && !selectionChanged && !leafChanged) {
      const stalePending = state.externalSelectionPendingAdmission;
      await this.log('info', stalePending.source === 'baseline'
        ? 'stale-baseline-admission-superseded'
        : 'external-selection-reverted', {
        expected: acceptedSelection,
        expectedLeaf: acceptedLeaf,
        observed: previousSelection,
        observedLeaf: currentLeaf,
        stalePendingTo: stalePending.to,
        stalePendingLeaf: stalePending.leaf,
      });
      delete state.externalSelectionPendingAdmission;
      if (state.provisionalFallback
          && (state.provisionalFallback.selection !== previousSelection
            || state.provisionalFallback.leaf !== currentLeaf)) {
        delete state.provisionalFallback;
      }
    }

    if (!state.externalSelectionPendingAdmission && baselineRevalidationRequired
        && !selectionChanged && !leafChanged) {
      baselineRevalidationStarted = true;
      state.externalSelectionPendingAdmission = {
        from: acceptedSelection,
        fromLeaf: acceptedLeaf,
        to: previousSelection,
        leaf: currentLeaf,
        detectedAt: new Date().toISOString(),
        source: 'baseline',
      };
    }

    const pendingAdmission = state.externalSelectionPendingAdmission?.to === previousSelection
      && state.externalSelectionPendingAdmission?.leaf === currentLeaf
      ? state.externalSelectionPendingAdmission
      : null;
    const baselineRevalidation = pendingAdmission?.source === 'baseline';
    if (nestedNormalizationRequired) {
      if (dryRun) {
        setDecision('recommend', 'nested-selection-would-normalize', {
          from: previousSelection,
          to: currentLeaf,
        });
        await this.log('info', 'nested-selection-normalization-dry-run', {
          from: previousSelection,
          to: currentLeaf,
        });
        return { status: 'would-normalize-nested-selection', from: previousSelection, to: currentLeaf };
      }
      await this.beforeSwitch();
      await this.controller.select(this.config.groups.target, currentLeaf);
      const normalizedTarget = await this.controller.getProxy(this.config.groups.target);
      const normalizedLeaf = await this.resolveLeaf(normalizedTarget.now);
      if (normalizedTarget.now !== currentLeaf || normalizedLeaf !== currentLeaf) {
        throw new Error(`嵌套代理组规范化失败：期望 ${currentLeaf}，实际 ${normalizedTarget.now}`);
      }
      const normalizedAt = new Date().toISOString();
      state.currentSelection = currentLeaf;
      state.currentLeaf = currentLeaf;
      recordAdmission('pending', currentLeaf, currentLeaf);
      delete state.selectionAdmissionVersion;
      state.externalSelectionPendingAdmission = {
        from: acceptedSelection,
        fromLeaf: acceptedLeaf,
        to: currentLeaf,
        leaf: currentLeaf,
        detectedAt: normalizedAt,
        source: 'external',
      };
      state.lastSelectionNormalization = {
        at: normalizedAt,
        from: previousSelection,
        to: currentLeaf,
        reason: 'nested-selection',
        requiresStrictAdmission: true,
      };
      setDecision('repair', 'nested-selection-normalized-pending-admission', {
        from: previousSelection,
        to: currentLeaf,
      });
      await persistState();
      await this.log('warn', 'nested-selection-normalized', {
        from: previousSelection,
        to: currentLeaf,
        leaf: currentLeaf,
        requiresStrictAdmission: true,
      });
      return { status: 'nested-selection-normalized-pending-admission', from: previousSelection, to: currentLeaf };
    }
    let selectionAdmissionRejected = false;
    let current;
    if (pendingAdmission) {
      current = await this.probeNode(
        currentLeaf,
        Math.max(2, this.config.probes.validationRounds),
        this.config.probes.urls,
      );
      const admitted = hasStrictAdmissionEvidence(current, this.config.probes, this.candidateThresholds());
      const admissionRecord = {
        at: new Date().toISOString(),
        from: pendingAdmission.from,
        fromLeaf: pendingAdmission.fromLeaf,
        to: previousSelection,
        leaf: currentLeaf,
        verified: admitted,
      };
      if (baselineRevalidation) state.lastBaselineRevalidation = admissionRecord;
      else state.lastExternalSelection = admissionRecord;
      await this.log(
        admitted ? 'info' : 'warn',
        baselineRevalidation ? 'baseline-revalidation' : 'external-selection-validation-completed',
        {
          from: pendingAdmission.from,
          fromLeaf: pendingAdmission.fromLeaf,
          to: previousSelection,
          leaf: currentLeaf,
          admitted,
          successRate: current.successRate,
          averageMs: Number.isFinite(current.averageMs) ? Math.round(current.averageMs) : null,
          maxMs: Number.isFinite(current.maxMs) ? current.maxMs : null,
          normalizationRequired: nestedNormalizationRequired,
          normalizationSupported: !nestedSelection || nestedLeafSelectable,
        },
      );
      if (admitted) {
        state.currentSelection = previousSelection;
        state.currentLeaf = currentLeaf;
        state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
        recordAdmission('strict', previousSelection, currentLeaf);
        delete state.externalSelectionPendingAdmission;
        delete state.provisionalFallback;
        state.degradationWindow = [];
        state.lastOptimizationScanAt = new Date().toISOString();
        if (state.lastSwitch?.to === previousSelection && state.lastSwitch.verified === false) {
          state.lastSwitch = {
            ...state.lastSwitch,
            provisionalReason: state.lastSwitch.reason,
            reason: 'strict-admission-recovered',
            verified: true,
            strictlyAdmittedAt: state.lastOptimizationScanAt,
          };
        }
        delete state.quarantinedNodes[currentLeaf];
        delete state.quarantinedNodes[previousSelection];
      } else {
        selectionAdmissionRejected = true;
        recordAdmission(isStableAcrossRounds(current, this.currentThresholds()) ? 'usable' : 'pending',
          previousSelection, currentLeaf);
      }
    } else {
      state.currentSelection = previousSelection;
      state.currentLeaf = currentLeaf;
      if (!acceptedSelection && !acceptedLeaf) {
        recordAdmission('pending', previousSelection, currentLeaf);
      }
      if (state.selectionAdmissionVersion === SELECTION_ADMISSION_VERSION
          && state.lastSwitch?.to === previousSelection
          && state.lastSwitch.verified === false
          && !state.provisionalFallback) {
        state.lastSwitch = {
          ...state.lastSwitch,
          provisionalReason: state.lastSwitch.reason,
          reason: 'strict-admission-recovered',
          verified: true,
          strictlyAdmittedAt: state.lastHealthyAt ?? new Date().toISOString(),
        };
      }
      delete state.quarantinedNodes[currentLeaf];
      delete state.quarantinedNodes[previousSelection];
      current = await this.probeNode(currentLeaf, this.config.probes.currentRounds, this.config.probes.urls);
      if (!acceptedSelection && !acceptedLeaf) {
        const initialStrict = hasStrictAdmissionEvidence(current, this.config.probes, this.candidateThresholds());
        if (initialStrict) {
          state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
          recordAdmission('strict', previousSelection, currentLeaf);
        } else {
          recordAdmission(isStableAcrossRounds(current, this.currentThresholds()) ? 'usable' : 'pending',
            previousSelection, currentLeaf);
          state.externalSelectionPendingAdmission = {
            to: previousSelection, leaf: currentLeaf, source: 'baseline',
            detectedAt: new Date().toISOString(),
          };
        }
      }
    }
    const linkFailures = linkTelemetry?.enabled === true
      ? ['https', 'websocket'].filter((kind) => linkTelemetry[kind]?.networkOk === false)
      : [];
    const applyLinkHealth = (probeHealth) => {
      if (linkFailures.length === 0 || requiresImmediateResponse(probeHealth)) return probeHealth;
      return {
        stable: false,
        emergency: false,
        status: 'partial-failure',
        quality: 'partial-failure',
      };
    };
    let health = applyLinkHealth(classifyHealth(current, this.currentThresholds(), this.config.policy));
    state.currentSelection = previousSelection;
    state.currentLeaf = currentLeaf;
    let availabilityRecoveryRequired = current.successRate < 1 || requiresImmediateResponse(health)
      || linkFailures.length > 0;
    recordEvaluation(current, health, previousSelection, currentLeaf, linkFailures);
    if (selectionAdmissionRejected && health.stable) {
      state.lastOptimizationScanAt ??= new Date().toISOString();
    }
    await this.log(health.stable ? 'info' : 'warn', 'current-node-evaluated', {
      selected: previousSelection,
      leaf: currentLeaf,
      stable: health.stable,
      health: health.status,
      quality: health.quality,
      successRate: current.successRate,
      averageMs: Number.isFinite(current.averageMs) ? Math.round(current.averageMs) : null,
      maxMs: Number.isFinite(current.maxMs) ? current.maxMs : null,
      linkFailures,
      selectionSource: pendingAdmission ? (baselineRevalidation ? 'baseline' : 'external') : 'accepted',
      strictAdmission: Boolean(pendingAdmission),
    });

    const runningScan = this.activeCandidateScan;
    if (runningScan && (!this.candidateScanMatches(runningScan, previousSelection, currentLeaf)
        || (runningScan.recovery && health.stable))) {
      runningScan.invalidated = true;
      runningScan.cancel?.();
      runningScan.invalidatedReason = health.stable ? 'current-recovered' : 'selection-changed';
    }
    if (runningScan?.completed && runningScan.invalidated) {
      await this.log('info', 'candidate-scan-result-discarded', {
        reason: runningScan.invalidatedReason,
        selection: runningScan.selection,
        leaf: runningScan.leaf,
      });
      this.activeCandidateScan = null;
      delete state.candidateScan;
    }

    const degradation = recordDegradation(state, health, this.config.policy);
    const optimizationIntervalMs = (this.config.policy.optimizationIntervalSeconds ?? 0) * 1000;
    const lastOptimizationScanAt = Date.parse(state.lastOptimizationScanAt ?? '');
    const optimizationDue = health.stable
      && health.quality !== 'excellent'
      && (!pendingAdmission || state.selectionAdmission?.profile === 'usable')
      && optimizationIntervalMs > 0
      && (!Number.isFinite(lastOptimizationScanAt)
        || Date.now() - lastOptimizationScanAt >= optimizationIntervalMs);
    const rollingDegradationTriggered = degradation.triggered
      && (health.stable || health.status === 'latency-degraded');
    let scanReason = selectionAdmissionRejected
      ? (baselineRevalidation ? 'baseline-revalidation-rejected' : 'external-selection-rejected')
      : (rollingDegradationTriggered ? 'rolling-latency-degradation'
        : (optimizationDue ? 'periodic-optimization' : health.status));

    let snapshotWake = null;
    let snapshotStartedThisCycle = false;
    if (backgroundScan && !forceScan) {
      const snapshotScan = this.activeCandidateScan;
      if (snapshotScan?.completed && !snapshotScan.invalidated
          && this.candidateScanMatches(snapshotScan, previousSelection, currentLeaf)) {
        if (snapshotScan.error) {
          await this.log('warn', 'candidate-snapshot-refresh-failed', {
            errorType: snapshotScan.error?.code ?? snapshotScan.error?.name ?? 'Error',
          });
        } else {
          state.candidateSnapshot = this.createCandidateSnapshot(
            snapshotScan.result,
            previousSelection,
            currentLeaf,
          );
          await this.log('info', 'candidate-snapshot-refreshed', {
            candidateCount: state.candidateSnapshot.candidates.length,
            durationMs: state.candidateSnapshot.durationMs,
          });
        }
        this.activeCandidateScan = null;
        delete state.candidateScan;
      }
      const snapshotAgeMs = Date.now() - Date.parse(state.candidateSnapshot?.at ?? '');
      const snapshotMatches = state.candidateSnapshot?.selection === previousSelection
        && state.candidateSnapshot?.leaf === currentLeaf;
      const refreshDue = !snapshotMatches || !Number.isFinite(snapshotAgeMs)
        || snapshotAgeMs >= this.config.policy.candidateSnapshotRefreshSeconds * 1000;
      if (!this.activeCandidateScan && refreshDue) {
        const scan = this.startBackgroundCandidateScan({
          selection: previousSelection,
          leaf: currentLeaf,
          excludedNodes: getActiveQuarantines(state),
          allowProvisionalRecovery: true,
          reason: 'candidate-snapshot-refresh',
          recovery: false,
        });
        state.candidateScan = {
          status: 'running',
          startedAt: scan.startedAt,
          reason: 'candidate-snapshot-refresh',
        };
        snapshotWake = scan.promise;
        snapshotStartedThisCycle = true;
        await this.log('info', 'candidate-snapshot-refresh-started', {
          selection: previousSelection,
          leaf: currentLeaf,
        });
      } else {
        snapshotWake = this.activeCandidateScan?.promise ?? null;
      }
    }

    if (health.stable && !forceScan
      && !rollingDegradationTriggered && !optimizationDue) {
      state.consecutiveFailures = 0;
      state.consecutivePartialFailures = 0;
      state.consecutiveLatencyFailures = 0;
      state.lastHealthyAt = new Date().toISOString();
      clearCandidateScanBackoff(state);
      setDecision('hold', selectionAdmissionRejected ? 'strict-admission-pending' : 'healthy');
      await persistState();
      return {
        status: selectionAdmissionRejected ? 'usable-pending-admission' : pendingAdmission
          ? (baselineRevalidation ? 'baseline-revalidated' : 'external-selection-admitted')
          : 'healthy',
        current,
        backgroundWake: snapshotWake ?? this.activeCandidateScan?.promise ?? null,
      };
    }

    if (!forceScan && requiresImmediateResponse(health)
      && this.config.policy.hardFailureConfirmSeconds > 0) {
      const initialStatus = health.status;
      await sleep(this.config.policy.hardFailureConfirmSeconds * 1000);
      const confirmation = await this.probeNode(currentLeaf, 1, this.config.probes.urls);
      const confirmedHealth = applyLinkHealth(
        classifyHealth(confirmation, this.currentThresholds(), this.config.policy),
      );
      const confirmedImmediate = requiresImmediateResponse(confirmedHealth);
      await this.log(confirmedImmediate ? 'error' : 'info', 'immediate-failure-confirmed', {
        trigger: initialStatus,
        confirmed: confirmedImmediate,
        health: confirmedHealth.status,
        quality: confirmedHealth.quality,
        successRate: confirmation.successRate,
        averageMs: Number.isFinite(confirmation.averageMs) ? Math.round(confirmation.averageMs) : null,
        maxMs: Number.isFinite(confirmation.maxMs) ? confirmation.maxMs : null,
      });
      current = confirmation;
      health = confirmedHealth;
      availabilityRecoveryRequired = current.successRate < 1 || requiresImmediateResponse(health)
        || linkFailures.length > 0;
      recordEvaluation(current, health, previousSelection, currentLeaf, linkFailures);
      await this.log(health.stable ? 'info' : 'warn', 'current-node-evaluated', {
        selected: previousSelection,
        leaf: currentLeaf,
        stable: health.stable,
        health: health.status,
        quality: health.quality,
        successRate: current.successRate,
        averageMs: Number.isFinite(current.averageMs) ? Math.round(current.averageMs) : null,
        maxMs: Number.isFinite(current.maxMs) ? current.maxMs : null,
        linkFailures,
        selectionSource: 'immediate-confirmation',
        strictAdmission: false,
      });
      if (health.stable && !rollingDegradationTriggered && !optimizationDue) {
        state.consecutiveFailures = 0;
        state.consecutivePartialFailures = 0;
        state.consecutiveLatencyFailures = 0;
        state.lastHealthyAt = new Date().toISOString();
        clearCandidateScanBackoff(state);
        setDecision('hold', selectionAdmissionRejected ? 'strict-admission-pending' : 'transient-recovered');
        await persistState();
        return {
          status: selectionAdmissionRejected ? 'usable-pending-admission' : 'transient-recovered',
          current,
          backgroundWake: this.activeCandidateScan?.promise ?? null,
        };
      }
    }

    let requiredFailures = 0;
    if (health.status === 'partial-failure') {
      state.consecutivePartialFailures = (state.consecutivePartialFailures ?? 0) + 1;
      state.consecutiveLatencyFailures = 0;
      requiredFailures = this.config.policy.partialFailureCycles;
      state.consecutiveFailures = state.consecutivePartialFailures;
    } else if (health.status === 'latency-degraded') {
      state.consecutiveLatencyFailures = (state.consecutiveLatencyFailures ?? 0) + 1;
      state.consecutivePartialFailures = 0;
      requiredFailures = this.config.policy.latencyFailureCycles;
      state.consecutiveFailures = state.consecutiveLatencyFailures;
    } else if (requiresImmediateResponse(health)) {
      state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
      state.consecutivePartialFailures = 0;
      state.consecutiveLatencyFailures = 0;
    } else {
      state.consecutiveFailures = 0;
      state.consecutivePartialFailures = 0;
      state.consecutiveLatencyFailures = 0;
    }

    if (!forceScan && !rollingDegradationTriggered && !optimizationDue
        && requiredFailures > 0 && state.consecutiveFailures < requiredFailures) {
      setDecision('hold', 'failure-threshold-not-reached', {
        failures: state.consecutiveFailures,
        required: requiredFailures,
      });
      await persistState();
      await this.log('warn', 'failure-threshold-not-reached', {
        health: health.status,
        failures: state.consecutiveFailures,
        required: requiredFailures,
      });
      return {
        status: 'transient',
        current,
        backgroundWake: snapshotWake ?? this.activeCandidateScan?.promise ?? null,
      };
    }

    const elapsedSinceSwitch = state.lastSwitchAt ? Date.now() - Date.parse(state.lastSwitchAt) : Infinity;
    const minimumDwellMs = this.config.policy.minimumDwellSeconds * 1000;
    const latencyOnlyScan = health.status === 'latency-degraded'
      || rollingDegradationTriggered || optimizationDue;
    if (!forceScan
        && latencyOnlyScan && elapsedSinceSwitch < minimumDwellMs) {
      setDecision('hold', 'minimum-dwell-active', {
        remainingSeconds: Math.ceil((minimumDwellMs - elapsedSinceSwitch) / 1000),
      });
      await persistState();
      await this.log('warn', 'minimum-dwell-active', {
        remainingSeconds: Math.ceil((minimumDwellMs - elapsedSinceSwitch) / 1000),
      });
      return {
        status: 'minimum-dwell',
        current,
        backgroundWake: snapshotWake ?? this.activeCandidateScan?.promise ?? null,
      };
    }

    const budgetClass = availabilityRecoveryRequired ? 'recovery' : 'optimization';
    const allowRescue = health.emergency === true;
    if (!dryRun) {
      const budget = getSwitchBudget(state, this.config.policy, budgetClass);
      const rescue = getSwitchBudget(state, this.config.policy, 'rescue');
      if (budget.used >= budget.count && !(allowRescue && rescue.used < rescue.count)) {
        setDecision('blocked', 'switch-budget-exhausted', { budgetClass, used: budget.used, limit: budget.count });
        await persistState();
        await this.log('error', 'switch-budget-exhausted', {
          used: budget.used,
          limit: budget.count,
          windowSeconds: budget.windowSeconds,
          budgetClass,
          health: health.status,
        });
        return {
          status: 'switch-budget-exhausted',
          current,
          backgroundWake: snapshotWake ?? this.activeCandidateScan?.promise ?? null,
        };
      }
    }

    const scanBackoffUntil = Date.parse(state.candidateScanBackoffUntil ?? '');
    const hardFailureMayBypassBackoff = availabilityRecoveryRequired
      && state.lastCandidateScanOutcome !== 'upstream-outage';
    if (!forceScan && !externalChangeDetected && !baselineRevalidationStarted
      && !hardFailureMayBypassBackoff
      && Number.isFinite(scanBackoffUntil) && scanBackoffUntil > Date.now()) {
      setDecision('hold', 'candidate-scan-backoff-active', {
        remainingSeconds: Math.ceil((scanBackoffUntil - Date.now()) / 1000),
      });
      await persistState();
      await this.log('warn', 'candidate-scan-backoff-active', {
        remainingSeconds: Math.ceil((scanBackoffUntil - Date.now()) / 1000),
        previousOutcome: state.lastCandidateScanOutcome ?? null,
      });
      return {
        status: 'scan-backoff',
        current,
        backgroundWake: snapshotWake ?? this.activeCandidateScan?.promise ?? null,
      };
    }

    if (optimizationDue) state.lastOptimizationScanAt = new Date().toISOString();
    setDecision('scan', scanReason);
    let quarantined = getActiveQuarantines(state);
    const allowProvisionalRecovery = !health.stable;
    if (requiresImmediateResponse(health) && quarantined.size > 0) {
      await this.log('warn', 'quarantine-bypassed-for-immediate-failure', {
        count: quarantined.size,
        trigger: health.status,
      });
      quarantined = new Set();
    }
    let search;
    if (backgroundScan) {
      const active = this.activeCandidateScan;
      const cachedSearch = this.searchFromCandidateSnapshot(
        state.candidateSnapshot,
        previousSelection,
        currentLeaf,
      );
      if (cachedSearch) {
        search = cachedSearch;
        const hasResponsiveCandidate = [...cachedSearch.sampled, ...cachedSearch.validated]
          .some((entry) => entry.successes > 0);
        if (active && (hasResponsiveCandidate || !availabilityRecoveryRequired)) {
          active.invalidated = true;
          active.invalidatedReason = 'fresh-candidate-snapshot-used';
          active.cancel?.();
        }
        await this.log('info', 'candidate-snapshot-used', {
          ageMs: Math.round(cachedSearch.ageMs),
          candidateCount: cachedSearch.validated.length,
          trigger: scanReason,
        });
      } else if (active?.completed) {
        if (active.invalidated || !this.candidateScanMatches(active, previousSelection, currentLeaf)) {
          await this.log('info', 'candidate-scan-result-discarded', {
            reason: active.invalidatedReason ?? 'selection-changed',
            selection: active.selection,
            leaf: active.leaf,
          });
          this.activeCandidateScan = null;
        } else if (active.error) {
          this.activeCandidateScan = null;
          throw active.error;
        } else {
          search = active.result;
          this.activeCandidateScan = null;
        }
      }
      if (!search && !dryRun && availabilityRecoveryRequired) {
        // 故障恢复不等待后台慢速严格扫描；先在原三秒界内取得实时排序，再进紧急复核窗口。
        this.activeCandidateScan?.cancel?.();
        this.activeCandidateScan = null;
        delete state.candidateScan;
        search = await this.findCandidates(currentLeaf, quarantined, { allowProvisionalRecovery: true });
      }
      if (!search && this.activeCandidateScan) {
        state.candidateScan = {
          status: 'running',
          startedAt: this.activeCandidateScan.startedAt,
          reason: this.activeCandidateScan.reason,
        };
        setDecision('scan', snapshotStartedThisCycle
          ? 'candidate-scan-started'
          : 'candidate-scan-in-progress');
        await persistState();
        return {
          status: snapshotStartedThisCycle ? 'candidate-scan-started' : 'candidate-scan-in-progress',
          current,
          backgroundWake: this.activeCandidateScan.promise,
        };
      }
      if (!search) {
        const scan = this.startBackgroundCandidateScan({
          selection: previousSelection,
          leaf: currentLeaf,
          excludedNodes: quarantined,
          allowProvisionalRecovery,
          reason: scanReason,
        });
        state.candidateScan = { status: 'running', startedAt: scan.startedAt, reason: scanReason };
        setDecision('scan', 'candidate-scan-started');
        await persistState();
        await this.log('info', 'candidate-scan-background-started', {
          selection: previousSelection,
          leaf: currentLeaf,
          reason: scanReason,
        });
        return { status: 'candidate-scan-started', current, backgroundWake: scan.promise };
      }
    } else {
      search = await this.findCandidates(currentLeaf, quarantined, { allowProvisionalRecovery });
    }
    let candidates = search.stable;
    let provisionalCandidates = search.provisional ?? [];
    if (search.source !== 'candidate-snapshot') {
      state.candidateSnapshot = this.createCandidateSnapshot(search, previousSelection, currentLeaf);
    }
    if (!this.activeCandidateScan || this.activeCandidateScan.completed
        || this.activeCandidateScan.invalidated) delete state.candidateScan;
    state.lastCandidateScan = {
      at: search.completedAt ?? new Date().toISOString(),
      reason: scanReason,
      source: search.source ?? 'live-scan',
      ageMs: search.ageMs ?? 0,
      sampledCount: search.sampled.length,
      validatedCount: search.validated?.length ?? 0,
      stable: candidates.map((entry) => entry.node),
      provisional: provisionalCandidates.map((entry) => entry.node),
      rejected: (search.rejected ?? []).map((entry) => ({ node: entry.node, reasons: entry.reasons })),
      durationMs: search.durationMs,
      deadlineMs: search.deadlineMs,
      deadlineReached: search.deadlineReached,
      probeStats: search.probeStats ?? null,
    };
    // 扫描与串行切前门禁是两个阶段；立即落盘可避免状态把后续门禁误报为扫描超时。
    await persistState();

    const upstreamOutage = await this.detectUpstreamOutage(currentLeaf, current, search.sampled);
    if (upstreamOutage) {
      activateCandidateScanBackoff(state, this.config.policy, 'upstream-outage');
      setDecision('hold', 'upstream-outage');
      await persistState();
      await this.log('error', 'upstream-outage-detected', {
        failedCandidateCount: upstreamOutage.failedCandidateCount,
        minimumCandidates: upstreamOutage.minimumCandidates,
        controlSuccessRate: upstreamOutage.control.successRate,
      });
      return { status: 'upstream-outage', current, control: upstreamOutage.control };
    }
    if (!health.stable && provisionalCandidates.length > 0) {
      const strictCandidateCount = candidates.length;
      candidates = [...candidates, ...provisionalCandidates];
      await this.log('warn', 'provisional-candidates-selected', {
        trigger: scanReason,
        strictCandidateCount,
        nodes: provisionalCandidates.map((entry) => ({
          node: entry.node,
          successRate: entry.successRate,
          averageMs: Math.round(entry.averageMs),
          maxMs: entry.maxMs,
        })),
      });
    }
    const provisionalCandidateNames = new Set(provisionalCandidates.map((entry) => entry.node));
    const meaningfulImprovementRequired = !availabilityRecoveryRequired
      && (!selectionAdmissionRejected || health.stable) && candidates.length > 0
      && (health.status === 'latency-degraded' || rollingDegradationTriggered
        || optimizationDue || (forceScan && health.stable));
    if (meaningfulImprovementRequired) {
      const improvement = Math.min(
        this.config.policy.minimumImprovementMs,
        current.averageMs * this.config.policy.minimumImprovementRatio,
      );
      candidates = candidates.filter((candidate) => candidate.averageMs <= current.averageMs - improvement);
      if (candidates.length === 0) {
        activateCandidateScanBackoff(state, this.config.policy, 'no-meaningful-improvement');
        setDecision('hold', 'no-meaningful-improvement', {
          requiredImprovementMs: Math.round(improvement),
        });
        await persistState();
        await this.log('warn', 'no-meaningful-improvement', { requiredImprovementMs: Math.round(improvement) });
        return { status: 'no-improvement', current };
      }
    }

    const emergencyRecovery = !dryRun && availabilityRecoveryRequired;
    if (emergencyRecovery) {
      const byNode = new Map();
      for (const entry of [...candidates, ...(search.sampled ?? []), ...(search.validated ?? [])]) {
        if (entry.successes > 0 && entry.node !== currentLeaf) byNode.set(entry.node, entry);
      }
      if (backgroundScan && byNode.size === 0) {
        // 零响应快照仅代表上次初筛失败；节点名可用于重试，选择仍须本次成功证据。
        for (const entry of search.sampled ?? []) {
          if (entry.node !== currentLeaf) byNode.set(entry.node, entry);
        }
        await this.log('warn', 'emergency-discovery-retry', {
          source: search.source ?? 'live-scan',
          candidateCount: Math.min(byNode.size, this.config.probes.topCandidates),
        });
      }
      candidates = [...byNode.values()]
        .filter((entry) => backgroundScan || isAvailabilityImprovement(entry, current, this.config.policy))
        .sort(compareAvailability)
        .slice(0, this.config.probes.topCandidates);
    }

    let candidate = candidates[0];
    if (!candidate) {
      activateCandidateScanBackoff(state, this.config.policy, 'no-stable-candidate');
      setDecision('hold', 'no-stable-candidate');
      await persistState();
      await this.log(health.stable ? 'info' : 'warn', 'no-stable-candidate', {});
      return { status: 'no-candidate', current };
    }
    if (dryRun) {
      setDecision('recommend', 'dry-run-would-switch', { from: previousSelection, to: candidate.node });
      await this.log('info', 'switch-dry-run', { from: previousSelection, to: candidate.node });
      return { status: 'would-switch', current, candidate };
    }

    let preSwitchValidationIncomplete = false;
    if (backgroundScan && candidates.length > 0) {
      const decisionStartedAt = Date.now();
      const preSwitchRounds = emergencyRecovery ? 1 : Math.max(2, this.config.probes.validationRounds);
      // 普通复核也要容纳逐节点串行样本及并发批次，不能把未采完当作节点失败。
      const normalValidationDeadlineMs = Math.max(this.config.probes.preSwitchValidationDeadlineMs,
        Math.ceil(candidates.length / this.config.probes.parallelism)
          * preSwitchRounds * this.config.probes.urls.length * this.config.probes.timeoutMs);
      const decisionDeadlineMs = emergencyRecovery
        ? this.config.policy.emergencySwitchDeadlineMs
        : normalValidationDeadlineMs;
      if (!emergencyRecovery) {
        setDecision('validate', 'candidate-pre-switch-validation', { deadlineMs: decisionDeadlineMs });
        await persistState();
        await this.log('info', 'candidate-pre-switch-validation-started', {
          candidateCount: candidates.length, rounds: preSwitchRounds,
          targetCount: this.config.probes.urls.length,
          deadlineMs: decisionDeadlineMs, perTargetTimeoutMs: this.config.probes.timeoutMs,
        });
      }
      const switchReserveMs = emergencyRecovery ? Math.min(250, Math.floor(decisionDeadlineMs / 3)) : 0;
      const validationDeadlineAt = decisionStartedAt + decisionDeadlineMs - switchReserveMs;
      let preSwitchResults = await this.probeCandidatesInParallel(
        candidates.map((entry) => entry.node),
        preSwitchRounds,
        this.config.probes.urls,
        validationDeadlineAt,
      );
      const resultByNode = new Map(preSwitchResults.map((entry) => [entry.node, entry]));

      if (emergencyRecovery) {
        // 真实链路失败与 URLTest 延迟属于不同证据；完整可达的备选可作有预算的待验证恢复，
        // 不要求先比网络已失败的旧出口再快 200ms。部分可达仍须满足原有相对改善规则。
        const isRecoveryImprovement = (entry) => isAvailabilityImprovement(entry, current, this.config.policy)
          || (linkFailures.length > 0 && entry.successRate === 1
            && hasCompleteProbeRounds(entry, this.config.probes.urls, 1));
        let ranked = preSwitchResults
          .filter(isRecoveryImprovement)
          .sort(compareAvailability);
        let verificationSource = 'live-fast-validation';
        if (ranked.length === 0 || ranked[0].successRate < 1) {
          // 快速窗口是恢复目标，不能成为拒绝较慢但可用出口的永久门槛。
          // 重新采集完整一轮业务样本，不将不同截止窗口的样本混合计算成功率。
          // 当前节点每目标可等待 timeoutMs；恢复候选也须获得同等机会，不能把3秒均分为
          // 两个1.5秒请求，再将截止导致的缺失与当前5秒窗口的成功率直接比较。
          const recoveryDeadlineMs = Math.max(this.config.probes.preSwitchValidationDeadlineMs,
            this.config.probes.timeoutMs * this.config.probes.urls.length);
          setDecision('validate', 'emergency-recovery-validation', { deadlineMs: recoveryDeadlineMs });
          await persistState();
          await this.log('warn', 'emergency-fast-path-exhausted', {
            checkedCandidates: preSwitchResults.length,
            successfulCandidates: preSwitchResults.filter((entry) => entry.successes > 0).length,
            decisionDurationMs: Date.now() - decisionStartedAt,
            recoveryDeadlineMs,
            perTargetTimeoutMs: this.config.probes.timeoutMs,
          });
          preSwitchResults = await this.probeCandidatesInParallel(
            candidates.map((entry) => entry.node),
            1,
            this.config.probes.urls,
            Date.now() + recoveryDeadlineMs,
            { timeoutMs: this.config.probes.timeoutMs },
          );
          ranked = preSwitchResults
            .filter(isRecoveryImprovement)
            .sort(compareAvailability);
          verificationSource = 'live-recovery-validation';
        }
        const emergencyCandidate = ranked[0];
        for (const result of preSwitchResults) {
          if (isRecoveryImprovement(result)
              || result.node === emergencyCandidate?.node) continue;
          await this.log('warn', 'candidate-pre-switch-rejected', {
            node: result.node,
            profile: 'emergency-best-effort',
            successRate: result.successRate,
            averageMs: Number.isFinite(result.averageMs) ? Math.round(result.averageMs) : null,
            maxMs: Number.isFinite(result.maxMs) ? result.maxMs : null,
            reason: result.successes <= 0 ? 'no-successful-sample' : 'no-relative-improvement',
          });
        }
        if (!emergencyCandidate) {
          candidates = [];
          await this.log('error', 'emergency-fallback-unavailable', {
            currentSuccessRate: current.successRate,
            linkFailures,
            checkedCandidates: preSwitchResults.length,
            decisionDurationMs: Date.now() - decisionStartedAt,
          });
        } else {
          await this.beforeSwitch();
          const budget = consumeSwitchBudget(state, this.config.policy, {
            from: previousSelection,
            to: emergencyCandidate.node,
            kind: 'emergency-candidate-attempt',
          }, { budgetClass, allowRescue });
          if (!budget.allowed) {
            setDecision('blocked', 'switch-budget-exhausted', { used: budget.used, limit: budget.count });
            await persistState();
            return { status: 'switch-budget-exhausted', current };
          }
          clearCandidateScanBackoff(state);
          delete state.selectionAdmissionVersion;
          setDecision('switch', 'emergency-selection-reserved', { to: emergencyCandidate.node, budgetClass: budget.budgetClass });
          await persistState();
          await this.controller.select(this.config.groups.target, emergencyCandidate.node);
          state.currentSelection = emergencyCandidate.node;
          state.currentLeaf = await this.resolveLeaf(emergencyCandidate.node);
          recordEvaluation(emergencyCandidate,
            classifyHealth(emergencyCandidate, this.currentThresholds(), this.config.policy),
            emergencyCandidate.node, state.currentLeaf);
          recordAdmission('rescue', emergencyCandidate.node, state.currentLeaf);
          const switchedAt = new Date().toISOString();
          const decisionDurationMs = Date.now() - decisionStartedAt;
          quarantineNode(
            state,
            currentLeaf,
            this.config.policy.failedNodeQuarantineSeconds,
            'emergency-best-effort',
          );
          state.lastSwitchAt = switchedAt;
          state.lastSwitch = {
            at: switchedAt,
            from: previousSelection,
            to: emergencyCandidate.node,
            reason: 'emergency-best-effort',
            trigger: scanReason,
            verified: false,
            source: 'sentinel',
            verificationSource,
            linkFailures,
            decisionDurationMs,
            deadlineMet: decisionDurationMs <= decisionDeadlineMs,
          };
          state.provisionalFallback = {
            at: switchedAt,
            selection: emergencyCandidate.node,
            leaf: state.currentLeaf,
            profile: 'emergency-best-effort',
            requiresStrictAdmission: true,
          };
          delete state.externalSelectionPendingAdmission;
          setDecision('switch', 'emergency-best-effort', {
            from: previousSelection,
            to: emergencyCandidate.node,
            decisionDurationMs,
          });
          await persistState();
          await this.log('warn', 'emergency-fallback-switched', {
            from: previousSelection,
            to: emergencyCandidate.node,
            successRate: emergencyCandidate.successRate,
            averageMs: Number.isFinite(emergencyCandidate.averageMs)
              ? Math.round(emergencyCandidate.averageMs) : null,
            maxMs: Number.isFinite(emergencyCandidate.maxMs) ? emergencyCandidate.maxMs : null,
            verificationSource,
            decisionDurationMs,
            deadlineMs: decisionDeadlineMs,
            deadlineMet: decisionDurationMs <= decisionDeadlineMs,
          });
          return {
            status: 'emergency-fallback',
            current,
            candidate: emergencyCandidate,
            verification: emergencyCandidate,
            verificationSource,
          };
        }
      } else {
        const admitted = [];
        for (const nextCandidate of candidates) {
          const verification = resultByNode.get(nextCandidate.node);
          if (!verification || !hasCompleteProbeRounds(verification, this.config.probes.urls, preSwitchRounds)) {
            preSwitchValidationIncomplete = true;
            await this.log('warn', 'candidate-pre-switch-deferred', {
              node: nextCandidate.node, reason: 'incomplete-evidence',
              attempts: verification?.attempts ?? 0, successes: verification?.successes ?? 0,
              deadlineMs: decisionDeadlineMs,
            });
            continue;
          }
          const admissionThresholds = provisionalCandidateNames.has(nextCandidate.node)
            ? this.currentThresholds()
            : this.candidateThresholds();
          const admittedEvidence = verification && (provisionalCandidateNames.has(nextCandidate.node)
            ? hasCompleteProbeRounds(verification, this.config.probes.urls, 1)
              && isStableAcrossRounds(verification, admissionThresholds)
            : hasStrictAdmissionEvidence(verification, this.config.probes, admissionThresholds));
          if (!admittedEvidence) {
            quarantineNode(
              state,
              nextCandidate.node,
              this.config.policy.failedNodeQuarantineSeconds,
              'pre-switch-validation-failed',
            );
            await this.log('warn', 'candidate-pre-switch-rejected', {
              node: nextCandidate.node,
              profile: provisionalCandidateNames.has(nextCandidate.node) ? 'current-health' : 'strict',
              successRate: verification?.successRate ?? 0,
              averageMs: Number.isFinite(verification?.averageMs) ? Math.round(verification.averageMs) : null,
              maxMs: Number.isFinite(verification?.maxMs) ? verification.maxMs : null,
            });
            continue;
          }
          admitted.push({ ...nextCandidate, preSwitchVerification: verification });
          await this.log('info', 'candidate-pre-switch-admitted', {
            node: nextCandidate.node,
            profile: provisionalCandidateNames.has(nextCandidate.node) ? 'current-health' : 'strict',
            successRate: verification.successRate,
            averageMs: Math.round(verification.averageMs),
            maxMs: verification.maxMs,
          });
        }
        candidates = admitted;
      }
    }

    candidate = candidates[0];
    if (!candidate) {
      if (preSwitchValidationIncomplete) {
        clearCandidateScanBackoff(state);
        setDecision('hold', 'pre-switch-validation-incomplete');
        await persistState();
        await this.log('warn', 'pre-switch-validation-incomplete', {});
        return { status: 'pre-switch-validation-incomplete', current };
      }
      activateCandidateScanBackoff(state, this.config.policy, 'pre-switch-validation-failed');
      setDecision('hold', 'no-pre-switch-candidate');
      await persistState();
      await this.log('warn', 'no-pre-switch-candidate', {});
      return { status: 'no-pre-switch-candidate', current };
    }

    const attempted = [];
    let activeSelection = previousSelection;
    // 初始故障仍用于报告；安全恢复资格必须跟随当前实际出口的最新验证。
    let activeSelectionHealth = health;
    let candidateBudgetExhausted = false;
    let candidateSelectionAttempted = false;
    let candidateSelectionAttempts = 0;
    const switchReason = forceScan && scanReason === 'healthy' ? 'forced-optimization' : scanReason;
    for (const nextCandidate of candidates) {
      if (candidateSelectionAttempts >= this.config.policy.maxSwitchAttempts) break;
      const fromSelection = activeSelection;
      await this.beforeSwitch();
      const budget = consumeSwitchBudget(state, this.config.policy, {
        from: fromSelection,
        to: nextCandidate.node,
        kind: 'candidate-attempt',
      }, { budgetClass, allowRescue: activeSelectionHealth.emergency === true });
      if (!budget.allowed) {
        candidateBudgetExhausted = true;
        await persistState();
        await this.log('error', 'switch-budget-exhausted', {
          used: budget.used,
          limit: budget.count,
          windowSeconds: budget.windowSeconds,
          health: switchReason,
          from: activeSelection,
          blockedCandidate: nextCandidate.node,
          kind: 'candidate-attempt',
        });
        break;
      }
      clearCandidateScanBackoff(state);
      delete state.selectionAdmissionVersion;
      await persistState();
      await this.controller.select(this.config.groups.target, nextCandidate.node);
      candidateSelectionAttempted = true;
      candidateSelectionAttempts += 1;
      activeSelection = nextCandidate.node;
      state.currentSelection = activeSelection;
      state.currentLeaf = await this.resolveLeaf(activeSelection);
      recordAdmission('pending', activeSelection, state.currentLeaf);
      await persistState();
      await this.log('warn', 'node-switched', {
        from: fromSelection,
        to: nextCandidate.node,
        reason: switchReason,
      });
      await sleep(this.config.policy.postSwitchDelaySeconds * 1000);
      const verification = await this.probeNode(
        state.currentLeaf,
        this.config.policy.postSwitchRounds,
        this.config.probes.urls,
      );
      activeSelectionHealth = classifyHealth(verification, this.currentThresholds(), this.config.policy);
      recordEvaluation(verification, activeSelectionHealth,
        activeSelection, state.currentLeaf);
      // 切后一轮只能确认本轮同叶子的完整严格扫描证据仍有效；旧快照不能补齐轮次。
      const liveStrictEvidence = [nextCandidate.preSwitchVerification,
        ...(search.source === 'candidate-snapshot' ? [] : (search.validated ?? []))]
        .some((entry) => entry?.node === state.currentLeaf
          && hasStrictAdmissionEvidence(entry, this.config.probes, this.candidateThresholds()));
      const strictAfterSwitch = hasStrictAdmissionEvidence(
        verification, this.config.probes, this.candidateThresholds(),
      ) || (liveStrictEvidence
        && hasCompleteProbeRounds(verification, this.config.probes.urls, 1)
        && isStableAcrossRounds(verification, this.candidateThresholds()));
      if (strictAfterSwitch) {
        quarantineNode(
          state,
          currentLeaf,
          this.config.policy.failedNodeQuarantineSeconds,
          switchReason,
        );
        state.consecutiveFailures = 0;
        state.consecutivePartialFailures = 0;
        state.consecutiveLatencyFailures = 0;
        state.degradationWindow = [];
        state.lastSwitchAt = new Date().toISOString();
        state.lastSwitch = {
          from: previousSelection,
          to: nextCandidate.node,
          reason: switchReason,
          trigger: switchReason,
          verified: true,
          source: 'sentinel',
        };
        state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
        recordAdmission('strict', activeSelection, state.currentLeaf);
        delete state.provisionalFallback;
        delete state.externalSelectionPendingAdmission;
        state.lastHealthyAt = state.lastSwitchAt;
        state.lastOptimizationScanAt = state.lastSwitchAt;
        setDecision('switch', 'verified-candidate', { from: previousSelection, to: nextCandidate.node });
        await persistState();
        await this.log('info', 'switch-verified', {
          node: nextCandidate.node,
          leaf: state.currentLeaf,
          reason: switchReason,
          successRate: verification.successRate,
          averageMs: Math.round(verification.averageMs),
          maxMs: verification.maxMs,
        });
        return { status: 'switched', current, candidate: nextCandidate, verification };
      }
      attempted.push({ candidate: nextCandidate, verification });
      quarantineNode(
        state,
        nextCandidate.node,
        this.config.policy.failedNodeQuarantineSeconds,
        'post-switch-verification-failed',
      );
      await this.log('error', 'switch-verification-failed', {
        node: nextCandidate.node,
        successRate: verification.successRate,
        averageMs: Number.isFinite(verification.averageMs) ? Math.round(verification.averageMs) : null,
        maxMs: Number.isFinite(verification.maxMs) ? verification.maxMs : null,
      });
      if (isStableAcrossRounds(verification, this.currentThresholds())) {
        await this.log('warn', 'provisional-fallback-available', {
          node: nextCandidate.node,
          leaf: state.currentLeaf,
          reason: 'strict-admission-failed-current-threshold-passed',
        });
      }
    }

    if (!candidateSelectionAttempted) {
      activateCandidateScanBackoff(
        state,
        this.config.policy,
        candidateBudgetExhausted ? 'switch-budget-exhausted' : 'pre-switch-validation-failed',
      );
      setDecision(
        candidateBudgetExhausted ? 'blocked' : 'hold',
        candidateBudgetExhausted ? 'switch-budget-exhausted' : 'no-pre-switch-candidate',
      );
      await persistState();
      await this.log('error', candidateBudgetExhausted
        ? 'switch-budget-exhausted'
        : 'no-pre-switch-candidate', {});
      return {
        status: candidateBudgetExhausted ? 'switch-budget-exhausted' : 'no-pre-switch-candidate',
        current,
      };
    }

    const previousVerification = await this.probeNode(
      currentLeaf,
      this.config.policy.postSwitchRounds,
      this.config.probes.urls,
    );
    if (!selectionAdmissionRejected && this.config.policy.rollbackOnFailure
      && isStableAcrossRounds(previousVerification, this.currentThresholds())) {
      await this.beforeSwitch();
      await this.controller.select(this.config.groups.target, previousSelection);
      const rollbackFrom = activeSelection;
      activeSelection = previousSelection;
      state.currentSelection = previousSelection;
      state.currentLeaf = await this.resolveLeaf(previousSelection);
      const actualPreviousVerification = state.currentLeaf === currentLeaf
        ? previousVerification
        : await this.probeNode(
            state.currentLeaf,
            this.config.policy.postSwitchRounds,
            this.config.probes.urls,
          );
      activeSelectionHealth = classifyHealth(
        actualPreviousVerification, this.currentThresholds(), this.config.policy,
      );
      recordEvaluation(actualPreviousVerification, activeSelectionHealth,
        previousSelection, state.currentLeaf);
      if (isStableAcrossRounds(actualPreviousVerification, this.currentThresholds())) {
        const rollbackStrict = hasStrictAdmissionEvidence(
          actualPreviousVerification, this.config.probes, this.candidateThresholds(),
        );
        recordRecoveryRollback(state, this.config.policy, rollbackFrom, previousSelection);
        const recoveredAt = new Date().toISOString();
        state.consecutiveFailures = 0;
        state.consecutivePartialFailures = 0;
        state.consecutiveLatencyFailures = 0;
        state.degradationWindow = [];
        state.lastSwitchAt = recoveredAt;
        state.lastSwitch = {
          from: rollbackFrom,
          to: previousSelection,
          reason: 'rollback-recovered',
          trigger: health.status,
          verified: rollbackStrict,
          source: 'sentinel',
        };
        if (rollbackStrict) {
          state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
          delete state.provisionalFallback;
        } else {
          delete state.selectionAdmissionVersion;
          state.provisionalFallback = {
            at: recoveredAt, selection: previousSelection, leaf: state.currentLeaf,
            profile: 'current-threshold', requiresStrictAdmission: true,
          };
        }
        recordAdmission(rollbackStrict ? 'strict' : 'usable', previousSelection, state.currentLeaf);
        state.lastHealthyAt = recoveredAt;
        state.lastOptimizationScanAt = recoveredAt;
        setDecision('rollback', 'rollback-recovered', { from: rollbackFrom, to: previousSelection });
        await this.log('warn', 'switch-recovery-rollback', {
          from: rollbackFrom,
          restored: previousSelection,
          leaf: state.currentLeaf,
          budgetExempt: true,
          verificationProfile: 'recovery-current',
          verificationRounds: this.config.policy.postSwitchRounds,
        });
        await persistState();
        return { status: 'rollback-recovered', current, candidate, verification: actualPreviousVerification };
      }
      state.switchHistory.push({
        timestamp: new Date().toISOString(),
        from: rollbackFrom,
        to: previousSelection,
        kind: 'recovery-rollback-failed',
        budgetExempt: true,
      });
      attempted.push({ candidate: { node: previousSelection }, verification: actualPreviousVerification });
      quarantineNode(
        state,
        state.currentLeaf,
        this.config.policy.failedNodeQuarantineSeconds,
        'rollback-verification-failed',
      );
      await this.log('error', 'switch-recovery-rollback-failed', {
        from: rollbackFrom,
        restored: previousSelection,
        leaf: state.currentLeaf,
        successRate: actualPreviousVerification.successRate,
        averageMs: Number.isFinite(actualPreviousVerification.averageMs)
          ? Math.round(actualPreviousVerification.averageMs) : null,
        maxMs: Number.isFinite(actualPreviousVerification.maxMs) ? actualPreviousVerification.maxMs : null,
      });
    }

    const attemptedProvisionalCandidates = attempted
      .filter((entry) => isStableAcrossRounds(entry.verification, this.currentThresholds()))
      .sort((a, b) => a.verification.score - b.verification.score);
    const fallback = attemptedProvisionalCandidates[0];
    let retained = attempted.find((entry) => entry.candidate.node === activeSelection) ?? null;
    if (fallback && activeSelection !== fallback.candidate.node) {
      const recoveryBudget = getSwitchBudget(state, this.config.policy, 'recovery');
      const rescueBudget = getSwitchBudget(state, this.config.policy, 'rescue');
      const allowCurrentRescue = activeSelectionHealth.emergency === true;
      const canRestore = recoveryBudget.used < recoveryBudget.count
        || (allowCurrentRescue && rescueBudget.used < rescueBudget.count);
      if (!canRestore) {
        await this.log('warn', 'provisional-restoration-budget-exhausted', { used: recoveryBudget.used });
      } else {
        // 先前可用的候选可能已失效，旧切后样本不能授权再次选择。
        const restorationLeaf = await this.resolveLeaf(fallback.candidate.node);
        const restorationVerification = await this.probeNode(
          restorationLeaf, this.config.policy.postSwitchRounds, this.config.probes.urls,
        );
        if (isStableAcrossRounds(restorationVerification, this.currentThresholds())) {
          await this.beforeSwitch();
          const restoreBudget = consumeSwitchBudget(state, this.config.policy, {
            from: activeSelection,
            to: fallback.candidate.node,
            kind: 'provisional-recovery',
          }, { budgetClass: 'recovery', allowRescue: allowCurrentRescue });
          if (restoreBudget.allowed) {
            delete state.selectionAdmissionVersion;
            await persistState();
            await this.controller.select(this.config.groups.target, fallback.candidate.node);
            activeSelection = fallback.candidate.node;
            state.currentSelection = activeSelection;
            state.currentLeaf = await this.resolveLeaf(activeSelection);
            recordAdmission('pending', activeSelection, state.currentLeaf);
            const actualRestorationVerification = state.currentLeaf === restorationLeaf
              ? restorationVerification
              : await this.probeNode(
                  state.currentLeaf, this.config.policy.postSwitchRounds, this.config.probes.urls,
                );
            activeSelectionHealth = classifyHealth(
              actualRestorationVerification, this.currentThresholds(), this.config.policy,
            );
            fallback.verification = actualRestorationVerification;
            recordEvaluation(actualRestorationVerification, activeSelectionHealth,
              activeSelection, state.currentLeaf);
            delete state.externalSelectionPendingAdmission;
            const restoredUsable = isStableAcrossRounds(actualRestorationVerification, this.currentThresholds());
            if (!restoredUsable) {
              quarantineNode(state, state.currentLeaf, this.config.policy.failedNodeQuarantineSeconds,
                'provisional-restoration-verification-failed');
            }
            await persistState();
            retained = fallback;
            await this.log(restoredUsable ? 'warn' : 'error', restoredUsable
              ? 'provisional-fallback-restored' : 'provisional-restoration-verification-failed', {
              node: activeSelection,
              leaf: state.currentLeaf,
              budgetClass: restoreBudget.budgetClass,
              successRate: actualRestorationVerification.successRate,
            });
          } else {
            await this.log('warn', 'provisional-restoration-budget-exhausted', { used: restoreBudget.used });
          }
        } else {
          await this.log('warn', 'provisional-restoration-validation-failed', {
            node: fallback.candidate.node,
            successRate: restorationVerification.successRate,
          });
        }
      }
    }
    const provisional = retained
      && isStableAcrossRounds(retained.verification, this.currentThresholds());
    if (retained) {
      state.quarantinedNodes ??= {};
      if (provisional) {
        delete state.quarantinedNodes[activeSelection];
        delete state.quarantinedNodes[state.currentLeaf];
      }
      quarantineNode(
        state,
        currentLeaf,
        this.config.policy.failedNodeQuarantineSeconds,
        switchReason,
      );
      const retainedAt = new Date().toISOString();
      state.lastSwitchAt = retainedAt;
      state.lastSwitch = {
        from: previousSelection,
        to: activeSelection,
        reason: provisional ? 'provisional-fallback' : 'degraded-fallback',
        trigger: switchReason,
        verified: false,
        source: 'sentinel',
      };
      state.provisionalFallback = {
        at: retainedAt,
        selection: activeSelection,
        leaf: state.currentLeaf,
        profile: provisional ? 'current-threshold' : 'unverified',
        requiresStrictAdmission: true,
      };
      const retainedProfile = provisional ? 'usable'
        : (isAvailabilityImprovement(retained.verification, current, this.config.policy) ? 'rescue' : 'pending');
      recordAdmission(retainedProfile, activeSelection, state.currentLeaf);
      recordEvaluation(retained.verification,
        classifyHealth(retained.verification, this.currentThresholds(), this.config.policy),
        activeSelection, state.currentLeaf);
      delete state.selectionAdmissionVersion;
    }
    setDecision('hold', provisional ? 'provisional-fallback' : 'degraded-fallback', {
      retained: retained?.candidate.node ?? previousSelection,
    });
    await persistState();
    await this.log(provisional ? 'warn' : 'error', 'no-verified-fallback', {
      retained: retained?.candidate.node ?? previousSelection,
      previousHealthy: false,
      retentionReason: provisional
        ? 'current-threshold-provisional-pending-strict-admission'
        : 'active-selection-retained-without-safe-alternative',
    });
    return {
      status: provisional ? 'provisional-fallback' : 'degraded-fallback',
      current,
      candidate: retained?.candidate ?? candidate,
      verification: retained?.verification,
    };
  }
}

export { classifyHealth, isStable, mapLimit, summarizeSamples };
