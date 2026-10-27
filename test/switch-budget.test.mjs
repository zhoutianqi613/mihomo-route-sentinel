import assert from 'node:assert/strict';
import test from 'node:test';
import {
  consumeSwitchBudget,
  getBudgetSnapshot,
  getSwitchBudget,
  recordRecoveryRollback,
} from '../src/switch-budget.mjs';

const policy = { switchBudgetCount: 3, switchBudgetWindowSeconds: 600 };
const entry = { from: 'old-node', to: 'new-node', kind: 'candidate-attempt' };
const start = Date.parse('2026-10-26T10:00:00.000Z');

function clock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: start });
}

function consumePool(state, budgetClass) {
  return Array.from({ length: policy.switchBudgetCount }, () => (
    consumeSwitchBudget(state, policy, entry, { budgetClass })
  ));
}

test('优化额度耗尽后恢复池仍可独立消费，恢复耗尽也不影响优化池', (t) => {
  clock(t);
  for (const [full, available] of [['optimization', 'recovery'], ['recovery', 'optimization']]) {
    const state = {};
    assert.equal(consumePool(state, full).every((result) => result.allowed), true);
    assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: full }).allowed, false);
    assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: available }).allowed, true);
    const snapshot = getBudgetSnapshot(state, policy);
    assert.equal(snapshot[full].used, 3);
    assert.equal(snapshot[available].used, 1);
    assert.equal(snapshot.rescue.used, 0);
  }
});

test('硬故障安全恢复需显式请求，只在恢复池耗尽后允许同窗口一次', (t) => {
  clock(t);
  const state = {};
  const first = consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true });
  assert.equal(first.budgetClass, 'recovery');
  assert.equal(first.rescued, false);
  for (let index = 0; index < 2; index += 1) {
    assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery' }).allowed, true);
  }
  assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery' }).allowed, false);
  const rescued = consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true });
  assert.equal(rescued.allowed, true);
  assert.equal(rescued.budgetClass, 'rescue');
  assert.equal(rescued.requestedBudgetClass, 'recovery');
  assert.equal(rescued.rescued, true);
  assert.equal(rescued.used, 1);
  assert.equal(rescued.count, 1);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true }).allowed, false);
  }
  assert.equal(state.switchHistory.length, 4);
});

test('优化池不能使用安全恢复出口，也不能直接消费rescue', (t) => {
  clock(t);
  const state = {};
  consumePool(state, 'optimization');
  assert.equal(consumeSwitchBudget(state, policy, entry, { allowRescue: true }).allowed, false);
  assert.equal(getBudgetSnapshot(state, policy).rescue.used, 0);
  assert.throws(() => consumeSwitchBudget(state, policy, entry, { budgetClass: 'rescue', allowRescue: true }), TypeError);
  assert.throws(() => getSwitchBudget(state, policy, 'unknown'), TypeError);
});

test('持久化往返和切换失败后安全恢复账目仍有效', (t) => {
  clock(t);
  const state = {};
  consumePool(state, 'recovery');
  consumeSwitchBudget(state, policy, { ...entry, kind: 'failed-attempt' }, { budgetClass: 'recovery', allowRescue: true });
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(consumeSwitchBudget(restored, policy, entry, { budgetClass: 'recovery', allowRescue: true }).allowed, false);
  assert.equal(getBudgetSnapshot(restored, policy).rescue.used, 1);
});

test('三个账本独立滚动释放，并返回实际解除阻塞时间', (t) => {
  clock(t);
  const state = {};
  consumePool(state, 'optimization');
  t.mock.timers.tick(1000);
  consumePool(state, 'recovery');
  t.mock.timers.tick(1000);
  consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true });
  const snapshot = getBudgetSnapshot(state, policy);
  assert.equal(snapshot.optimization.blockedUntil, new Date(start + 600_000).toISOString());
  assert.equal(snapshot.recovery.blockedUntil, new Date(start + 601_000).toISOString());
  assert.equal(snapshot.rescue.blockedUntil, new Date(start + 602_000).toISOString());
  t.mock.timers.tick(598_000);
  assert.equal(getBudgetSnapshot(state, policy).optimization.used, 0);
  assert.equal(getBudgetSnapshot(state, policy).recovery.used, 3);
  t.mock.timers.tick(1000);
  assert.equal(getBudgetSnapshot(state, policy).recovery.used, 0);
  assert.equal(getBudgetSnapshot(state, policy).rescue.used, 1);
  t.mock.timers.tick(1000);
  assert.equal(getBudgetSnapshot(state, policy).rescue.used, 0);
  assert.equal(getBudgetSnapshot(state, policy).rescue.blockedUntil, null);
  assert.deepEqual(state.switchHistory, []);
});

test('旧普通记录保守计入优化池，旧豁免保留窗口内审计而不占新版安全恢复池', (t) => {
  clock(t);
  const timestamp = new Date(start).toISOString();
  const legacyAudit = [
    { timestamp, kind: 'recovery-rollback' },
    { timestamp, kind: 'provisional-recovery', budgetExempt: true },
    { timestamp, kind: 'degraded-recovery', budgetExempt: true },
  ];
  const state = { switchHistory: [timestamp, { timestamp, kind: 'candidate-attempt' }, ...legacyAudit] };
  const snapshot = getBudgetSnapshot(state, policy);
  assert.equal(snapshot.optimization.used, 2);
  assert.equal(snapshot.recovery.used, 0);
  assert.equal(snapshot.rescue.used, 0);
  assert.deepEqual(state.switchHistory.slice(2), legacyAudit);
  consumePool(state, 'recovery');
  assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true }).allowed, true);
  assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true }).allowed, false);
  assert.deepEqual(state.switchHistory.slice(2, 5), legacyAudit);
});

test('新选择中的旧豁免字段和伪造分类时间不能逃避预算', (t) => {
  clock(t);
  const state = {};
  const forged = {
    ...entry,
    kind: 'recovery-rollback',
    budgetExempt: true,
    budgetClass: 'rescue',
    timestamp: '2000-01-01T00:00:00.000Z',
  };
  for (let index = 0; index < 3; index += 1) {
    assert.equal(consumeSwitchBudget(state, policy, forged, { budgetClass: 'recovery' }).allowed, true);
  }
  assert.equal(consumeSwitchBudget(state, policy, forged, { budgetClass: 'recovery' }).allowed, false);
  assert.equal(getBudgetSnapshot(state, policy).recovery.used, 3);
  assert.equal(getBudgetSnapshot(state, policy).rescue.used, 0);
  assert.equal(state.switchHistory.every((record) => record.budgetExempt === undefined), true);
  assert.equal(state.switchHistory.every((record) => record.timestamp === new Date(start).toISOString()), true);
});

test('恢复回滚追加审计而不清空正常或安全恢复账本', (t) => {
  clock(t);
  const state = {};
  consumePool(state, 'recovery');
  consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true });
  const before = getBudgetSnapshot(state, policy);
  recordRecoveryRollback(state, policy, 'new-node', 'old-node');
  assert.deepEqual(getBudgetSnapshot(state, policy), before);
  assert.equal(state.switchHistory.at(-1).kind, 'recovery-rollback');
  assert.equal(consumeSwitchBudget(state, policy, entry, { budgetClass: 'recovery', allowRescue: true }).allowed, false);
});

test('旧超额账目需释放到低于上限，空策略使用既定默认值', (t) => {
  clock(t);
  const state = { switchHistory: [0, 1000, 2000, 3000].map((offset) => new Date(start - offset).toISOString()) };
  const budget = getSwitchBudget(state, policy);
  assert.equal(budget.used, 4);
  assert.equal(budget.blockedUntil, new Date(start + 598_000).toISOString());
  assert.deepEqual(getBudgetSnapshot({}, {}).optimization, {
    budgetClass: 'optimization', used: 0, count: 3, windowSeconds: 600, blockedUntil: null,
  });
});
