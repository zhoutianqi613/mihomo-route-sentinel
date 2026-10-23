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
    typeof entry === 'string' || entry.kind !== 'recovery-rollback'
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
  constructor({ controller, config, logger, beforeSwitch = async () => {} }) {
    this.controller = controller;
    this.config = config;
    this.log = logger;
    this.beforeSwitch = beforeSwitch;
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

  async findCandidates(currentLeaf, excludedNodes = new Set()) {
    const source = await this.controller.getProxy(this.config.groups.candidates);
    if (!Array.isArray(source.all) || source.all.length === 0) {
      await this.log('error', 'candidate-source-empty', { group: this.config.groups.candidates });
      return { stable: [], sampled: [] };
    }
    const candidates = this.filterCandidates(source.all, currentLeaf, excludedNodes);
    await this.log('info', 'candidate-scan-started', { count: candidates.length });
    const scanUrls = this.config.probes.urls.slice(0, this.config.probes.scanUrlCount);
    const quickResults = await mapLimit(candidates, this.config.probes.parallelism,
      (node) => this.probeNode(node, this.config.probes.scanRounds, scanUrls));
    const shortlist = quickResults
      .filter((result) => result.successes > 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, this.config.probes.topCandidates);
    await this.log('info', 'candidate-shortlist', {
      nodes: shortlist.map((result) => ({ node: result.node, successRate: result.successRate, averageMs: Math.round(result.averageMs) })),
    });
    const validated = await mapLimit(shortlist, Math.min(this.config.probes.parallelism, shortlist.length),
      (result) => this.probeNode(result.node, this.config.probes.validationRounds, this.config.probes.urls));
    const stable = validated
      .filter((result) => isStableAcrossRounds(result, this.candidateThresholds()))
      .sort((a, b) => a.score - b.score);
    await this.log('info', 'candidate-validation-completed', {
      stable: stable.map((result) => ({
        node: result.node,
        successRate: result.successRate,
        averageMs: Math.round(result.averageMs),
        maxMs: result.maxMs,
      })),
    });
    return { stable, sampled: quickResults };
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

  async runOnce({ dryRun = true, forceScan = false, linkTelemetry } = {}) {
    const state = await readState(this.config.files.state);
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

    if (health.stable && !forceScan && !selectionAdmissionRejected) {
      state.consecutiveFailures = 0;
      state.consecutivePartialFailures = 0;
      state.consecutiveLatencyFailures = 0;
      state.lastHealthyAt = new Date().toISOString();
      clearCandidateScanBackoff(state);
      await persistState();
      return {
        status: pendingAdmission
          ? (baselineRevalidation ? 'baseline-revalidated' : 'external-selection-admitted')
          : 'healthy',
        current,
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
      if (health.stable) {
        state.consecutiveFailures = 0;
        state.consecutivePartialFailures = 0;
        state.consecutiveLatencyFailures = 0;
        state.lastHealthyAt = new Date().toISOString();
        clearCandidateScanBackoff(state);
        await persistState();
        return { status: 'transient-recovered', current };
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

    if (!forceScan && !selectionAdmissionRejected
        && requiredFailures > 0 && state.consecutiveFailures < requiredFailures) {
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
    if (!forceScan && !selectionAdmissionRejected
        && health.status === 'latency-degraded' && elapsedSinceSwitch < minimumDwellMs) {
      await persistState();
      await this.log('warn', 'minimum-dwell-active', {
        remainingSeconds: Math.ceil((minimumDwellMs - elapsedSinceSwitch) / 1000),
      });
      return { status: 'minimum-dwell', current };
    }

    if (!dryRun) {
      const budget = getSwitchBudget(state, this.config.policy);
      if (budget.used >= budget.count) {
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
      await persistState();
      await this.log('warn', 'candidate-scan-backoff-active', {
        remainingSeconds: Math.ceil((scanBackoffUntil - Date.now()) / 1000),
        previousOutcome: state.lastCandidateScanOutcome ?? null,
      });
      return { status: 'scan-backoff', current };
    }

    const quarantined = getActiveQuarantines(state);
    let search = await this.findCandidates(currentLeaf, quarantined);
    let candidates = search.stable;
    if (candidates.length === 0 && requiresImmediateResponse(health) && quarantined.size > 0) {
      await this.log('warn', 'quarantine-bypassed-for-immediate-failure', {
        count: quarantined.size,
        trigger: health.status,
      });
      search = await this.findCandidates(currentLeaf);
      candidates = search.stable;
    }

    const upstreamOutage = await this.detectUpstreamOutage(currentLeaf, current, search.sampled);
    if (upstreamOutage) {
      activateCandidateScanBackoff(state, this.config.policy, 'upstream-outage');
      await persistState();
      await this.log('error', 'upstream-outage-detected', {
        failedCandidateCount: upstreamOutage.failedCandidateCount,
        minimumCandidates: upstreamOutage.minimumCandidates,
        controlSuccessRate: upstreamOutage.control.successRate,
      });
      return { status: 'upstream-outage', current, control: upstreamOutage.control };
    }
    if (health.status === 'latency-degraded' && !selectionAdmissionRejected && candidates.length > 0) {
      const improvement = Math.min(
        this.config.policy.minimumImprovementMs,
        current.averageMs * this.config.policy.minimumImprovementRatio,
      );
      candidates = candidates.filter((candidate) => candidate.averageMs <= current.averageMs - improvement);
      if (candidates.length === 0) {
        activateCandidateScanBackoff(state, this.config.policy, 'no-meaningful-improvement');
        await persistState();
        await this.log('warn', 'no-meaningful-improvement', { requiredImprovementMs: Math.round(improvement) });
        return { status: 'no-improvement', current };
      }
    }

    const candidate = candidates[0];
    if (!candidate) {
      activateCandidateScanBackoff(state, this.config.policy, 'no-stable-candidate');
      await persistState();
      await this.log('error', 'no-stable-candidate', {});
      return { status: 'no-candidate', current };
    }
    if (dryRun) {
      await this.log('info', 'switch-dry-run', { from: previousSelection, to: candidate.node });
      return { status: 'would-switch', current, candidate };
    }

    const attempted = [];
    let activeSelection = previousSelection;
    let candidateBudgetExhausted = false;
    const switchReason = health.status;
    const switchCandidates = candidates.slice(0, this.config.policy.maxSwitchAttempts);
    for (const nextCandidate of switchCandidates) {
      const fromSelection = activeSelection;
      await this.beforeSwitch();
      const budget = consumeSwitchBudget(state, this.config.policy, {
        from: fromSelection,
        to: nextCandidate.node,
        kind: 'candidate-attempt',
      });
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
        nextCandidate.node,
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
        delete state.externalSelectionPendingAdmission;
        state.lastHealthyAt = state.lastSwitchAt;
        await writeState(this.config.files.state, state);
        await this.log('info', 'switch-verified', {
          node: nextCandidate.node,
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
    }

    const previousVerification = await this.probeNode(currentLeaf, 1, this.config.probes.urls);
    if (!selectionAdmissionRejected && this.config.policy.rollbackOnFailure
      && isStable(previousVerification, this.currentThresholds())) {
      await this.beforeSwitch();
      await this.controller.select(this.config.groups.target, previousSelection);
      recordRecoveryRollback(state, this.config.policy, activeSelection, previousSelection);
      state.currentSelection = previousSelection;
      state.currentLeaf = currentLeaf;
      const recoveredAt = new Date().toISOString();
      state.consecutiveFailures = 0;
      state.consecutivePartialFailures = 0;
      state.consecutiveLatencyFailures = 0;
      state.lastSwitchAt = recoveredAt;
      state.lastSwitch = {
        from: activeSelection,
        to: previousSelection,
        reason: 'rollback-recovered',
        trigger: health.status,
        verified: true,
        source: 'sentinel',
      };
      state.selectionAdmissionVersion = SELECTION_ADMISSION_VERSION;
      state.lastHealthyAt = recoveredAt;
      await this.log('warn', 'switch-recovery-rollback', {
        from: activeSelection,
        restored: previousSelection,
        budgetExempt: true,
      });
      await writeState(this.config.files.state, state);
      return { status: 'rollback-recovered', current, candidate, verification: previousVerification };
    }

    const fallback = attempted.sort((a, b) => a.verification.score - b.verification.score)[0];
    let retained = attempted.find((entry) => entry.candidate.node === activeSelection) ?? fallback;
    if (fallback && activeSelection !== fallback.candidate.node) {
      await this.beforeSwitch();
      const fallbackBudget = consumeSwitchBudget(state, this.config.policy, {
        from: activeSelection,
        to: fallback.candidate.node,
        kind: 'unverified-fallback',
      });
      if (fallbackBudget.allowed) {
        delete state.selectionAdmissionVersion;
        await writeState(this.config.files.state, state);
        await this.controller.select(this.config.groups.target, fallback.candidate.node);
        activeSelection = fallback.candidate.node;
        state.currentSelection = activeSelection;
        state.currentLeaf = await this.resolveLeaf(activeSelection);
        delete state.externalSelectionPendingAdmission;
        await writeState(this.config.files.state, state);
        retained = fallback;
      } else {
        await this.log('error', 'fallback-selection-budget-exhausted', {
          used: fallbackBudget.used,
          limit: fallbackBudget.count,
          windowSeconds: fallbackBudget.windowSeconds,
          retained: activeSelection,
          blockedFallback: fallback.candidate.node,
          candidateBudgetExhausted,
        });
      }
    }
    if (retained) {
      state.quarantinedNodes ??= {};
      delete state.quarantinedNodes[activeSelection];
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
        reason: 'unverified-fallback',
        trigger: switchReason,
        verified: false,
        source: 'sentinel',
      };
    }
    await writeState(this.config.files.state, state);
    await this.log('error', 'no-verified-fallback', {
      retained: retained?.candidate.node ?? previousSelection,
      previousHealthy: false,
      retentionReason: retained === fallback
        ? 'best-observed-after-verification-failures'
        : 'switch-budget-exhausted-current-selection-retained',
    });
    return {
      status: 'unverified-fallback',
      current,
      candidate: retained?.candidate ?? candidate,
      verification: retained?.verification,
    };
  }
}

export { classifyHealth, isStable, mapLimit, summarizeSamples };
