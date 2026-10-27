const BUDGET_CLASSES = ['optimization', 'recovery', 'rescue'];

function timestampOf(entry) {
  return Date.parse(typeof entry === 'string' ? entry : entry?.timestamp);
}

function budgetClassOf(entry) {
  if (BUDGET_CLASSES.includes(entry?.budgetClass)) return entry.budgetClass;
  // 旧豁免仅保留审计，不能据此生成或消耗新版安全恢复额度。
  if (entry?.kind === 'recovery-rollback' || entry?.budgetExempt === true) return null;
  return 'optimization';
}

function validateBudgetClass(budgetClass, { consuming = false } = {}) {
  if (!BUDGET_CLASSES.includes(budgetClass) || (consuming && budgetClass === 'rescue')) {
    throw new TypeError(`不支持的切换预算类别：${budgetClass}`);
  }
}

export function getBudgetSnapshot(state, policy = {}, now = Date.now()) {
  const count = policy.switchBudgetCount ?? 3;
  const windowSeconds = policy.switchBudgetWindowSeconds ?? 600;
  const windowMs = windowSeconds * 1000;
  const cutoff = now - windowMs;
  state.switchHistory = (state.switchHistory ?? []).filter((entry) => {
    const timestamp = timestampOf(entry);
    return Number.isFinite(timestamp) && timestamp > cutoff;
  });

  return Object.fromEntries(BUDGET_CLASSES.map((budgetClass) => {
    const limit = budgetClass === 'rescue' ? 1 : count;
    const timestamps = state.switchHistory
      .filter((entry) => budgetClassOf(entry) === budgetClass)
      .map(timestampOf)
      .sort((a, b) => a - b);
    // 兼容旧状态中超额账目，释放到低于上限时才允许下一次选择。
    const blockedUntil = timestamps.length >= limit
      ? new Date(timestamps[timestamps.length - limit] + windowMs).toISOString()
      : null;
    return [budgetClass, {
      budgetClass,
      used: timestamps.length,
      count: limit,
      windowSeconds,
      blockedUntil,
    }];
  }));
}

export function getSwitchBudget(state, policy, budgetClass = 'optimization') {
  validateBudgetClass(budgetClass);
  return getBudgetSnapshot(state, policy)[budgetClass];
}

export function consumeSwitchBudget(
  state,
  policy,
  entry,
  { budgetClass = 'optimization', allowRescue = false } = {},
) {
  validateBudgetClass(budgetClass, { consuming: true });
  const now = Date.now();
  const snapshot = getBudgetSnapshot(state, policy, now);
  let selectedClass = budgetClass;
  if (snapshot[budgetClass].used >= snapshot[budgetClass].count) {
    // 调用方必须先完成硬故障、实时候选和守卫验证；此处只约束持久化额度。
    if (budgetClass !== 'recovery' || allowRescue !== true
      || snapshot.rescue.used >= snapshot.rescue.count) {
      return {
        ...snapshot[budgetClass],
        allowed: false,
        requestedBudgetClass: budgetClass,
        rescued: false,
      };
    }
    selectedClass = 'rescue';
  }

  const recorded = {
    ...entry,
    timestamp: new Date(now).toISOString(),
    budgetClass: selectedClass,
  };
  // 历史兼容字段不能让新选择绕过所属账本。
  delete recorded.budgetExempt;
  state.switchHistory.push(recorded);
  return {
    ...getBudgetSnapshot(state, policy, now)[selectedClass],
    allowed: true,
    requestedBudgetClass: budgetClass,
    rescued: selectedClass === 'rescue',
  };
}

export function recordRecoveryRollback(state, policy, from, to) {
  getBudgetSnapshot(state, policy);
  state.switchHistory.push({
    timestamp: new Date().toISOString(),
    from,
    to,
    kind: 'recovery-rollback',
  });
}
