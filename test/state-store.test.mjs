import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { STATE_VERSION, createDefaultState, inspectState, loadState, saveState } from '../src/state-store.mjs';

async function makeStateFile() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-state-'));
  const stateFile = path.join(root, 'state.json');
  return { root, stateFile };
}

async function corruptFiles(root) {
  return (await readdir(root)).filter((name) => name.includes('.corrupt.'));
}

test('缺失状态文件时返回默认骨架且不生成隔离副本', async (t) => {
  const { root, stateFile } = await makeStateFile();
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery, null);
  assert.deepEqual(state, { consecutiveFailures: 0, lastSwitchAt: null, stateVersion: STATE_VERSION });
  assert.deepEqual(await corruptFiles(root), []);
});

test('空状态文件被判定为损坏：返回默认骨架并把原文件改名保留', async (t) => {
  const { root, stateFile } = await makeStateFile();
  await writeFile(stateFile, '', 'utf8');
  const { state, recovery } = await loadState(stateFile);
  assert.deepEqual(state, createDefaultState());
  assert.equal(recovery.reason, 'invalid-json');
  assert.ok(recovery.quarantinedTo, '损坏文件必须被改名保留');
  assert.deepEqual(await corruptFiles(root), [path.basename(recovery.quarantinedTo)]);
  assert.equal(await readFile(recovery.quarantinedTo, 'utf8'), '');
  await assert.rejects(readFile(stateFile, 'utf8'), { code: 'ENOENT' });
});

test('截断的 JSON 走同一自愈路径，不向调用方抛错', async (t) => {
  const { root, stateFile } = await makeStateFile();
  const truncated = '{"consecutiveFailures":2,"switchHistory":[{"at":"2026-10-30T00:00:00.000Z"';
  await writeFile(stateFile, truncated, 'utf8');
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery.reason, 'invalid-json');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(await readFile(recovery.quarantinedTo, 'utf8'), truncated);
  assert.equal((await corruptFiles(root)).length, 1);
});

test('switchHistory 不是数组时判定损坏，而不是留到运行时抛 TypeError', async (t) => {
  const { stateFile } = await makeStateFile();
  await writeFile(stateFile, JSON.stringify({ switchHistory: {}, consecutiveFailures: 1 }), 'utf8');
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery.reason, 'invalid-switchHistory');
  assert.equal(state.switchHistory, undefined);
});

test('quarantinedNodes 为数组时判定损坏', async (t) => {
  const { stateFile } = await makeStateFile();
  await writeFile(stateFile, JSON.stringify({ quarantinedNodes: [] }), 'utf8');
  const { recovery } = await loadState(stateFile);
  assert.equal(recovery.reason, 'invalid-quarantinedNodes');
});

test('degradationWindow 不是数组时判定损坏', async (t) => {
  const { stateFile } = await makeStateFile();
  await writeFile(stateFile, JSON.stringify({ degradationWindow: { cycles: 3 } }), 'utf8');
  const { recovery } = await loadState(stateFile);
  assert.equal(recovery.reason, 'invalid-degradationWindow');
});

test('consecutiveFailures 不是数字时判定损坏', async (t) => {
  const { stateFile } = await makeStateFile();
  await writeFile(stateFile, JSON.stringify({ consecutiveFailures: '3' }), 'utf8');
  const { recovery } = await loadState(stateFile);
  assert.equal(recovery.reason, 'invalid-consecutiveFailures');
});

test('顶层不是对象时判定损坏', async (t) => {
  const { stateFile } = await makeStateFile();
  await writeFile(stateFile, JSON.stringify(['switchHistory']), 'utf8');
  const { recovery } = await loadState(stateFile);
  assert.equal(recovery.reason, 'not-an-object');
});

test('stateVersion 高于当前版本时 fail-closed：抛 STATE_VERSION_UNSUPPORTED 且不改名不覆盖', async (t) => {
  const { root, stateFile } = await makeStateFile();
  const original = `${JSON.stringify({ stateVersion: 99, switchHistory: [] }, null, 2)}\n`;
  await writeFile(stateFile, original, 'utf8');
  await assert.rejects(loadState(stateFile), (error) => {
    assert.equal(error.code, 'STATE_VERSION_UNSUPPORTED');
    assert.equal(error.stateVersion, 99);
    assert.equal(error.supportedStateVersion, STATE_VERSION);
    return true;
  });
  assert.deepEqual(await corruptFiles(root), []);
  assert.equal(await readFile(stateFile, 'utf8'), original);
});

test('损坏自愈后可以继续写入，且写回的数据能重新读回', async (t) => {
  const { root, stateFile } = await makeStateFile();
  await writeFile(stateFile, '{"switchHistory":', 'utf8');
  const first = await loadState(stateFile);
  assert.equal(first.recovery.reason, 'invalid-json');
  await saveState(stateFile, { ...first.state, consecutiveFailures: 4, lastSwitchAt: '2026-10-30T01:00:00.000Z' });
  const second = await loadState(stateFile);
  assert.equal(second.recovery, null);
  assert.equal(second.state.consecutiveFailures, 4);
  assert.equal(second.state.lastSwitchAt, '2026-10-30T01:00:00.000Z');
  assert.equal(second.state.stateVersion, STATE_VERSION);
  assert.equal((await corruptFiles(root)).length, 1, '只保留一份损坏副本');
});

test('合法状态原样返回且不改名', async (t) => {
  const { root, stateFile } = await makeStateFile();
  const stored = {
    stateVersion: 1,
    consecutiveFailures: 2,
    lastSwitchAt: '2026-10-30T00:00:00.000Z',
    switchHistory: [{ at: '2026-10-30T00:00:00.000Z', reason: 'optimization' }],
    quarantinedNodes: { 'node-a': { until: '2026-10-30T00:15:00.000Z', reason: 'probe-failed' } },
    degradationWindow: [{ at: '2026-10-30T00:00:00.000Z', degraded: true }],
    customField: '保留未知字段',
  };
  await writeFile(stateFile, JSON.stringify(stored, null, 2), 'utf8');
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery, null);
  assert.deepEqual(state, stored);
  assert.deepEqual(await corruptFiles(root), []);
});

test('未声明 stateVersion 的旧版状态仍可读取，写入时补齐版本', async (t) => {
  const { stateFile } = await makeStateFile();
  await writeFile(stateFile, JSON.stringify({ consecutiveFailures: 1, switchHistory: [] }), 'utf8');
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery, null);
  assert.equal(state.stateVersion, undefined);
  await saveState(stateFile, state);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted.stateVersion, STATE_VERSION);
  assert.equal(persisted.consecutiveFailures, 1);
});

test('inspectState 对缺失关键字段的骨架返回合法', () => {
  assert.equal(inspectState({}).ok, true);
  assert.equal(inspectState({ stateVersion: 1 }).ok, true);
  assert.equal(inspectState({ consecutiveFailures: 0, switchHistory: [], quarantinedNodes: {} }).ok, true);
  assert.equal(inspectState(null).reason, 'not-an-object');
  assert.equal(inspectState({ stateVersion: 1.5 }).reason, 'invalid-state-version');
});
