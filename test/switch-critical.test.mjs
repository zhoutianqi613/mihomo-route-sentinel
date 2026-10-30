import assert from 'node:assert/strict';
import test from 'node:test';

import { Watchdog } from '../src/watchdog.mjs';

function makeWatchdog({ beforeSwitch, select, guardTimeoutMs } = {}) {
  const events = [];
  const state = { switchInProgress: false };
  const controller = {
    async select(group, name) {
      events.push(`select:${group}:${name}`);
      if (select) await select({ group, name });
    },
  };
  const watchdog = new Watchdog({
    controller,
    config: { groups: { target: 'XFLTD' } },
    logger: async () => {},
    beforeSwitch: async () => {
      events.push('beforeSwitch');
      if (beforeSwitch) await beforeSwitch();
    },
    onSwitchStart: () => {
      state.switchInProgress = true;
      events.push('start');
    },
    onSwitchEnd: () => {
      state.switchInProgress = false;
      events.push('end');
    },
    ...(guardTimeoutMs === undefined ? {} : { guardTimeoutMs }),
  });
  return { watchdog, events, state };
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

test('守卫永不返回时切换尝试超时、不 select、不执行 beforeSelect 并结束临界区', async () => {
  const { watchdog, events } = makeWatchdog({
    beforeSwitch: () => new Promise(() => {}),
    guardTimeoutMs: 60,
  });
  const startedAt = Date.now();
  const result = await watchdog.runSwitchAttempt(() => watchdog.guardedSelect('XFLTD', 'node-a', {
    // 超时分支不得执行预算等 beforeSelect 副作用。
    beforeSelect: async () => {
      events.push('beforeSelect');
      return {};
    },
  }));
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'guardrail-timeout');
  assert.equal(result.timeoutMs, 60);
  assert.deepEqual(events, ['start', 'beforeSwitch', 'end']);
  assert.equal(watchdog.switchAttemptDepth, 0);
  assert.ok(Date.now() - startedAt >= 50);
});

test('正常切换尝试按 start→beforeSwitch→select→切后探针→end 顺序执行', async () => {
  const { watchdog, events } = makeWatchdog();
  await watchdog.runSwitchAttempt(async () => {
    await watchdog.guardedSelect('XFLTD', 'node-b');
    events.push('postSwitchProbe');
  });
  assert.deepEqual(
    events,
    ['start', 'beforeSwitch', 'select:XFLTD:node-b', 'postSwitchProbe', 'end'],
  );
  assert.equal(watchdog.switchAttemptDepth, 0);
});

test('select 完成后切后 probe 挂起期间 onSwitchEnd 未触发且定时守卫被跳过', async () => {
  const { watchdog, events, state } = makeWatchdog();
  let releaseProbe;
  const probe = new Promise((resolve) => { releaseProbe = resolve; });
  const attempt = watchdog.runSwitchAttempt(async () => {
    await watchdog.guardedSelect('XFLTD', 'node-c');
    await probe;
    events.push('probeEnd');
  });
  // 等待 select 完成、切后 probe 已经挂起。
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'select:XFLTD:node-c']);
  assert.equal(state.switchInProgress, true);
  // 与 cli 5s 定时守卫等价的判定：临界区内的本轮被跳过。
  const guardTick = () => {
    if (state.switchInProgress) {
      events.push('guard:skip');
      return 'skip';
    }
    events.push('guard:run');
    return 'run';
  };
  assert.equal(guardTick(), 'skip');
  releaseProbe();
  await attempt;
  assert.deepEqual(
    events,
    ['start', 'beforeSwitch', 'select:XFLTD:node-c', 'guard:skip', 'probeEnd', 'end'],
  );
  assert.equal(state.switchInProgress, false);
  assert.equal(guardTick(), 'run');
});

test('select 抛错仍由外层尝试 finally 触发 onSwitchEnd', async () => {
  const { watchdog, events } = makeWatchdog({
    select: async () => {
      throw Object.assign(new Error('select failed'), { code: 'SELECT_FAILED' });
    },
  });
  await assert.rejects(watchdog.runSwitchAttempt(() => (
    watchdog.guardedSelect('XFLTD', 'node-d')
  )), (error) => {
    assert.equal(error.code, 'SELECT_FAILED');
    return true;
  });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'select:XFLTD:node-d', 'end']);
});

test('切后验证异常仍结束临界区且深度归零', async () => {
  const { watchdog, events } = makeWatchdog();
  await assert.rejects(watchdog.runSwitchAttempt(async () => {
    await watchdog.guardedSelect('XFLTD', 'node-e');
    throw Object.assign(new Error('probe failed'), { code: 'PROBE_FAILED' });
  }), (error) => {
    assert.equal(error.code, 'PROBE_FAILED');
    return true;
  });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'select:XFLTD:node-e', 'end']);
  assert.equal(watchdog.switchAttemptDepth, 0);
});

test('guardedSelect 的实际超时取 guardTimeoutMs 与传入值较小者', async () => {
  const slowGuard = () => delay(150);

  const first = makeWatchdog({ beforeSwitch: slowGuard, guardTimeoutMs: 3000 });
  const startedAt = Date.now();
  const overridden = await first.watchdog.runSwitchAttempt(() => (
    first.watchdog.guardedSelect('XFLTD', 'node-f', { timeoutMs: 40 })
  ));
  assert.equal(overridden.blocked, true);
  assert.equal(overridden.timeoutMs, 40);
  assert.ok(Date.now() - startedAt < 1000);
  assert.deepEqual(first.events, ['start', 'beforeSwitch', 'end']);

  const second = makeWatchdog({ beforeSwitch: slowGuard, guardTimeoutMs: 40 });
  const capped = await second.watchdog.runSwitchAttempt(() => (
    second.watchdog.guardedSelect('XFLTD', 'node-g', { timeoutMs: 5000 })
  ));
  assert.equal(capped.blocked, true);
  assert.equal(capped.timeoutMs, 40);
  assert.deepEqual(second.events, ['start', 'beforeSwitch', 'end']);
});

test('常规 beforeSwitch 未超时不被误杀且默认守卫超时为 3000ms', async () => {
  const { watchdog, events } = makeWatchdog({ beforeSwitch: () => delay(30) });
  assert.equal(watchdog.guardTimeoutMs, 3000);
  const result = await watchdog.runSwitchAttempt(() => (
    watchdog.guardedSelect('XFLTD', 'node-h')
  ));
  assert.deepEqual(result, { blocked: false });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'select:XFLTD:node-h', 'end']);
});

test('守卫失败时抛出原错误、不调用 select，并结束临界区', async () => {
  const { watchdog, events } = makeWatchdog({
    beforeSwitch: async () => {
      throw Object.assign(new Error('guardrail blocked'), { code: 'GUARDRAIL_BLOCKED' });
    },
  });
  await assert.rejects(watchdog.runSwitchAttempt(() => (
    watchdog.guardedSelect('XFLTD', 'node-i')
  )), (error) => {
    assert.equal(error.code, 'GUARDRAIL_BLOCKED');
    return true;
  });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'end']);
});

test('beforeSelect 拒绝时跳过 select 且仍结束临界区', async () => {
  const { watchdog, events } = makeWatchdog();
  const result = await watchdog.runSwitchAttempt(() => watchdog.guardedSelect('XFLTD', 'node-j', {
    beforeSelect: async () => {
      events.push('beforeSelect');
      return { blocked: true, reason: 'switch-budget-exhausted' };
    },
  }));
  assert.deepEqual(result, { blocked: true, reason: 'switch-budget-exhausted' });
  assert.deepEqual(events, ['start', 'beforeSwitch', 'beforeSelect', 'end']);
});

test('beforeSelect 在守卫通过后、select 前执行并可返回选路元数据', async () => {
  const { watchdog, events } = makeWatchdog();
  const result = await watchdog.runSwitchAttempt(() => watchdog.guardedSelect('XFLTD', 'node-k', {
    beforeSelect: async () => {
      events.push('beforeSelect');
      return { restoreBudget: { budgetClass: 'recovery' } };
    },
  }));
  assert.equal(result.blocked, false);
  assert.deepEqual(result.restoreBudget, { budgetClass: 'recovery' });
  assert.deepEqual(
    events,
    ['start', 'beforeSwitch', 'beforeSelect', 'select:XFLTD:node-k', 'end'],
  );
});

test('嵌套切换尝试深度计数只在最外层触发回调', async () => {
  const { watchdog, events } = makeWatchdog();
  await watchdog.runSwitchAttempt(async () => {
    events.push('outer');
    assert.equal(watchdog.switchAttemptDepth, 1);
    await watchdog.runSwitchAttempt(async () => {
      events.push('inner');
      assert.equal(watchdog.switchAttemptDepth, 2);
    });
    assert.equal(watchdog.switchAttemptDepth, 1);
  });
  assert.equal(watchdog.switchAttemptDepth, 0);
  assert.deepEqual(events, ['start', 'outer', 'inner', 'end']);
});

test('并发切换尝试共享同一临界区且只触发一次起止回调', async () => {
  const { watchdog, events } = makeWatchdog();
  const first = watchdog.runSwitchAttempt(async () => { events.push('a'); });
  const second = watchdog.runSwitchAttempt(async () => { events.push('b'); });
  assert.equal(watchdog.switchAttemptDepth, 2);
  await Promise.all([first, second]);
  assert.equal(watchdog.switchAttemptDepth, 0);
  assert.equal(events.filter((event) => event === 'start').length, 1);
  assert.equal(events.filter((event) => event === 'end').length, 1);
  assert.deepEqual(events.filter((event) => event === 'start' || event === 'end'), ['start', 'end']);
});
