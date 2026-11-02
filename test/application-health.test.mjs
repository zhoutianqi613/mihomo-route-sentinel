import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readApplicationHealth } from '../src/application-health.mjs';

async function fixture(t, content) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-app-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'application-health.json');
  if (content !== undefined) {
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return file;
}

test('应用健康信号默认禁用且不会读取文件', async () => {
  const result = await readApplicationHealth('');
  assert.equal(result.enabled, false);
  assert.equal(result.status, 'disabled');
});

test('新鲜应用健康信号只暴露受控字段', async (t) => {
  const file = await fixture(t, {
    ok: false,
    status: 'degraded',
    checkedAt: '2026-11-02T13:00:00.000Z',
    consecutiveFailures: 2,
    kind: 'codex-websocket',
    error: 'token=secret-value',
  });

  const result = await readApplicationHealth(file, {
    maxAgeSeconds: 120,
    now: Date.parse('2026-11-02T13:01:00.000Z'),
  });

  assert.deepEqual(result, {
    enabled: true,
    fresh: true,
    ok: false,
    status: 'degraded',
    checkedAt: '2026-11-02T13:00:00.000Z',
    consecutiveFailures: 2,
    kind: 'codex-websocket',
  });
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('过期、损坏和缺失信号降级为 unknown 且不伪造失败', async (t) => {
  const expired = await fixture(t, {
    ok: false,
    checkedAt: '2026-11-02T13:00:00.000Z',
    consecutiveFailures: 2,
  });
  const expiredResult = await readApplicationHealth(expired, {
    maxAgeSeconds: 30,
    now: Date.parse('2026-11-02T13:01:00.000Z'),
  });
  assert.equal(expiredResult.status, 'stale');
  assert.equal(expiredResult.ok, false);
  assert.equal(expiredResult.fresh, false);

  const broken = await fixture(t, '{broken');
  assert.equal((await readApplicationHealth(broken)).status, 'invalid');

  const missing = path.join(path.dirname(expired), 'missing.json');
  assert.equal((await readApplicationHealth(missing)).status, 'missing');
});
