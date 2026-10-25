import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

async function collectUntil(promises, deadlineAt) {
  if (promises.length === 0) return [];
  const completed = [];
  let pending = promises.length;
  let finishAll;
  const allDone = new Promise((resolve) => { finishAll = resolve; });
  for (const promise of promises) {
    Promise.resolve(promise)
      .then((value) => completed.push(value))
      .catch(() => {})
      .finally(() => {
        pending -= 1;
        if (pending === 0) finishAll();
      });
  }
  const remainingMs = Math.max(0, deadlineAt - Date.now());
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, remainingMs);
    allDone.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return completed;
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

function getSwitchBudget(state, policy) {
  const count = policy.switchBudgetCount ?? 3;
  const windowSeconds = policy.switchBudgetWindowSeconds ?? 600;
  const cutoff = Date.now() - (windowSeconds * 1000);
  const timestampOf = (entry) => typeof entry === 'string' ? entry : entry?.timestamp;
  state.switchHistory = (state.switchHistory ?? [])
    .filter((entry) => {
      const timestamp = timestampOf(entry);
      return Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) > cutoff;
    });
  const used = state.switchHistory.filter((entry) => (
    typeof entry === 'string' || (entry.kind !== 'recovery-rollback' && entry.budgetExempt !== true)
  )).length;
  return { count, windowSeconds, used };
}

function consumeSwitchBudget(state, policy, entry) {
  const budget = getSwitchBudget(state, policy);
  if (budget.used >= budget.count) return { allowed: false, ...budget };
  state.switchHistory.push({ timestamp: new Date().toISOString(), ...entry });
  return { allowed: true, ...budget, used: budget.used + 1 };
}

function recordRecoveryRollback(state, policy, from, to) {
  getSwitchBudget(state, policy);
  state.switchHistory.push({
    timestamp: new Date().toISOString(),
    from,
    to,
    kind: 'recovery-rollback',
  });
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
  }

  candidateScanMatches(scan, selection, leaf) {
    return scan?.selection === selection && scan?.leaf === leaf;
  }

  startBackgroundCandidateScan({ selection, leaf, excludedNodes, allowProvisionalRecovery, reason }) {
    const scan = {
      selection,
      leaf,
      reason,
      recovery: allowProvisionalRecovery,
      startedAt: new Date().toISOString(),
      completed: false,
      invalidated: false,
      result: null,
      error: null,
    };
    scan.promise = this.findCandidates(leaf, excludedNodes, { allowProvisionalRecovery })
      .then((result) => {
        scan.result = result;
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
          const delay = await this.controller.getDelay(node, url, this.config.probes.timeoutMs);
          samples.push({ round, url, ok: true, delay });
        } catch (error) {
          samples.push({ round, url, ok: false, error: error.status ?? error.message });
        }
      }
    }
    return summarizeSamples(node, samples);
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
  } = {}) {
    const startedAt = Date.now();
    const phaseDeadline = Math.min(deadlineAt, startedAt + timeoutMs + 200);
    const groupAttempts = [];
    if (typeof this.controller.getGroupDelays === 'function') {
      for (let round = 1; round <= rounds; round += 1) {
        for (const url of scanUrls) {
          groupAttempts.push(this.controller.getGroupDelays(this.config.groups.candidates, url, timeoutMs)
            .then((delays) => ({ round, url, delays })));
        }
      }
    }
    const groupResults = (await collectUntil(groupAttempts, phaseDeadline))
      .filter(({ delays }) => candidates.some((node) => delays.has(node)));
    let method = 'group-delay';
    let samples = [];
    if (groupResults.length > 0) {
      samples = candidates.flatMap((node) => groupResults.map(({ round, url, delays }) => (
        delays.has(node)
          ? { node, round, url, ok: true, delay: delays.get(node) }
          : { node, round, url, ok: false, error: 'discovery-timeout' }
      )));
    } else {
      method = 'parallel-fallback';
      const attempts = [];
      for (const node of candidates) {
        for (let round = 1; round <= rounds; round += 1) {
          for (const url of scanUrls) {
            attempts.push(this.controller.getDelay(node, url, timeoutMs)
              .then((delay) => ({ node, round, url, ok: true, delay }))
              .catch((error) => ({
                node,
                round,
                url,
                ok: false,
                error: error.status ?? error.code ?? error.message,
              })));
          }
        }
      }
      samples = await collectUntil(attempts, Math.min(deadlineAt, Date.now() + timeoutMs + 200));
    }
    const byNode = new Map(candidates.map((node) => [node, []]));
    for (const sample of samples) byNode.get(sample.node)?.push(sample);
    const results = candidates.map((node) => summarizeSamples(node, byNode.get(node)));
    await this.log('info', event, {
      method,
      durationMs: Date.now() - startedAt,
      candidateCount: candidates.length,
      responsiveCount: results.filter((result) => result.successes > 0).length,
    });
    return results;
  }

  async findCandidates(currentLeaf, excludedNodes = new Set(), { allowProvisionalRecovery = false } = {}) {
    const scanStartedAt = Date.now();
    const deadlineAt = scanStartedAt + this.config.probes.scanDeadlineMs;
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
    await this.log('info', 'candidate-scan-started', { count: candidates.length });
    const scanUrls = this.config.probes.urls.slice(0, this.config.probes.scanUrlCount);
    const quickResults = await this.discoverCandidates(candidates, scanUrls, deadlineAt);
    const ranked = quickResults
      .filter((result) => result.successes > 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, this.config.probes.maxValidationCandidates);
    const validationTimeoutMs = Math.max(100, Math.min(
      this.config.probes.candidateMaxSingleMs + 100,
      deadlineAt - Date.now() - 100,
    ));
    await this.log('info', 'candidate-shortlist', {
      nodes: ranked.map((result) => ({
        node: result.node,
        successRate: result.successRate,
        averageMs: Math.round(result.averageMs),
      })),
    });
    const validated = validationTimeoutMs >= 100
      ? await this.discoverCandidates(
          ranked.map((result) => result.node),
          this.config.probes.urls,
          deadlineAt,
          {
            rounds: this.config.probes.validationRounds,
            timeoutMs: validationTimeoutMs,
            event: 'candidate-validation-probes-completed',
          },
        )
      : [];
    const stable = [];
    const provisional = [];
    const strictResults = validated.filter((result) => isStableAcrossRounds(result, this.candidateThresholds()));
    stable.push(...strictResults);
    provisional.push(...validated.filter((result) => !strictResults.includes(result)
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
      durationMs: Date.now() - scanStartedAt,
      deadlineMs: this.config.probes.scanDeadlineMs,
      deadlineReached: Date.now() >= deadlineAt,
    });
    return {
      stable,
      provisional,
      sampled: quickResults,
      validated,
      rejected,
      durationMs: Date.now() - scanStartedAt,
      deadlineMs: this.config.probes.scanDeadlineMs,
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
      if (!dryRun) await writeState(this.config.files.state, state);
    };
    const target = await this.controller.getProxy(this.config.groups.target);
    const previousSelection = target.now;
    const currentLeaf = await this.resolveLeaf(previousSelection);
    getActiveQuarantines(state);
    const acceptedSelection = state.currentSelection ?? null;
    const acceptedLeaf = state.currentLeaf ?? null;
    const baselineRevalidationRequired = Boolean(acceptedSelection || acceptedLeaf)
      && state.selectionAdmissionVersion !== SELECTION_ADMISSION_VERSION;
    const selectionChanged = Boolean(acceptedSelection && acceptedSelection !== previousSelection);
    const leafChanged = Boolean(acceptedLeaf && acceptedLeaf !== currentLeaf);
    const pendingMatchesObserved = state.externalSelectionPendingAdmission?.to === previousSelection
      && state.externalSelectionPendingAdmission?.leaf === currentLeaf;
    let externalChangeDetected = false;
    let baselineRevalidationStarted = false;
    if ((selectionChanged || leafChanged) && !pendingMatchesObserved) {
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
        && state.externalSelectionPendingAdmission.source !== 'baseline'
        && !selectionChanged && !leafChanged) {
      await this.log('info', 'external-selection-reverted', {
        expected: acceptedSelection,
        expectedLeaf: acceptedLeaf,
        observed: previousSelection,
        observedLeaf: currentLeaf,
      });
      delete state.externalSelectionPendingAdmission;
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
    let selectionAdmissionRejected = false;
    let current;
    if (pendingAdmission) {
      current = await this.probeNode(
        currentLeaf,
        this.config.probes.validationRounds,
        this.config.probes.urls,
      );
      const admitted = isStableAcrossRounds(current, this.candidateThresholds());
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
        },
      );
      if (admitted) {
        state.currentSelection = previousSelection;
        state.currentLeaf = currentLeaf;
        state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
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
      }
    } else {
      state.currentSelection = previousSelection;
      state.currentLeaf = currentLeaf;
      if (!acceptedSelection && !acceptedLeaf) {
        state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
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
    if (selectionAdmissionRejected) {
      health = {
        ...health,
        stable: false,
        emergency: false,
        status: baselineRevalidation ? 'baseline-revalidation-rejected' : 'external-selection-rejected',
      };
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
      && !pendingAdmission
      && optimizationIntervalMs > 0
      && (!Number.isFinite(lastOptimizationScanAt)
        || Date.now() - lastOptimizationScanAt >= optimizationIntervalMs);
    const rollingDegradationTriggered = degradation.triggered
      && (health.stable || health.status === 'latency-degraded');
    let scanReason = selectionAdmissionRejected
      ? health.status
      : (rollingDegradationTriggered ? 'rolling-latency-degradation'
        : (optimizationDue ? 'periodic-optimization' : health.status));

    if (health.stable && !forceScan && !selectionAdmissionRejected
      && !rollingDegradationTriggered && !optimizationDue) {
      state.consecutiveFailures = 0;
      state.consecutivePartialFailures = 0;
      state.consecutiveLatencyFailures = 0;
      state.lastHealthyAt = new Date().toISOString();
      clearCandidateScanBackoff(state);
      setDecision('hold', 'healthy');
      await persistState();
      return {
        status: pendingAdmission
          ? (baselineRevalidation ? 'baseline-revalidated' : 'external-selection-admitted')
          : 'healthy',
        current,
        backgroundWake: this.activeCandidateScan?.promise ?? null,
      };
    }

    if (!forceScan && !selectionAdmissionRejected && requiresImmediateResponse(health)
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
        setDecision('hold', 'transient-recovered');
        await persistState();
        return {
          status: 'transient-recovered',
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

    if (!forceScan && !selectionAdmissionRejected && !rollingDegradationTriggered && !optimizationDue
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
      return { status: 'transient', current };
    }

    const elapsedSinceSwitch = state.lastSwitchAt ? Date.now() - Date.parse(state.lastSwitchAt) : Infinity;
    const minimumDwellMs = this.config.policy.minimumDwellSeconds * 1000;
    const latencyOnlyScan = health.status === 'latency-degraded'
      || rollingDegradationTriggered || optimizationDue;
    if (!forceScan && !selectionAdmissionRejected
        && latencyOnlyScan && elapsedSinceSwitch < minimumDwellMs) {
      setDecision('hold', 'minimum-dwell-active', {
        remainingSeconds: Math.ceil((minimumDwellMs - elapsedSinceSwitch) / 1000),
      });
      await persistState();
      await this.log('warn', 'minimum-dwell-active', {
        remainingSeconds: Math.ceil((minimumDwellMs - elapsedSinceSwitch) / 1000),
      });
      return { status: 'minimum-dwell', current };
    }

    const degradedRecovery = state.provisionalFallback?.profile === 'unverified';
    if (!dryRun && !(selectionAdmissionRejected && degradedRecovery)) {
      const budget = getSwitchBudget(state, this.config.policy);
      if (budget.used >= budget.count) {
        setDecision('blocked', 'switch-budget-exhausted', { used: budget.used, limit: budget.count });
        await persistState();
        await this.log('error', 'switch-budget-exhausted', {
          used: budget.used,
          limit: budget.count,
          windowSeconds: budget.windowSeconds,
          health: health.status,
        });
        return { status: 'switch-budget-exhausted', current };
      }
    }

    const scanBackoffUntil = Date.parse(state.candidateScanBackoffUntil ?? '');
    const hardFailureMayBypassBackoff = requiresImmediateResponse(health)
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
      return { status: 'scan-backoff', current };
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
      if (active?.completed) {
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
      if (!search && this.activeCandidateScan) {
        state.candidateScan = {
          status: 'running',
          startedAt: this.activeCandidateScan.startedAt,
          reason: this.activeCandidateScan.reason,
        };
        setDecision('scan', 'candidate-scan-in-progress');
        await persistState();
        return {
          status: 'candidate-scan-in-progress',
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
    delete state.candidateScan;
    state.lastCandidateScan = {
      at: new Date().toISOString(),
      reason: scanReason,
      sampledCount: search.sampled.length,
      validatedCount: search.validated?.length ?? 0,
      stable: candidates.map((entry) => entry.node),
      provisional: provisionalCandidates.map((entry) => entry.node),
      rejected: (search.rejected ?? []).map((entry) => ({ node: entry.node, reasons: entry.reasons })),
      durationMs: search.durationMs,
      deadlineMs: search.deadlineMs,
      deadlineReached: search.deadlineReached,
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
    const meaningfulImprovementRequired = !selectionAdmissionRejected && candidates.length > 0
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

    const candidate = candidates[0];
    if (!candidate) {
      activateCandidateScanBackoff(state, this.config.policy, 'no-stable-candidate');
      setDecision('hold', 'no-stable-candidate');
      await persistState();
      await this.log('error', 'no-stable-candidate', {});
      return { status: 'no-candidate', current };
    }
    if (dryRun) {
      setDecision('recommend', 'dry-run-would-switch', { from: previousSelection, to: candidate.node });
      await this.log('info', 'switch-dry-run', { from: previousSelection, to: candidate.node });
      return { status: 'would-switch', current, candidate };
    }

    const attempted = [];
    let activeSelection = previousSelection;
    let candidateBudgetExhausted = false;
    let candidateSelectionAttempted = false;
    let candidateSelectionAttempts = 0;
    let degradedRecoveryExemptionAvailable = degradedRecovery && selectionAdmissionRejected;
    const switchReason = forceScan && scanReason === 'healthy' ? 'forced-optimization' : scanReason;
    for (const nextCandidate of candidates) {
      if (candidateSelectionAttempts >= this.config.policy.maxSwitchAttempts) break;
      const fromSelection = activeSelection;
      if (backgroundScan) {
        const preSwitchLeaf = await this.resolveLeaf(nextCandidate.node);
        const preSwitchVerification = await this.probeNode(
          preSwitchLeaf,
          this.config.probes.validationRounds,
          this.config.probes.urls,
        );
        const admissionThresholds = provisionalCandidateNames.has(nextCandidate.node)
          ? this.currentThresholds()
          : this.candidateThresholds();
        if (!isStableAcrossRounds(preSwitchVerification, admissionThresholds)) {
          quarantineNode(
            state,
            nextCandidate.node,
            this.config.policy.failedNodeQuarantineSeconds,
            'pre-switch-validation-failed',
          );
          await this.log('warn', 'candidate-pre-switch-rejected', {
            node: nextCandidate.node,
            leaf: preSwitchLeaf,
            profile: provisionalCandidateNames.has(nextCandidate.node) ? 'current-health' : 'strict',
            successRate: preSwitchVerification.successRate,
            averageMs: Number.isFinite(preSwitchVerification.averageMs)
              ? Math.round(preSwitchVerification.averageMs) : null,
            maxMs: Number.isFinite(preSwitchVerification.maxMs) ? preSwitchVerification.maxMs : null,
          });
          continue;
        }
        await this.log('info', 'candidate-pre-switch-admitted', {
          node: nextCandidate.node,
          leaf: preSwitchLeaf,
          profile: provisionalCandidateNames.has(nextCandidate.node) ? 'current-health' : 'strict',
          successRate: preSwitchVerification.successRate,
          averageMs: Math.round(preSwitchVerification.averageMs),
          maxMs: preSwitchVerification.maxMs,
        });
      }
      await this.beforeSwitch();
      let budget = consumeSwitchBudget(state, this.config.policy, {
        from: fromSelection,
        to: nextCandidate.node,
        kind: 'candidate-attempt',
      });
      if (!budget.allowed && degradedRecoveryExemptionAvailable) {
        degradedRecoveryExemptionAvailable = false;
        state.switchHistory.push({
          timestamp: new Date().toISOString(),
          from: fromSelection,
          to: nextCandidate.node,
          kind: 'degraded-recovery',
          budgetExempt: true,
        });
        budget = { ...budget, allowed: true };
        await this.log('warn', 'degraded-recovery-budget-exempted', {
          from: fromSelection,
          to: nextCandidate.node,
          reason: 'current-selection-unverified',
        });
      }
      if (!budget.allowed) {
        candidateBudgetExhausted = true;
        await writeState(this.config.files.state, state);
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
      await writeState(this.config.files.state, state);
      await this.controller.select(this.config.groups.target, nextCandidate.node);
      candidateSelectionAttempted = true;
      candidateSelectionAttempts += 1;
      activeSelection = nextCandidate.node;
      state.currentSelection = activeSelection;
      state.currentLeaf = await this.resolveLeaf(activeSelection);
      await writeState(this.config.files.state, state);
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
      if (isStableAcrossRounds(verification, this.candidateThresholds())) {
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
        delete state.provisionalFallback;
        delete state.externalSelectionPendingAdmission;
        state.lastHealthyAt = state.lastSwitchAt;
        state.lastOptimizationScanAt = state.lastSwitchAt;
        setDecision('switch', 'verified-candidate', { from: previousSelection, to: nextCandidate.node });
        await writeState(this.config.files.state, state);
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
      await writeState(this.config.files.state, state);
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
      if (isStableAcrossRounds(actualPreviousVerification, this.currentThresholds())) {
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
          verified: true,
          source: 'sentinel',
        };
        state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
        delete state.provisionalFallback;
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
        await writeState(this.config.files.state, state);
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
      await this.beforeSwitch();
      getSwitchBudget(state, this.config.policy);
      state.switchHistory.push({
        timestamp: new Date().toISOString(),
        from: activeSelection,
        to: fallback.candidate.node,
        kind: 'provisional-recovery',
        budgetExempt: true,
      });
      delete state.selectionAdmissionVersion;
      await writeState(this.config.files.state, state);
      await this.controller.select(this.config.groups.target, fallback.candidate.node);
      activeSelection = fallback.candidate.node;
      state.currentSelection = activeSelection;
      state.currentLeaf = await this.resolveLeaf(activeSelection);
      delete state.externalSelectionPendingAdmission;
      await writeState(this.config.files.state, state);
      retained = fallback;
      await this.log('warn', 'provisional-fallback-restored', {
        node: activeSelection,
        leaf: state.currentLeaf,
        budgetExempt: true,
      });
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
      delete state.selectionAdmissionVersion;
    }
    setDecision('hold', provisional ? 'provisional-fallback' : 'degraded-fallback', {
      retained: retained?.candidate.node ?? previousSelection,
    });
    await writeState(this.config.files.state, state);
    await this.log('error', 'no-verified-fallback', {
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
