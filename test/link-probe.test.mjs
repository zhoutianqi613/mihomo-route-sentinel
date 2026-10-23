import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import test from 'node:test';
import { probeHttpsViaProxy, probeRealLinks, probeWebSocketViaProxy } from '../src/link-probe.mjs';

// Throwaway localhost certificate used only by this in-process test target.
const TEST_PFX = Buffer.from('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', 'base64');

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function startTlsTarget() {
  return tls.createServer({ pfx: TEST_PFX, passphrase: 'test-only' }, (socket) => {
    socket.once('data', (data) => {
      const request = data.toString('latin1');
      if (request.includes('GET /ok ')) {
        socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
      } else if (request.includes('GET /ws-auth ')) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } else {
        const key = /^Sec-WebSocket-Key:\s*(.+)$/im.exec(request)?.[1]?.trim() ?? '';
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      }
    });
  });
}

function startConnectProxy() {
  return net.createServer((client) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const boundary = buffered.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      client.off('data', onData);
      const line = buffered.subarray(0, boundary).toString('latin1').split('\r\n')[0];
      const match = /^CONNECT\s+([^:]+):(\d+)\s+/i.exec(line);
      if (!match) return client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      const upstream = net.connect({ host: '127.0.0.1', port: Number(match[2]) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const remaining = buffered.subarray(boundary + 4);
        if (remaining.length) upstream.write(remaining);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
  });
}

test('real-link probes measure CONNECT, TLS and TTFB and distinguish auth rejection', async (t) => {
  const target = startTlsTarget();
  const targetPort = await listen(target);
  const proxy = startConnectProxy();
  const proxyPort = await listen(proxy);
  t.after(() => target.close());
  t.after(() => proxy.close());
  const common = {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    timeoutMs: 3000,
    tlsOptions: { rejectUnauthorized: false },
  };

  const httpsResult = await probeHttpsViaProxy({ ...common, targetUrl: `https://localhost:${targetPort}/ok` });
  assert.equal(httpsResult.networkOk, true);
  assert.equal(httpsResult.statusCode, 204);
  assert.equal(httpsResult.outcome, 'accepted');
  for (const metric of ['connectMs', 'tunnelMs', 'tlsMs', 'ttfbMs', 'totalMs']) {
    assert.ok(Number.isFinite(httpsResult[metric]), `${metric} should be finite`);
  }

  const websocketResult = await probeWebSocketViaProxy({ ...common, targetUrl: `wss://localhost:${targetPort}/ws-auth` });
  assert.equal(websocketResult.networkOk, true);
  assert.equal(websocketResult.websocketOk, false);
  assert.equal(websocketResult.statusCode, 401);
  assert.equal(websocketResult.outcome, 'authentication-rejected');

  const upgradedResult = await probeWebSocketViaProxy({ ...common, targetUrl: `wss://localhost:${targetPort}/ws` });
  assert.equal(upgradedResult.networkOk, true);
  assert.equal(upgradedResult.websocketOk, true);
  assert.equal(upgradedResult.statusCode, 101);
  assert.equal(upgradedResult.outcome, 'upgraded');
});

test('proxy URL credentials are rejected without exposing them', async () => {
  const result = await probeHttpsViaProxy({
    proxyUrl: 'http://user:password@127.0.0.1:7890',
    targetUrl: 'https://example.test/',
    timeoutMs: 100,
  });
  assert.equal(result.networkOk, false);
  assert.match(result.error, /不允许包含凭据/);
  assert.doesNotMatch(JSON.stringify(result), /user|password/);
});

test('one telemetry probe rejection is isolated from the other probe', async () => {
  const result = await probeRealLinks({
    enabled: true,
    proxyUrl: 'http://127.0.0.1:7897',
    httpsUrl: 'https://example.test/',
    websocketUrl: 'wss://example.test/ws',
    timeoutMs: 100,
  }, {
    httpsProbe: async () => { throw new Error('sensitive internal detail'); },
    websocketProbe: async () => ({
      kind: 'websocket',
      networkOk: true,
      websocketOk: false,
      outcome: 'authentication-rejected',
      statusCode: 401,
    }),
  });

  assert.equal(result.https.networkOk, false);
  assert.equal(result.https.outcome, 'probe-error');
  assert.doesNotMatch(JSON.stringify(result.https), /sensitive internal detail/);
  assert.equal(result.websocket.networkOk, true);
  assert.equal(result.websocket.statusCode, 401);
});
