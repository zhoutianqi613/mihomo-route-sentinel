import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { MAX_RESPONSE_BYTES, MihomoController, normalizeProxy } from '../src/controller.mjs';

async function startServer(t, handler) {
  const server = http.createServer((request, response) => {
    response.on('error', () => {});
    request.on('error', () => {});
    handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function createController(url) {
  return new MihomoController({
    transport: 'http',
    url,
    pipePath: '',
    pipePattern: '',
    secretEnv: '',
    requestTimeoutMs: 2000,
  });
}

function jsonResponse(response, payload, status = 200) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  response.end(body);
}

async function rejectsWithProtocol(promise, { name, field }) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'CONTROLLER_PROTOCOL');
    assert.match(error.message, new RegExp(String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(error.message, new RegExp(field));
    assert.equal(error.field, field);
    return true;
  });
}

test('normal proxy and group responses pass normalized validation unchanged', async (t) => {
  const url = await startServer(t, (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/proxies/leaf') return jsonResponse(response, { name: 'leaf', type: 'Shadowsocks' });
    if (pathname === '/proxies/group') {
      return jsonResponse(response, { name: 'group', type: 'Selector', now: 'leaf', all: ['leaf', 'other'] });
    }
    if (pathname === '/configs') return jsonResponse(response, { mode: 'rule', port: 7890 });
    response.writeHead(404);
    return response.end();
  });
  const controller = createController(url);

  assert.deepEqual(await controller.getProxy('leaf'), { name: 'leaf', type: 'Shadowsocks' });
  assert.deepEqual(
    await controller.getProxy('group'),
    { name: 'group', type: 'Selector', now: 'leaf', all: ['leaf', 'other'] },
  );
  assert.deepEqual(await controller.getConfigs(), { mode: 'rule', port: 7890 });
  assert.equal(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
});

test('null proxy payload is rejected with CONTROLLER_PROTOCOL', async (t) => {
  const url = await startServer(t, (request, response) => jsonResponse(response, null));
  const controller = createController(url);

  await rejectsWithProtocol(controller.getProxy('null-node'), { name: 'null-node', field: 'proxy' });
});

test('array proxy payload is rejected with CONTROLLER_PROTOCOL', async (t) => {
  const url = await startServer(t, (request, response) => jsonResponse(response, []));
  const controller = createController(url);

  await rejectsWithProtocol(controller.getProxy('array-node'), { name: 'array-node', field: 'proxy' });
});

test('non-string proxy now is rejected before callers dereference it', async (t) => {
  const url = await startServer(t, (request, response) => (
    jsonResponse(response, { name: 'now-node', type: 'Selector', now: 123 })
  ));
  const controller = createController(url);

  await rejectsWithProtocol(controller.getProxy('now-node'), { name: 'now-node', field: 'now' });
});

test('non-array proxy all is rejected before includes is called', async (t) => {
  const url = await startServer(t, (request, response) => (
    jsonResponse(response, { name: 'all-node', type: 'Selector', now: 'leaf', all: 'x' })
  ));
  const controller = createController(url);

  await rejectsWithProtocol(controller.getProxy('all-node'), { name: 'all-node', field: 'all' });
});

test('all entries must be strings', async (t) => {
  const url = await startServer(t, (request, response) => (
    jsonResponse(response, { name: 'mixed-node', type: 'Selector', now: 'leaf', all: ['leaf', 7] })
  ));
  const controller = createController(url);

  await rejectsWithProtocol(controller.getProxy('mixed-node'), { name: 'mixed-node', field: 'all' });
});

test('non-JSON body stays bounded and becomes a protocol error instead of a crash', async (t) => {
  const body = `<html>${'x'.repeat(2000)}</html>`;
  const url = await startServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(body);
  });
  const controller = createController(url);

  const raw = await controller.requestOnce('GET', '/proxies/html-node');
  assert.equal(raw.status, 200);
  assert.equal(raw.data.message.length, 500);
  await rejectsWithProtocol(controller.getProxy('html-node'), { name: 'html-node', field: 'type' });
});

test('declared Content-Length above the limit is rejected before the body is read', async (t) => {
  const url = await startServer(t, (request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': String(1024 * 1024),
    });
    response.end('{}');
  });
  const controller = createController(url);
  controller.maxResponseBytes = 128;

  await assert.rejects(controller.requestOnce('GET', '/configs'), (error) => {
    assert.equal(error.code, 'CONTROLLER_RESPONSE_TOO_LARGE');
    assert.equal(error.limitBytes, 128);
    return true;
  });
});

test('streamed body above the limit is destroyed and rejected as CONTROLLER_RESPONSE_TOO_LARGE', async (t) => {
  const url = await startServer(t, (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const chunk = 'y'.repeat(64);
    for (let index = 0; index < 16; index += 1) response.write(chunk);
    response.end();
  });
  const controller = createController(url);
  controller.maxResponseBytes = 128;

  await assert.rejects(controller.requestOnce('GET', '/proxies/streamed'), (error) => {
    assert.equal(error.code, 'CONTROLLER_RESPONSE_TOO_LARGE');
    assert.equal(error.limitBytes, 128);
    assert.ok(error.observedBytes > 128);
    return true;
  });
});

test('body below a custom limit still parses normally', async (t) => {
  const url = await startServer(t, (request, response) => jsonResponse(response, { mode: 'rule' }));
  const controller = createController(url);
  controller.maxResponseBytes = 1024;

  assert.deepEqual(await controller.getConfigs(), { mode: 'rule' });
});

test('non-object configs and non-string mode are rejected as CONTROLLER_PROTOCOL', async (t) => {
  let payload = [];
  const url = await startServer(t, (request, response) => jsonResponse(response, payload));
  const controller = createController(url);

  await rejectsWithProtocol(controller.getConfigs(), { name: 'configs', field: 'response' });
  payload = { mode: 42 };
  await rejectsWithProtocol(controller.getConfigs(), { name: 'configs', field: 'mode' });
});

test('normalizeProxy rejects payloads directly and accepts optional fields', () => {
  assert.throws(() => normalizeProxy('direct', null), (error) => (
    error.code === 'CONTROLLER_PROTOCOL' && error.field === 'proxy'
  ));
  assert.throws(() => normalizeProxy('direct', { type: 'Selector', now: false }), (error) => (
    error.code === 'CONTROLLER_PROTOCOL' && error.field === 'now'
  ));
  const proxy = { name: 'leaf', type: 'Shadowsocks' };
  assert.equal(normalizeProxy('leaf', proxy), proxy);
  const group = { name: 'group', type: 'URLTest', now: 'leaf', all: [] };
  assert.equal(normalizeProxy('group', group), group);
});

test('non-2xx responses still reject with HTTP status unchanged', async (t) => {
  const url = await startServer(t, (request, response) => {
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end('{"message":"unavailable"}');
  });
  const controller = createController(url);

  await assert.rejects(controller.getConfigs(), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, undefined);
    return true;
  });
});
