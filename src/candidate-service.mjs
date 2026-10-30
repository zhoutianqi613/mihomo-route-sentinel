// 候选服务：候选发现、扫描生命周期、快照创建/复用与候选过滤。
// 从 watchdog.mjs 逐字迁出（逻辑未改）；activeCandidateScan 的生命周期仍由 watchdog 持有，
// 通过 get/set 注入读写，避免把实例字段带进服务。
import {
  explainRoundStability,
  hasCompleteProbeRounds,
  hasStrictAdmissionEvidence,
  isStableAcrossRounds,
} from './health-policy.mjs';
import { waitUntil } from './probe-scheduler.mjs';

const REAL_CLOCK = Object.freeze({
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
});

export function createCandidateService({
  controller,
  config,
  logger,
  probes,
  currentThresholds,
  candidateThresholds,
  clock = REAL_CLOCK,
  getActiveCandidateScan = () => null,
  setActiveCandidateScan = () => {},
  // 兼容既有实例方法替换（测试/诊断会改写 watchdog.findCandidates/discoverCandidates）。
  externalFindCandidates = null,
  externalDiscoverCandidates = null,
}) {
  const service = {
    candidateScanMatches(scan, selection, leaf) {
      return scan?.selection === selection && scan?.leaf === leaf;
    },

    startBackgroundCandidateScan({
      selection,
      leaf,
      excludedNodes,
      allowProvisionalRecovery,
      reason,
      recovery = allowProvisionalRecovery,
    }) {
      getActiveCandidateScan()?.cancel?.();
      const abortController = new AbortController();
      const scan = {
        selection,
        leaf,
        reason,
        recovery,
        startedAt: clock.nowIso(),
        completed: false,
        invalidated: false,
        result: null,
        error: null,
        cancel: () => abortController.abort(),
      };
      // 与迁移前一致：扫描任务经过实例方法（可被替换），而不是直接绑定内部函数。
      const runFindCandidates = externalFindCandidates
        ?? ((...args) => service.findCandidates(...args));
      scan.promise = runFindCandidates(leaf, excludedNodes, {
        allowProvisionalRecovery, background: true, signal: abortController.signal,
      })
        .then((result) => {
          result.completedAt ??= clock.nowIso();
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
      setActiveCandidateScan(scan);
      return scan;
    },

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
        at: search.completedAt ?? clock.nowIso(),
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
    },

    searchFromCandidateSnapshot(snapshot, selection, leaf) {
      if (!snapshot || snapshot.selection !== selection || snapshot.leaf !== leaf) return null;
      const ageMs = clock.now() - Date.parse(snapshot.at ?? '');
      if (!Number.isFinite(ageMs)
          || ageMs > config.policy.candidateSnapshotMaxAgeSeconds * 1000) return null;
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
    },

    filterCandidates(candidates, currentLeaf, excludedNodes = new Set()) {
      const include = config.probes.includeRegex ? new RegExp(config.probes.includeRegex, 'i') : null;
      const exclude = config.probes.excludeRegex ? new RegExp(config.probes.excludeRegex, 'i') : null;
      return [...new Set(candidates)].filter((name) => name !== currentLeaf
        && !excludedNodes.has(name)
        && (!include || include.test(name))
        && (!exclude || !exclude.test(name)));
    },

    async discoverCandidates(candidates, scanUrls, deadlineAt, {
      rounds = config.probes.scanRounds,
      timeoutMs = config.probes.discoveryTimeoutMs,
      event = 'candidate-discovery-completed',
      background = false,
      signal,
    } = {}) {
      const startedAt = clock.now();
      // 组级 delay 会隐式探测当前节点，无法与健康检查逐节点互斥。
      // 仅探测候选池，确保每个节点的轮次与业务目标始终串行。
      const results = await probes.probeCandidatesInParallel(
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
      await logger('info', event, {
        method: probeStats.method,
        durationMs: clock.now() - startedAt,
        candidateCount: candidates.length,
        responsiveCount: results.filter((result) => result.successes > 0).length,
        failureReasons,
        probeStats,
      });
      return results;
    },

    async findCandidates(currentLeaf, excludedNodes = new Set(), {
      allowProvisionalRecovery = false, background = false, signal,
    } = {}) {
      const scanStartedAt = clock.now();
      let deadlineMs = config.probes.scanDeadlineMs;
      let deadlineAt = scanStartedAt + deadlineMs;
      const source = await waitUntil(
        controller.getProxy(config.groups.candidates),
        deadlineAt,
        '候选组读取超过扫描截止时间',
        clock,
      );
      if (!Array.isArray(source.all) || source.all.length === 0) {
        await logger('error', 'candidate-source-empty', { group: config.groups.candidates });
        return {
          stable: [],
          provisional: [],
          sampled: [],
          validated: [],
          rejected: [],
          durationMs: clock.now() - scanStartedAt,
          deadlineMs: config.probes.scanDeadlineMs,
          deadlineReached: false,
        };
      }
      const candidates = service.filterCandidates(source.all, currentLeaf, excludedNodes);
      const scanUrls = config.probes.urls.slice(0, config.probes.scanUrlCount);
      // 后台发现须能保留慢速可达出口；快速初筛超时不能成为救援资格门槛。
      const discoveryTimeoutMs = background
        ? Math.max(config.probes.discoveryTimeoutMs, config.probes.timeoutMs)
        : config.probes.discoveryTimeoutMs;
      if (background) {
        // 后台允许完成现有配置要求的全部样本；紧急发现仍由原 scanDeadlineMs 约束。
        const batches = (count) => Math.ceil(count / config.probes.parallelism);
        deadlineMs += batches(candidates.length) * config.probes.scanRounds
          * scanUrls.length * discoveryTimeoutMs;
        deadlineMs += batches(Math.min(candidates.length, config.probes.maxValidationCandidates))
          * Math.max(2, config.probes.validationRounds)
          * config.probes.urls.length * config.probes.timeoutMs;
        deadlineAt = scanStartedAt + deadlineMs;
      }
      await logger('info', 'candidate-scan-started', {
        count: candidates.length, background, deadlineMs,
      });
      const runDiscoverCandidates = externalDiscoverCandidates
        ?? ((...args) => service.discoverCandidates(...args));
      const quickResults = await runDiscoverCandidates(candidates, scanUrls, deadlineAt, {
        background, signal, timeoutMs: discoveryTimeoutMs,
      });
      const ranked = quickResults
        .filter((result) => result.successes > 0)
        .sort((a, b) => a.score - b.score)
        .slice(0, config.probes.maxValidationCandidates);
      await logger('info', 'candidate-shortlist', {
        nodes: ranked.map((result) => ({
          node: result.node,
          successRate: result.successRate,
          averageMs: Math.round(result.averageMs),
        })),
      });
      const validated = await runDiscoverCandidates(
        ranked.map((result) => result.node),
        config.probes.urls,
        deadlineAt,
        {
          rounds: Math.max(2, config.probes.validationRounds),
          timeoutMs: config.probes.timeoutMs,
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
        result, config.probes.urls, Math.max(2, config.probes.validationRounds),
      );
      const strictResults = validated.filter((result) => hasStrictAdmissionEvidence(
        result, config.probes, candidateThresholds(),
      ));
      stable.push(...strictResults);
      provisional.push(...validated.filter((result) => !strictResults.includes(result)
        && hasCompleteSamples(result)
        && isStableAcrossRounds(result, currentThresholds())));
      stable.sort((a, b) => a.score - b.score);
      provisional.sort((a, b) => a.score - b.score);
      const rejected = validated
        .filter((result) => !stable.includes(result))
        .map((result) => ({ node: result.node, ...explainRoundStability(result, candidateThresholds()) }));
      await logger('info', 'candidate-validation-completed', {
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
        durationMs: clock.now() - scanStartedAt,
        deadlineMs,
        deadlineReached: clock.now() >= deadlineAt,
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
        durationMs: clock.now() - scanStartedAt,
        deadlineMs,
        deadlineReached: clock.now() >= deadlineAt,
      };
    }
  };
  return service;
}
