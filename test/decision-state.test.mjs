import assert from 'node:assert/strict';
import test from 'node:test';
import { synchronizeDecisionState } from '../src/decision-state.mjs';

const now = Date.parse('2026-10-26T10:00:00.000Z');
const evaluation = (extra = {}) => ({
  timestamp: new Date(now).toISOString(), selected: 'node', leaf: 'node',
  successRate: 1, averageMs: 611, maxMs: 750, ...extra,
});
const initial = (extra = {}) => ({
  currentSelection: 'node', currentLeaf: 'node', lastEvaluation: evaluation(), ...extra,
});
const synchronize = (state, options = {}) => synchronizeDecisionState(state, {}, { now, ...options });

test('当前健康与严格准入、行动和预算四维相互独立', () => {
  const state = initial({
    lastEvaluation: evaluation({ health: 'baseline-revalidation-rejected', stable: false }),
    externalSelectionPendingAdmission: { to: 'node', leaf: 'node', source: 'baseline' },
    lastDecision: { action: 'hold', reason: 'strict-admission-pending' },
  });
  const result = synchronize(state);
  assert.equal(result.version, 1);
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.health.stable, true);
  assert.equal(result.admission.profile, 'pending');
  assert.equal(result.admission.verified, false);
  assert.equal(result.action.type, 'hold');
  assert.deepEqual(Object.keys(result.budget), ['optimization', 'recovery', 'rescue']);
  assert.equal(state.decisionState, result);
});

test('旧版矛盾状态不能由版本标记或旧严格切换抵销仍待准入的事实', () => {
  const result = synchronize(initial({
    selectionAdmissionVersion: 1,
    externalSelectionPendingAdmission: { to: 'node', leaf: 'node', source: 'baseline' },
    lastBaselineRevalidation: { to: 'node', leaf: 'node', verified: false },
    lastSwitch: { to: 'node', verified: true },
    decisionState: { version: 1, health: { status: 'baseline-revalidation-rejected' } },
  }));
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.admission.profile, 'pending');
});

test('单轮严格数值及旧版版本标记均不等于两轮严格准入', () => {
  const result = synchronize(initial({
    selectionAdmissionVersion: 1,
    lastEvaluation: evaluation({ averageMs: 400, maxMs: 500,
      samples: [{ round: 1, ok: true, delay: 400 }] }),
  }));
  assert.equal(result.admission.profile, 'usable');
  assert.equal(result.admission.verified, false);
});

test('严格准入逐轮检查，合并平均合格不能掩盖某轮超标', () => {
  const result = synchronize(initial({
    lastEvaluation: evaluation({ averageMs: 550, maxMs: 700,
      samples: [{ round: 1, ok: true, delay: 700 }, { round: 2, ok: true, delay: 400 }] }),
  }));
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.admission.profile, 'usable');
});

test('两轮均达严格边界才得到strict，未知轮次不会补成第二轮', () => {
  const state = initial({ lastEvaluation: evaluation({ averageMs: 600, maxMs: 1200,
    samples: [1, 2].flatMap((round) => [
      { round, url: 'https://one.example', ok: true, delay: 1200 },
      { round, url: 'https://two.example', ok: true, delay: 0 },
    ]) }) });
  const options = { probes: { urls: ['https://one.example', 'https://two.example'] } };
  const result = synchronize(state, options);
  assert.equal(result.admission.profile, 'strict');
  assert.equal(result.admission.verified, true);
  assert.equal(result.admission.requiresStrictAdmission, false);
  state.lastEvaluation.samples.forEach((sample) => { delete sample.round; });
  assert.equal(synchronize(state, options).admission.profile, 'usable');
});

test('历史样本缺少任一业务URL或未知配置时不能推导strict', () => {
  const state = initial({ lastEvaluation: evaluation({ averageMs: 400, maxMs: 500,
    samples: [1, 2].map((round) => ({ round, url: 'https://one.example', ok: true, delay: 400 })),
  }) });
  assert.equal(synchronize(state).admission.profile, 'usable');
  assert.equal(synchronize(state, { probes: {
    urls: ['https://one.example', 'https://two.example'],
  } }).admission.profile, 'usable');
});

test('旧rollback-recovered只有健康线证据，不能升级为严格准入', () => {
  const result = synchronize(initial({ selectionAdmissionVersion: 1,
    lastSwitch: { to: 'node', verified: true, reason: 'rollback-recovered' },
  }));
  assert.equal(result.admission.profile, 'usable');
  assert.equal(result.admission.verified, false);
});

test('rescue后一次健康不能冒充strict，仍需下一周期严格复核', () => {
  const result = synchronize(initial({
    provisionalFallback: { selection: 'node', leaf: 'node', profile: 'emergency-best-effort' },
    lastSwitch: { to: 'node', verified: false, reason: 'emergency-best-effort' },
    lastEvaluation: evaluation({ averageMs: 400, maxMs: 500 }),
  }));
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.admission.profile, 'rescue');
  assert.equal(result.admission.verified, false);
  assert.equal(result.admission.requiresStrictAdmission, true);
});

test('已声明的usable及rescue不会因旧verified字段升级严格身份', () => {
  for (const profile of ['usable', 'rescue']) {
    const result = synchronize(initial({
      selectionAdmission: { selection: 'node', leaf: 'node', profile, verified: true },
      lastSwitch: { to: 'node', verified: true },
    }));
    assert.equal(result.admission.profile, profile);
    assert.equal(result.admission.verified, false);
  }
});

test('严格身份需要绑定实际叶子，不能继承另一个动态出口的审计记录', () => {
  const state = initial({ currentSelection: 'group', currentLeaf: 'new-leaf',
    lastEvaluation: evaluation({ selected: 'group', leaf: 'new-leaf' }),
    selectionAdmission: { selection: 'group', leaf: 'old-leaf', profile: 'strict', verified: true },
    lastSwitch: { to: 'group', verified: true },
  });
  assert.equal(synchronize(state).admission.profile, 'usable');
  state.selectionAdmission = { selection: 'group', leaf: 'new-leaf', profile: 'strict', verified: true };
  assert.equal(synchronize(state).admission.profile, 'strict');
});

test('Controller实时出口不匹配时不提供健康和严格身份', () => {
  const result = synchronize(initial({
    selectionAdmission: { selection: 'node', leaf: 'node', profile: 'strict', verified: true },
  }), { selection: 'live', leaf: 'live', selectionMismatch: true });
  assert.equal(result.health.status, 'unknown');
  assert.equal(result.health.reason, 'live-selection-mismatch');
  assert.equal(result.admission.profile, 'pending');
  assert.equal(result.admission.verified, false);
});

test('切后无匹配样本时不继承旧出口健康，全失败JSON样本仍归为硬故障', () => {
  assert.equal(synchronize(initial({ currentSelection: 'new', currentLeaf: 'new' })).health.status, 'unknown');
  assert.equal(synchronize(initial({ lastEvaluation: evaluation({
    successRate: 0, averageMs: null, maxMs: null,
  }) })).health.status, 'hard-failure');
});

test('真实链路失败进入health，但准入拒绝状态和预算阻断不污染health', () => {
  const state = initial({ lastEvaluation: evaluation({ linkFailures: ['websocket'] }),
    lastDecision: { action: 'blocked', reason: 'switch-budget-exhausted' } });
  assert.equal(synchronize(state).health.status, 'partial-failure');
  state.lastEvaluation.linkFailures = [];
  const result = synchronize(state, { health: { status: 'external-selection-rejected', stable: false } });
  assert.equal(result.health.status, 'healthy');
  assert.equal(result.action.type, 'blocked');
  state.lastEvaluation = evaluation({ maxMs: 2600, linkFailures: ['websocket'] });
  assert.equal(synchronize(state).health.status, 'latency-spike');
  assert.equal(synchronize(state).health.quality, 'unacceptable');
});
