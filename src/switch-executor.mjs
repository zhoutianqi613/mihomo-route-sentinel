// 切换执行层：临界区、守卫超时、select、切后验证、回滚/临时候选恢复与保留。
// 从 watchdog.mjs 逐字迁出（逻辑未改）；controller/probes/logger/预算与 runOnce 回调全部注入。
import {
  activateCandidateScanBackoff,
  classifyHealth,
  clearCandidateScanBackoff,
  compareAvailability,
  hasCompleteProbeRounds,
  hasStrictAdmissionEvidence,
  isAvailabilityImprovement,
  isStableAcrossRounds,
  quarantineNode,
} from './health-policy.mjs';

const SWITCH_GUARD_TIMEOUT = Symbol('switch-guard-timeout');
const DEFAULT_GUARD_TIMEOUT_MS = 3000;

function quarantineNodeAt(clock, state, node, seconds, reason, kind = 'network') {
  return quarantineNode(state, node, seconds, reason, kind, clock.now());
}

function activateCandidateScanBackoffAt(clock, state, policy, reason) {
  return activateCandidateScanBackoff(state, policy, reason, clock.now());
}

export function createSwitchExecutor({
  controller,
  config,
  clock,
  probes,
  logger,
  beforeSwitch = async () => {},
  onSwitchStart = () => {},
  onSwitchEnd = () => {},
  guardTimeoutMs = DEFAULT_GUARD_TIMEOUT_MS,
}) {
  const effectiveGuardTimeoutMs = Number.isFinite(guardTimeoutMs) && guardTimeoutMs > 0
    ? Math.trunc(guardTimeoutMs)
    : DEFAULT_GUARD_TIMEOUT_MS;
  let switchAttemptDepth = 0;

  const executor = {
    get switchAttemptDepth() { return switchAttemptDepth; },

    /**
     * 切换尝试临界区：一次切换尝试从 beforeSwitch 开始，覆盖 select、切后
     * resolveLeaf/落盘/postSwitchDelay/验证与失败隔离、回滚决策，期间 5s 定时守卫不得运行。
     * 深度计数保证嵌套尝试只在最外层触发 onSwitchStart/onSwitchEnd。
     */
    beginSwitchAttempt() {
      if (switchAttemptDepth === 0) onSwitchStart();
      switchAttemptDepth += 1;
    },

    endSwitchAttempt() {
      if (switchAttemptDepth === 0) return;
      switchAttemptDepth -= 1;
      if (switchAttemptDepth === 0) onSwitchEnd();
    },

    async runSwitchAttempt(execute) {
      this.beginSwitchAttempt();
      try {
        return await execute();
      } finally {
        this.endSwitchAttempt();
      }
    },

    /**
     * 守卫超时上限：常规路径取 min(guardTimeout, …)；应急路径保底 250ms，且不超过 guardTimeout。
     * deadlineAt 为本次决策截止；调用方不传时返回常规上限。
     */
    guardTimeoutFor(deadlineAt = Infinity) {
      if (!Number.isFinite(deadlineAt)) return effectiveGuardTimeoutMs;
      const remainingMs = Math.max(250, deadlineAt - clock.now());
      return Math.min(effectiveGuardTimeoutMs, remainingMs);
    },

    /**
     * 切换选路：守卫评估与 Controller select 互斥，且守卫最多占用有限时间。
     * 超时直接返回 blocked，绝不调用 select，也不执行 budget 等副作用的 beforeSelect。
     * onSwitchStart/onSwitchEnd 由外层 runSwitchAttempt/beginSwitchAttempt 负责。
     */
    async guardedSelect(group, name, {
      timeoutMs = effectiveGuardTimeoutMs,
      beforeSelect = null,
    } = {}) {
      const requestedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : effectiveGuardTimeoutMs;
      const effectiveTimeoutMs = Math.max(1, Math.min(effectiveGuardTimeoutMs, requestedTimeoutMs));
      let guardTimer = null;
      try {
        // 守卫在独立 promise 上执行；超时只停止等待，不能中断已经发出的守卫副作用。
        const guardPromise = Promise.resolve().then(() => beforeSwitch());
        const timeoutPromise = new Promise((resolve) => {
          guardTimer = setTimeout(() => resolve(SWITCH_GUARD_TIMEOUT), effectiveTimeoutMs);
        });
        let guardResult;
        try {
          guardResult = await Promise.race([guardPromise, timeoutPromise]);
        } finally {
          if (guardTimer) clearTimeout(guardTimer);
          guardTimer = null;
        }
        if (guardResult === SWITCH_GUARD_TIMEOUT) {
          return { blocked: true, reason: 'guardrail-timeout', timeoutMs: effectiveTimeoutMs };
        }
        // 预算记账等选路前逻辑必须落在临界区内，但只能在守卫通过后执行。
        const prepared = beforeSelect ? await beforeSelect() : null;
        if (prepared?.blocked) return prepared;
        await controller.select(group, name);
        return { blocked: false, ...(prepared ?? {}) };
      } finally {
        if (guardTimer) clearTimeout(guardTimer);
      }
    },

    /**
     * runOnce 的切换执行段（候选尝试、回滚、临时候选恢复与保留），判定输入由 ctx 提供。
     * 返回 runOnce 的最终结果对象。
     */
    async executeSwitchTail(ctx) {
      const {
        state, candidate, candidates, current, previousSelection, currentLeaf, health,
        selectionAdmissionRejected, search, forceScan, scanReason, budgetClass,
        setDecision, persistState, recordEvaluation, recordAdmission,
        resolveLeaf, probeNode, currentThresholds, candidateThresholds,
        consumeSwitchBudget, getSwitchBudget, recordRecoveryRollback, selectionAdmissionVersion,
      } = ctx;
      void probes;
    const attempted = [];
    let activeSelection = previousSelection;
    // 初始故障仍用于报告；安全恢复资格必须跟随当前实际出口的最新验证。
    let activeSelectionHealth = health;
    let candidateBudgetExhausted = false;
    let candidateSelectionAttempted = false;
    let candidateSelectionAttempts = 0;
    const switchReason = forceScan && scanReason === 'healthy' ? 'forced-optimization' : scanReason;
    for (const nextCandidate of candidates) {
      if (candidateSelectionAttempts >= config.policy.maxSwitchAttempts) break;
      this.beginSwitchAttempt();
      try {
        const fromSelection = activeSelection;
        const switchAttempt = await this.guardedSelect(
          config.groups.target,
          nextCandidate.node,
          {
            beforeSelect: async () => {
              const budget = consumeSwitchBudget(state, config.policy, {
                from: fromSelection,
                to: nextCandidate.node,
                kind: 'candidate-attempt',
              }, { budgetClass, allowRescue: activeSelectionHealth.emergency === true });
              if (!budget.allowed) {
                candidateBudgetExhausted = true;
                await persistState();
                await logger('error', 'switch-budget-exhausted', {
                  used: budget.used,
                  limit: budget.count,
                  windowSeconds: budget.windowSeconds,
                  health: switchReason,
                  from: activeSelection,
                  blockedCandidate: nextCandidate.node,
                  kind: 'candidate-attempt',
                });
                return { blocked: true, reason: 'switch-budget-exhausted' };
              }
              clearCandidateScanBackoff(state);
              delete state.selectionAdmissionVersion;
              await persistState();
              return {};
            },
          },
        );
        if (switchAttempt.blocked) {
          if (switchAttempt.reason === 'guardrail-timeout') {
            setDecision('hold', 'guardrail-timeout');
            await persistState();
            await logger('warn', 'switch-guardrail-timeout', {
              node: nextCandidate.node,
              phase: 'candidate-selection',
              timeoutMs: switchAttempt.timeoutMs,
            });
            return { status: 'guardrail-timeout', current };
          }
          break;
        }
        candidateSelectionAttempted = true;
        candidateSelectionAttempts += 1;
        activeSelection = nextCandidate.node;
        state.currentSelection = activeSelection;
        state.currentLeaf = await resolveLeaf(activeSelection);
        recordAdmission('pending', activeSelection, state.currentLeaf);
        await persistState();
        await logger('warn', 'node-switched', {
          from: fromSelection,
          to: nextCandidate.node,
          reason: switchReason,
        });
        await clock.sleep(config.policy.postSwitchDelaySeconds * 1000);
        const verification = await probeNode(
          state.currentLeaf,
          config.policy.postSwitchRounds,
          config.probes.urls,
        );
        activeSelectionHealth = classifyHealth(verification, currentThresholds(), config.policy);
        recordEvaluation(verification, activeSelectionHealth,
          activeSelection, state.currentLeaf);
        // 切后一轮只能确认本轮同叶子的完整严格扫描证据仍有效；旧快照不能补齐轮次。
        const liveStrictEvidence = [nextCandidate.preSwitchVerification,
          ...(search.source === 'candidate-snapshot' ? [] : (search.validated ?? []))]
          .some((entry) => entry?.node === state.currentLeaf
            && hasStrictAdmissionEvidence(entry, config.probes, candidateThresholds()));
        const strictAfterSwitch = hasStrictAdmissionEvidence(
          verification, config.probes, candidateThresholds(),
        ) || (liveStrictEvidence
          && hasCompleteProbeRounds(verification, config.probes.urls, 1)
          && isStableAcrossRounds(verification, candidateThresholds()));
        if (strictAfterSwitch) {
          // 旧出口可能只是相对变慢，不是坏节点：成功切换后只做短冷处理，避免它被永久排除。
          quarantineNodeAt(clock, 
            state,
            currentLeaf,
            config.policy.oldNodeCooldownSeconds,
            switchReason,
            'cooldown',
          );
          state.consecutiveFailures = 0;
          state.consecutivePartialFailures = 0;
          state.consecutiveLatencyFailures = 0;
          state.degradationWindow = [];
          state.lastSwitchAt = clock.nowIso();
          state.lastSwitch = {
            from: previousSelection,
            to: nextCandidate.node,
            reason: switchReason,
            trigger: switchReason,
            verified: true,
            source: 'sentinel',
          };
          state.selectionAdmissionVersion = selectionAdmissionVersion;
          recordAdmission('strict', activeSelection, state.currentLeaf);
          delete state.provisionalFallback;
          delete state.externalSelectionPendingAdmission;
          state.lastHealthyAt = state.lastSwitchAt;
          state.lastOptimizationScanAt = state.lastSwitchAt;
          setDecision('switch', 'verified-candidate', { from: previousSelection, to: nextCandidate.node });
          await persistState();
          await logger('info', 'switch-verified', {
            node: nextCandidate.node,
            leaf: state.currentLeaf,
            reason: switchReason,
            kind: 'cooldown',
            successRate: verification.successRate,
            averageMs: Math.round(verification.averageMs),
            maxMs: verification.maxMs,
          });
          return { status: 'switched', current, candidate: nextCandidate, verification };
        }
        attempted.push({ candidate: nextCandidate, verification });
        // 切后复核失败属于真实验证失败，仍按网络隔离时长处理，但单独标注 kind 便于审计。
        quarantineNodeAt(clock, 
          state,
          nextCandidate.node,
          config.policy.failedNodeQuarantineSeconds,
          'post-switch-verification-failed',
          'verify',
        );
        await logger('error', 'switch-verification-failed', {
          node: nextCandidate.node,
          kind: 'verify',
          successRate: verification.successRate,
          averageMs: Number.isFinite(verification.averageMs) ? Math.round(verification.averageMs) : null,
          maxMs: Number.isFinite(verification.maxMs) ? verification.maxMs : null,
        });
        if (isStableAcrossRounds(verification, currentThresholds())) {
          await logger('warn', 'provisional-fallback-available', {
            node: nextCandidate.node,
            leaf: state.currentLeaf,
            reason: 'strict-admission-failed-current-threshold-passed',
          });
        }
      } finally {
        this.endSwitchAttempt();
      }
    }

    if (!candidateSelectionAttempted) {
      activateCandidateScanBackoffAt(clock, 
        state,
        config.policy,
        candidateBudgetExhausted ? 'switch-budget-exhausted' : 'pre-switch-validation-failed',
      );
      setDecision(
        candidateBudgetExhausted ? 'blocked' : 'hold',
        candidateBudgetExhausted ? 'switch-budget-exhausted' : 'no-pre-switch-candidate',
      );
      await persistState();
      await logger('error', candidateBudgetExhausted
        ? 'switch-budget-exhausted'
        : 'no-pre-switch-candidate', {});
      return {
        status: candidateBudgetExhausted ? 'switch-budget-exhausted' : 'no-pre-switch-candidate',
        current,
      };
    }

    const previousVerification = await probeNode(
      currentLeaf,
      config.policy.postSwitchRounds,
      config.probes.urls,
    );
    const rollbackEligible = !selectionAdmissionRejected && config.policy.rollbackOnFailure
      && isStableAcrossRounds(previousVerification, currentThresholds());
    if (rollbackEligible) {
      this.beginSwitchAttempt();
      try {
        const rollbackSwitch = await this.guardedSelect(config.groups.target, previousSelection);
        if (rollbackSwitch.blocked) {
          await logger('warn', 'switch-guardrail-timeout', {
            node: previousSelection,
            phase: 'recovery-rollback',
            timeoutMs: rollbackSwitch.timeoutMs,
          });
        } else {
          const rollbackFrom = activeSelection;
          activeSelection = previousSelection;
          state.currentSelection = previousSelection;
          state.currentLeaf = await resolveLeaf(previousSelection);
          const actualPreviousVerification = state.currentLeaf === currentLeaf
            ? previousVerification
            : await probeNode(
                state.currentLeaf,
                config.policy.postSwitchRounds,
                config.probes.urls,
              );
          activeSelectionHealth = classifyHealth(
            actualPreviousVerification, currentThresholds(), config.policy,
          );
          recordEvaluation(actualPreviousVerification, activeSelectionHealth,
            previousSelection, state.currentLeaf);
          if (isStableAcrossRounds(actualPreviousVerification, currentThresholds())) {
            const rollbackStrict = hasStrictAdmissionEvidence(
              actualPreviousVerification, config.probes, candidateThresholds(),
            );
            recordRecoveryRollback(state, config.policy, rollbackFrom, previousSelection);
            const recoveredAt = clock.nowIso();
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
              state.selectionAdmissionVersion = selectionAdmissionVersion;
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
            await logger('warn', 'switch-recovery-rollback', {
              from: rollbackFrom,
              restored: previousSelection,
              leaf: state.currentLeaf,
              budgetExempt: true,
              verificationProfile: 'recovery-current',
              verificationRounds: config.policy.postSwitchRounds,
            });
            await persistState();
            return { status: 'rollback-recovered', current, candidate, verification: actualPreviousVerification };
          }
          state.switchHistory.push({
            timestamp: clock.nowIso(),
            from: rollbackFrom,
            to: previousSelection,
            kind: 'recovery-rollback-failed',
            budgetExempt: true,
          });
          attempted.push({ candidate: { node: previousSelection }, verification: actualPreviousVerification });
          quarantineNodeAt(clock, 
            state,
            state.currentLeaf,
            config.policy.failedNodeQuarantineSeconds,
            'rollback-verification-failed',
          );
          await logger('error', 'switch-recovery-rollback-failed', {
            from: rollbackFrom,
            restored: previousSelection,
            leaf: state.currentLeaf,
            successRate: actualPreviousVerification.successRate,
            averageMs: Number.isFinite(actualPreviousVerification.averageMs)
              ? Math.round(actualPreviousVerification.averageMs) : null,
            maxMs: Number.isFinite(actualPreviousVerification.maxMs) ? actualPreviousVerification.maxMs : null,
          });
        }
      } finally {
        this.endSwitchAttempt();
      }
    }

    const attemptedProvisionalCandidates = attempted
      .filter((entry) => isStableAcrossRounds(entry.verification, currentThresholds()))
      .sort((a, b) => a.verification.score - b.verification.score);
    const fallback = attemptedProvisionalCandidates[0];
    let retained = attempted.find((entry) => entry.candidate.node === activeSelection) ?? null;
    if (fallback && activeSelection !== fallback.candidate.node) {
      const recoveryBudget = getSwitchBudget(state, config.policy, 'recovery');
      const rescueBudget = getSwitchBudget(state, config.policy, 'rescue');
      const allowCurrentRescue = activeSelectionHealth.emergency === true;
      const canRestore = recoveryBudget.used < recoveryBudget.count
        || (allowCurrentRescue && rescueBudget.used < rescueBudget.count);
      if (!canRestore) {
        await logger('warn', 'provisional-restoration-budget-exhausted', { used: recoveryBudget.used });
      } else {
        // 先前可用的候选可能已失效，旧切后样本不能授权再次选择。
        const restorationLeaf = await resolveLeaf(fallback.candidate.node);
        const restorationVerification = await probeNode(
          restorationLeaf, config.policy.postSwitchRounds, config.probes.urls,
        );
        if (isStableAcrossRounds(restorationVerification, currentThresholds())) {
          this.beginSwitchAttempt();
          try {
            const restorationSwitch = await this.guardedSelect(
              config.groups.target,
              fallback.candidate.node,
              {
                beforeSelect: async () => {
                  const restoreBudget = consumeSwitchBudget(state, config.policy, {
                    from: activeSelection,
                    to: fallback.candidate.node,
                    kind: 'provisional-recovery',
                  }, { budgetClass: 'recovery', allowRescue: allowCurrentRescue });
                  if (!restoreBudget.allowed) {
                    await logger('warn', 'provisional-restoration-budget-exhausted', { used: restoreBudget.used });
                    return { blocked: true, reason: 'switch-budget-exhausted' };
                  }
                  delete state.selectionAdmissionVersion;
                  await persistState();
                  return { restoreBudget };
                },
              },
            );
            if (restorationSwitch.blocked) {
              if (restorationSwitch.reason === 'guardrail-timeout') {
                await logger('warn', 'switch-guardrail-timeout', {
                  node: fallback.candidate.node,
                  phase: 'provisional-restoration',
                  timeoutMs: restorationSwitch.timeoutMs,
                });
              }
            } else {
              const restoreBudget = restorationSwitch.restoreBudget;
              activeSelection = fallback.candidate.node;
              state.currentSelection = activeSelection;
              state.currentLeaf = await resolveLeaf(activeSelection);
              recordAdmission('pending', activeSelection, state.currentLeaf);
              const actualRestorationVerification = state.currentLeaf === restorationLeaf
                ? restorationVerification
                : await probeNode(
                    state.currentLeaf, config.policy.postSwitchRounds, config.probes.urls,
                  );
              activeSelectionHealth = classifyHealth(
                actualRestorationVerification, currentThresholds(), config.policy,
              );
              fallback.verification = actualRestorationVerification;
              recordEvaluation(actualRestorationVerification, activeSelectionHealth,
                activeSelection, state.currentLeaf);
              delete state.externalSelectionPendingAdmission;
              const restoredUsable = isStableAcrossRounds(actualRestorationVerification, currentThresholds());
              if (!restoredUsable) {
                quarantineNodeAt(clock, state, state.currentLeaf, config.policy.failedNodeQuarantineSeconds,
                  'provisional-restoration-verification-failed');
              }
              await persistState();
              retained = fallback;
              await logger(restoredUsable ? 'warn' : 'error', restoredUsable
                ? 'provisional-fallback-restored' : 'provisional-restoration-verification-failed', {
                node: activeSelection,
                leaf: state.currentLeaf,
                budgetClass: restoreBudget.budgetClass,
                successRate: actualRestorationVerification.successRate,
              });
            }
          } finally {
            this.endSwitchAttempt();
          }
        } else {
          await logger('warn', 'provisional-restoration-validation-failed', {
            node: fallback.candidate.node,
            successRate: restorationVerification.successRate,
          });
        }
      }
    }
    const provisional = retained
      && isStableAcrossRounds(retained.verification, currentThresholds());
    if (retained) {
      state.quarantinedNodes ??= {};
      if (provisional) {
        delete state.quarantinedNodes[activeSelection];
        delete state.quarantinedNodes[state.currentLeaf];
      }
      quarantineNodeAt(clock, 
        state,
        currentLeaf,
        config.policy.failedNodeQuarantineSeconds,
        switchReason,
      );
      const retainedAt = clock.nowIso();
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
        : (isAvailabilityImprovement(retained.verification, current, config.policy) ? 'rescue' : 'pending');
      recordAdmission(retainedProfile, activeSelection, state.currentLeaf);
      recordEvaluation(retained.verification,
        classifyHealth(retained.verification, currentThresholds(), config.policy),
        activeSelection, state.currentLeaf);
      delete state.selectionAdmissionVersion;
    }
    setDecision('hold', provisional ? 'provisional-fallback' : 'degraded-fallback', {
      retained: retained?.candidate.node ?? previousSelection,
    });
    await persistState();
    await logger(provisional ? 'warn' : 'error', 'no-verified-fallback', {
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
    },
  };
  return executor;
}
