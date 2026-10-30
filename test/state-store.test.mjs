import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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

test('保存使用唯一临时文件：并发写入互不踩踏且最终文件合法', async (t) => {
  const { root, stateFile } = await makeStateFile();
  await Promise.all([
    saveState(stateFile, { consecutiveFailures: 1 }),
    saveState(stateFile, { consecutiveFailures: 2 }),
  ]);
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted.stateVersion, STATE_VERSION);
  assert.ok([1, 2].includes(persisted.consecutiveFailures));
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('写失败不留半文件与临时文件，旧状态仍可完整读取', async (t) => {
  const { root, stateFile } = await makeStateFile();
  await saveState(stateFile, { consecutiveFailures: 7, lastSwitchAt: '2026-10-30T00:00:00.000Z' });
  const before = await readFile(stateFile, 'utf8');
  const circular = { consecutiveFailures: 8 };
  circular.self = circular;
  await assert.rejects(saveState(stateFile, circular));
  assert.equal(await readFile(stateFile, 'utf8'), before);
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery, null);
  assert.equal(state.consecutiveFailures, 7);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
});

test('rename 失败（目标被占用）时清理临时文件且目标不被替换', async (t) => {
  const { root, stateFile } = await makeStateFile();
  await mkdir(stateFile); // 目标位置是目录：rename 在 Windows/Linux 上都会失败
  await assert.rejects(saveState(stateFile, { consecutiveFailures: 1 }));
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  assert.ok((await stat(stateFile)).isDirectory(), '失败后目标不应被替换');
});

test('备份文件存在且可解析；版本未变化时不重复覆盖备份', async (t) => {
  const { stateFile } = await makeStateFile();
  const backupFile = `${stateFile}.bak`;
  await saveState(stateFile, { consecutiveFailures: 1 });
  const backup = JSON.parse(await readFile(backupFile, 'utf8'));
  assert.equal(backup.stateVersion, STATE_VERSION);
  // 人为写入标记：若下一次保存仍然覆盖备份，标记就会丢失。
  await writeFile(backupFile, `${JSON.stringify({ stateVersion: STATE_VERSION, marker: 'keep' })}\n`, 'utf8');
  await saveState(stateFile, { consecutiveFailures: 2 });
  assert.equal(JSON.parse(await readFile(backupFile, 'utf8')).marker, 'keep');
  // 版本不一致（备份缺少 stateVersion）时必须重建备份。
  await writeFile(backupFile, '{}\n', 'utf8');
  await saveState(stateFile, { consecutiveFailures: 3 });
  const rebuilt = JSON.parse(await readFile(backupFile, 'utf8'));
  assert.equal(rebuilt.stateVersion, STATE_VERSION);
  assert.equal(rebuilt.consecutiveFailures, 3);
});

test('连续 20 次保存后状态文件仍为合法 JSON 且无临时文件残留', async (t) => {
  const { root, stateFile } = await makeStateFile();
  for (let index = 0; index < 20; index += 1) {
    await saveState(stateFile, { consecutiveFailures: index, lastSwitchAt: null });
  }
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted.consecutiveFailures, 19);
  assert.equal(persisted.stateVersion, STATE_VERSION);
  const { state, recovery } = await loadState(stateFile);
  assert.equal(recovery, null);
  assert.equal(state.consecutiveFailures, 19);
  assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  assert.ok(JSON.parse(await readFile(`${stateFile}.bak`, 'utf8')));
});

test('备份写入失败不阻断状态写入', async (t) => {
  const { stateFile } = await makeStateFile();
  await mkdir(`${stateFile}.bak`); // 备份路径被目录占用，备份写入必然失败
  await saveState(stateFile, { consecutiveFailures: 5 });
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(persisted.consecutiveFailures, 5);
  assert.equal(persisted.stateVersion, STATE_VERSION);
});
