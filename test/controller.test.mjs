import assert from 'node:assert/strict';
import test from 'node:test';
import { MihomoController } from '../src/controller.mjs';

test('controller exposes runtime config read and patch operations', async () => {
  const controller = Object.create(MihomoController.prototype);
  const requests = [];
  controller.request = async (method, requestPath, body) => {
    requests.push({ method, requestPath, body });
    return { status: method === 'GET' ? 200 : 204, data: method === 'GET' ? { mode: 'direct' } : null };
  };

  assert.deepEqual(await controller.getConfigs(), { mode: 'direct' });
  await controller.patchConfigs({ mode: 'rule' });
  assert.deepEqual(requests, [
    { method: 'GET', requestPath: '/configs', body: undefined },
    { method: 'PATCH', requestPath: '/configs', body: { mode: 'rule' } },
  ]);
});

test('temporary pipe disappearance does not permanently fall back to HTTP', async () => {
  const controller = Object.create(MihomoController.prototype);
  controller.config = { transport: 'auto', pipePath: '', pipePattern: 'verge-mihomo' };
  controller.transport = { kind: 'pipe', pipePath: '\\\\.\\pipe\\old' };
  let available = false;
  controller.rediscoverPipeTransport = () => (
    available ? { kind: 'pipe', pipePath: '\\\\.\\pipe\\new' } : null
  );
  controller.requestOnce = async () => {
    if (controller.transport.pipePath === '\\\\.\\pipe\\new') return { status: 200, data: { mode: 'rule' } };
    const error = new Error('pipe missing');
    error.code = 'ENOENT';
    throw error;
  };

  await assert.rejects(controller.request('GET', '/configs'), { code: 'ENOENT' });
  assert.equal(controller.transport.kind, 'pipe');
  assert.equal(controller.transport.pipePath, '\\\\.\\pipe\\old');

  available = true;
  const response = await controller.request('GET', '/configs');
  assert.equal(response.data.mode, 'rule');
  assert.equal(controller.transport.pipePath, '\\\\.\\pipe\\new');
});

test('auto transport recovers when pipe appears after startup HTTP fallback', async () => {
  const controller = Object.create(MihomoController.prototype);
  controller.config = { transport: 'auto', pipePath: '', pipePattern: 'verge-mihomo' };
  controller.transport = { kind: 'http', url: new URL('http://127.0.0.1:9090') };
  let available = false;
  controller.rediscoverPipeTransport = () => (
    available ? { kind: 'pipe', pipePath: '\\\\.\\pipe\\late' } : null
  );
  controller.requestOnce = async () => {
    if (controller.transport.kind === 'pipe') return { status: 200, data: { mode: 'rule' } };
    const error = new Error('http fallback unavailable');
    error.code = 'ECONNREFUSED';
    throw error;
  };

  await assert.rejects(controller.request('GET', '/configs'), { code: 'ECONNREFUSED' });
  assert.equal(controller.transport.kind, 'http');
  available = true;
  const response = await controller.request('GET', '/configs');
  assert.equal(response.data.mode, 'rule');
  assert.equal(controller.transport.pipePath, '\\\\.\\pipe\\late');
});

test('request timeout can rediscover a restarted auto pipe', async () => {
  const controller = Object.create(MihomoController.prototype);
  controller.config = { transport: 'auto', pipePath: '', pipePattern: 'verge-mihomo' };
  controller.transport = { kind: 'pipe', pipePath: '\\\\.\\pipe\\stale' };
  controller.rediscoverPipeTransport = () => ({ kind: 'pipe', pipePath: '\\\\.\\pipe\\fresh' });
  controller.requestOnce = async () => {
    if (controller.transport.pipePath === '\\\\.\\pipe\\fresh') {
      return { status: 200, data: { mode: 'rule' } };
    }
    const error = new Error('request timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  const response = await controller.request('GET', '/configs');
  assert.equal(response.data.mode, 'rule');
  assert.equal(controller.transport.pipePath, '\\\\.\\pipe\\fresh');
});
