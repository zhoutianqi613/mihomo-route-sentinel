import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enforceRuntimeMode,
  normalizeExpectedRuntimeMode,
  runtimeModeIsExpected,
} from '../src/runtime-mode.mjs';

class RecordingController {
  constructor({ mode = 'rule', patchFails = false, verifyStaysWrong = false, getFails = false } = {}) {
    this.mode = mode;
    this.patchFails = patchFails;
    this.verifyStaysWrong = verifyStaysWrong;
    this.getFails = getFails;
    this.calls = [];
  }

  async getConfigs() {
    this.calls.push('getConfigs');
    if (this.getFails) throw new Error('controller unavailable');
    return { mode: this.mode };
  }

  async patchConfigs(patch) {
    this.calls.push(`patchConfigs:${patch.mode}`);
    if (this.patchFails) throw new Error('patch failed');
    if (!this.verifyStaysWrong) this.mode = patch.mode;
  }
}

test('已符合期望模式时返回 ok 且不修补', async () => {
  const controller = new RecordingController({ mode: 'rule' });
  const result = await enforceRuntimeMode({ controller, expectedMode: 'rule' });

  assert.equal(result.status, 'ok');
  assert.equal(result.ready, true);
  assert.deepEqual(controller.calls, ['getConfigs']);
});

test('不符合且 dry-run / 关闭自动修复时返回 would-repair 且不修补', async () => {
  const dry = new RecordingController({ mode: 'direct' });
  const dryResult = await enforceRuntimeMode({ controller: dry, expectedMode: 'rule', dryRun: true });
  assert.equal(dryResult.status, 'would-repair');
  assert.equal(dryResult.ready, false);
  assert.deepEqual(dryResult.unresolved, ['runtime-mode']);
  assert.deepEqual(dry.calls, ['getConfigs']);

  const disabled = new RecordingController({ mode: 'direct' });
  await enforceRuntimeMode({ controller: disabled, expectedMode: 'rule', autoRepair: false });
  assert.deepEqual(disabled.calls, ['getConfigs']);
});

test('修补后复核通过时返回 repaired，并走 patch+verify 顺序', async () => {
  const controller = new RecordingController({ mode: 'direct' });
  const result = await enforceRuntimeMode({ controller, expectedMode: 'rule', dryRun: false });

  assert.equal(result.status, 'repaired');
  assert.equal(result.ready, true);
  assert.deepEqual(controller.calls, ['getConfigs', 'patchConfigs:rule', 'getConfigs']);
  assert.equal(controller.mode, 'rule');
});

test('修补后复核仍不符时返回 blocked', async () => {
  const controller = new RecordingController({ mode: 'direct', verifyStaysWrong: true });
  const result = await enforceRuntimeMode({ controller, expectedMode: 'rule', dryRun: false });

  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.unresolved, ['controller-unreachable']);
});

test('Controller 不可达或修补抛错时 fail-closed 返回 blocked', async () => {
  const unreachable = new RecordingController({ getFails: true });
  const getResult = await enforceRuntimeMode({ controller: unreachable, expectedMode: 'rule', dryRun: false });
  assert.equal(getResult.status, 'blocked');

  const patchFails = new RecordingController({ mode: 'direct', patchFails: true });
  const patchResult = await enforceRuntimeMode({ controller: patchFails, expectedMode: 'rule', dryRun: false });
  assert.equal(patchResult.status, 'blocked');
});

test('normalizeExpectedRuntimeMode 只接受 rule / global', () => {
  assert.equal(normalizeExpectedRuntimeMode('rule'), 'rule');
  assert.equal(normalizeExpectedRuntimeMode('global'), 'global');
  assert.throws(() => normalizeExpectedRuntimeMode('direct'), /不允许 direct/);
  assert.throws(() => normalizeExpectedRuntimeMode(undefined), /rule 或 global/);
});

test('runtimeModeIsExpected 按实际 mode 比较', async () => {
  assert.equal(await runtimeModeIsExpected({ getConfigs: async () => ({ mode: 'rule' }) }, 'rule'), true);
  assert.equal(await runtimeModeIsExpected({ getConfigs: async () => ({ mode: 'global' }) }, 'rule'), false);
  assert.equal(await runtimeModeIsExpected({ getConfigs: async () => null }, 'rule'), false);
});
