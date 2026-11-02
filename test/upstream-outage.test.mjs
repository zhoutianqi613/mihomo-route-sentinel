import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaults } from '../src/config.mjs';
import { Watchdog, summarizeSamples } from '../src/watchdog.mjs';

const urls = ['https://business-a.example/', 'https://business-b.example/'];
const controlUrl = 'https://control.example/';

function failed(node, error = 'HTTP_504') {
  return summarizeSamples(node, urls.map(url => ({ round: 1, url, ok: false, error })));
}

function healthy(node) {
  return summarizeSamples(node, [1, 2].flatMap(round =>
    urls.map(url => ({ round, url, ok: true, delay: 300 }))));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-upstream-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sentinel-upstream-'));
    return rm(root, { recursive: true, force: true });
  });
  const config = structuredClone(defaults);
  config.groups = { target: 'target', candidates: 'candidates' };
  Object.assign(config.probes, { urls, controlUrls: [controlUrl], timeoutMs: 100,
    discoveryTimeoutMs: 100, scanDeadlineMs: 500, scanRounds: 1, scanUrlCount: 2 });
  Object.assign(config.policy, { hardFailureConfirmSeconds: 0,
    postSwitchDelaySeconds: 0, minimumDwellSeconds: 0 });
  config.files = { state: path.join(root, 'state.json'), log: path.join(root, 'unused.ndjson'),
    lock: path.join(root, 'unused.lock') };
  const switches = [];
  const events = [];
  let selected = 'current';
  let controlCalls = 0;
  const controller = {
    async getProxy(node) {
      if (node === 'target') return { type: 'Selector', now: selected,
        all: ['current', 'good', 'bad-a', 'bad-b', 'bad-c'] };
      if (node === 'candidates') return { type: 'URLTest',
        all: ['current', 'good', 'bad-a', 'bad-b', 'bad-c'] };
      return { type: 'Shadowsocks' };
    },
    async getDelay(node, url) {
      if (url === controlUrl) { controlCalls += 1; return 50; }
      if (node === 'good') return 300;
      throw Object.assign(new Error('模拟业务目标失败'), { status: 504 });
    },
    async select(group, node) { selected = node; switches.push(node); },
  };
  const watchdog = new Watchdog({ controller, config,
    logger: async (level, event, details) => events.push({ event, ...details }) });
  return { watchdog, config, switches, events, controlCalls: () => controlCalls };
}

test('三个坏候选不能屏蔽同轮完整合格候选的真实恢复', async (t) => {
  const f = await fixture(t);
  const outcome = await f.watchdog.runOnce({ dryRun: false });
  assert.equal(outcome.status, 'switched');
  assert.deepEqual(f.switches, ['good']);
  assert.equal(f.controlCalls(), 0);
  assert.equal(f.events.some(r => r.event === 'upstream-outage-detected'), false);
});

test('初筛失败但后续验证已响应时不能判定共同上游故障', async (t) => {
  const f = await fixture(t);
  const outcome = await f.watchdog.detectUpstreamOutage('current', failed('current'),
    ['bad-a', 'bad-b', 'good'].map(node => failed(node)), [healthy('good')]);
  assert.equal(outcome, null);
  assert.equal(f.controlCalls(), 0);
});

for (const error of ['SCAN_DEADLINE', 'PROBE_CANCELLED', 'ABORT_ERR']) {
  test(`${error} 缺样本不能触发共同上游故障退避`, async (t) => {
    const f = await fixture(t);
    const candidates = ['a', 'b', 'c'].map(node => failed(node));
    candidates.push(failed('incomplete', error));
    assert.equal(await f.watchdog.detectUpstreamOutage('current', failed('current'), candidates), null);
    assert.equal(f.controlCalls(), 0);
  });
}

test('旧快照没有逐目标失败证据时不能推断共同上游故障', async (t) => {
  const f = await fixture(t);
  const cached = ['a', 'b', 'c'].map(node => ({ node, attempts: 2, successes: 0,
    successRate: 0, samples: [] }));
  assert.equal(await f.watchdog.detectUpstreamOutage('current', failed('current'), cached), null);
});

test('当前出口证据被截止取消时不能推断共同上游故障', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.watchdog.detectUpstreamOutage('current', failed('current', 'SCAN_DEADLINE'),
    ['a', 'b', 'c'].map(node => failed(node))), null);
});

test('重复节点不能重复计入共同失败的最小候选数', async (t) => {
  const f = await fixture(t);
  const oneNode = failed('a');
  assert.equal(await f.watchdog.detectUpstreamOutage('current', failed('current'),
    [oneNode, oneNode, oneNode]), null);
});

test('全部候选完整受测且共同失败、对照正常时仍识别疑似上游故障', async (t) => {
  const f = await fixture(t);
  const outcome = await f.watchdog.detectUpstreamOutage('current', failed('current'),
    ['a', 'b', 'c'].map(node => failed(node)));
  assert.equal(outcome.failedCandidateCount, 3);
  assert.equal(outcome.control.successRate, 1);
  assert.equal(f.controlCalls(), 1);
});
