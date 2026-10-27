import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { getBudgetSnapshot } from '../src/switch-budget.mjs';
import { Watchdog } from '../src/watchdog.mjs';

async function scenario({
  profiles, count = 3, prior = 0, maxAttempts = 3, failRestoration = false,
  rollbackProfile = null, dynamicFallback = false,
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-current-budget-'));
  const config = structuredClone(defaults);
  const urls = ['1', '2', '3', '4'].map((target) => `https://service.example/${target}`);
  Object.assign(config.probes, {
    urls, controlUrls: [], currentRounds: 1, scanRounds: 1, scanUrlCount: 4,
    validationRounds: 2, parallelism: 3, topCandidates: 3,
  });
  Object.assign(config.policy, {
    hardFailureConfirmSeconds: 0, minimumDwellSeconds: 0, postSwitchDelaySeconds: 0,
    postSwitchRounds: 2, rollbackOnFailure: rollbackProfile !== null, switchBudgetCount: count,
    maxSwitchAttempts: maxAttempts,
  });
  config.groups.target = 'target';
  config.groups.candidates = 'candidates';
  config.files.state = path.join(root, 'state.json');
  const originalSelection = rollbackProfile ? 'original-group' : 'old';
  const timestamp = new Date().toISOString();
  await writeFile(config.files.state, JSON.stringify({
    currentSelection: originalSelection, currentLeaf: 'old', selectionAdmissionVersion: 1,
    selectionAdmission: { selection: originalSelection, leaf: 'old', profile: 'strict', verified: true },
    switchHistory: Array.from({ length: prior }, () => ({ timestamp, budgetClass: 'recovery' })),
  }));
  let selected = originalSelection;
  let rolledBack = false;
  let fallbackSelections = 0;
  const switches = [];
  const selectedBefore = new Set();
  const candidates = Object.keys(profiles);
  const controller = {
    async getProxy(name) {
      if (name === 'target') return { name, type: 'Selector', now: selected, all: [originalSelection, ...candidates] };
      if (name === 'candidates') return { name, type: 'URLTest', all: ['old', ...candidates] };
      if (name === 'original-group') return { name, type: 'Selector', now: rolledBack ? 'rollback-leaf' : 'old' };
      if (dynamicFallback && name === 'a') {
        return { name, type: 'Selector', now: fallbackSelections < 2 ? 'a-good' : 'a-failed' };
      }
      return { name, type: 'VLESS' };
    },
    async getDelay(node, url) {
      if (node === 'old') {
        if (rollbackProfile && selectedBefore.size > 0) return 100;
        throw new Error('模拟原节点硬故障');
      }
      if (node === 'rollback-leaf') {
        if (rollbackProfile === 'hard' || (rollbackProfile === 'partial' && url.endsWith('/4'))) {
          throw new Error('模拟回滚后的实际叶子失败');
        }
        return 700;
      }
      if (node === 'a-failed') throw new Error('模拟动态候选恢复后叶子硬故障');
      if (node === 'a-good') return selectedBefore.has('a') ? 700 : 100;
      if (!selectedBefore.has(node)) return 100 + candidates.indexOf(node) * 50;
      const profile = profiles[node];
      if (profile === 'hard' || (failRestoration && node === 'a' && selected === 'b')
        || (profile === 'partial' && url.endsWith('/4'))) {
        throw new Error('模拟实时探测失败');
      }
      return profile === 'strict' ? 120 : 700 + candidates.indexOf(node) * 100;
    },
    async select(group, node) {
      if (node === originalSelection) rolledBack = true;
      else {
        const persisted = JSON.parse(await readFile(config.files.state, 'utf8'));
        assert.equal(persisted.switchHistory.at(-1).to, node, '真实选择前必须已有对应预算账目');
      }
      if (node === 'a') fallbackSelections += 1;
      selected = node;
      selectedBefore.add(node);
      switches.push(node);
    },
  };
  const watchdog = new Watchdog({ controller, config, logger: async () => {} });
  const result = await watchdog.runOnce({ dryRun: false });
  const state = JSON.parse(await readFile(config.files.state, 'utf8'));
  return { result, state, switches, selected, budget: getBudgetSnapshot(state, config.policy) };
}

for (const profile of ['usable', 'partial']) {
  test(`普通候选切后为${profile}时不能继承初始硬故障的安全恢复资格`, async () => {
    const run = await scenario({ profiles: { a: profile, b: 'strict' }, prior: 2 });
    assert.deepEqual(run.switches, ['a']);
    assert.equal(run.selected, 'a');
    assert.equal(run.budget.recovery.used, 3);
    assert.equal(run.budget.rescue.used, 0);
    assert.equal(run.state.lastSwitch.trigger, 'hard-failure');
    assert.equal(run.state.lastEvaluation.health, profile === 'usable' ? 'healthy' : 'partial-failure');
  });

  test(`恢复池耗尽且实际出口为${profile}时不能借安全恢复额度重选旧临时候选`, async () => {
    const run = await scenario({ profiles: { a: 'usable', b: profile }, count: 2, maxAttempts: 2 });
    assert.deepEqual(run.switches, ['a', 'b']);
    assert.equal(run.selected, 'b');
    assert.equal(run.budget.recovery.used, 2);
    assert.equal(run.budget.rescue.used, 0);
    assert.equal(run.state.lastSwitch.trigger, 'hard-failure');
  });
}

test('普通候选切后仍是硬故障时可有界借一次安全恢复额度', async () => {
  const run = await scenario({ profiles: { a: 'hard', b: 'strict' }, prior: 2 });
  assert.deepEqual(run.switches, ['a', 'b']);
  assert.equal(run.result.status, 'switched');
  assert.equal(run.budget.recovery.used, 3);
  assert.equal(run.budget.rescue.used, 1);
});

test('最新实际出口仍为硬故障时可借一次安全恢复额度恢复实时可用临时候选', async () => {
  const run = await scenario({ profiles: { a: 'usable', b: 'hard' }, count: 2, maxAttempts: 2 });
  assert.deepEqual(run.switches, ['a', 'b', 'a']);
  assert.equal(run.selected, 'a');
  assert.equal(run.budget.recovery.used, 2);
  assert.equal(run.budget.rescue.used, 1);
  assert.equal(run.state.lastEvaluation.health, 'healthy');
});

test('旧临时候选恢复前实时已0%时不能主动重选或消耗安全恢复额度', async () => {
  const run = await scenario({
    profiles: { a: 'usable', b: 'hard' }, count: 2, maxAttempts: 2, failRestoration: true,
  });
  assert.deepEqual(run.switches, ['a', 'b']);
  assert.equal(run.selected, 'b');
  assert.equal(run.budget.rescue.used, 0);
});

test('所有已尝试候选真实0%时只保留当前出口，不主动重选失败候选', async () => {
  const run = await scenario({ profiles: { a: 'hard', b: 'hard' }, count: 2, maxAttempts: 2 });
  assert.deepEqual(run.switches, ['a', 'b']);
  assert.equal(run.selected, 'b');
  assert.equal(run.budget.rescue.used, 0);
});

test('回滚实际叶子变为部分失败时不能沿用上一个硬故障出口的安全恢复资格', async () => {
  const run = await scenario({
    profiles: { a: 'usable', b: 'hard' }, count: 2, maxAttempts: 2, rollbackProfile: 'partial',
  });
  assert.deepEqual(run.switches, ['a', 'b', 'original-group']);
  assert.equal(run.selected, 'original-group');
  assert.equal(run.state.currentLeaf, 'rollback-leaf');
  assert.equal(run.state.lastEvaluation.health, 'partial-failure');
  assert.equal(run.budget.rescue.used, 0);
});

test('回滚实际叶子变为硬故障时按新验证允许有界安全恢复', async () => {
  const run = await scenario({
    profiles: { a: 'usable', b: 'partial' }, count: 2, maxAttempts: 2, rollbackProfile: 'hard',
  });
  assert.deepEqual(run.switches, ['a', 'b', 'original-group', 'a']);
  assert.equal(run.selected, 'a');
  assert.equal(run.budget.rescue.used, 1);
});

test('动态临时候选恢复前旧叶子健康但切后新叶子失败时不能继承旧叶子的健康与准入', async () => {
  const run = await scenario({
    profiles: { a: 'usable', b: 'hard' }, count: 2, maxAttempts: 2, dynamicFallback: true,
  });
  assert.deepEqual(run.switches, ['a', 'b', 'a']);
  assert.equal(run.selected, 'a');
  assert.equal(run.budget.rescue.used, 1);
  assert.equal(run.state.currentLeaf, 'a-failed');
  assert.equal(run.state.lastEvaluation.leaf, 'a-failed');
  assert.equal(run.state.lastEvaluation.successRate, 0);
  assert.equal(run.state.lastEvaluation.health, 'hard-failure');
  assert.equal(run.state.selectionAdmission.profile, 'pending');
  assert.equal(run.result.status, 'degraded-fallback');
  assert.equal(run.state.quarantinedNodes['a-failed'].reason, 'provisional-restoration-verification-failed');
});
