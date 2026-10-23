import net from 'node:net';
import tls from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MAX_HEADER_BYTES = 32 * 1024;

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function validateProxyUrl(proxyUrl) {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol !== 'http:') throw new Error('telemetry.proxyUrl 当前仅支持 http:// 本地代理');
  if (parsed.username || parsed.password) throw new Error('telemetry.proxyUrl 不允许包含凭据');
  return parsed;
}

function validateTargetUrl(targetUrl, protocols) {
  const parsed = new URL(targetUrl);
  if (!protocols.includes(parsed.protocol)) throw new Error(`目标 URL 仅支持 ${protocols.join('、')}`);
  if (parsed.username || parsed.password) throw new Error('探测目标 URL 不允许包含凭据');
  return parsed;
}

function waitForSocketEvent(socket, successEvent, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(successEvent, onSuccess);
      socket.off('error', onError);
    };
    const onSuccess = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, Math.max(1, timeoutMs));
    socket.once(successEvent, onSuccess);
    socket.once('error', onError);
  });
}

function readHeaders(socket, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let byteLength = 0;
    let firstByteAt = null;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onError = (error) => fail(error);
    const onEnd = () => fail(new Error('连接在响应头完成前关闭'));
    const onData = (chunk) => {
      firstByteAt ??= performance.now();
      chunks.push(chunk);
      byteLength += chunk.length;
      if (byteLength > MAX_HEADER_BYTES) {
        fail(new Error('响应头超过安全上限'));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      cleanup();
      const remaining = buffer.subarray(boundary + 4);
      if (remaining.length) socket.unshift(remaining);
      resolve({ headers: buffer.subarray(0, boundary + 4).toString('latin1'), firstByteAt });
    };
    const timer = setTimeout(() => fail(new Error(timeoutMessage)), Math.max(1, timeoutMs));
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

function parseStatus(headers) {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+([^\r\n]*))?/i.exec(headers);
  if (!match) throw new Error('响应缺少有效 HTTP 状态行');
  return { statusCode: Number(match[1]), statusText: match[2] ?? '' };
}

function getHeader(headers, name) {
  const prefix = `${name.toLowerCase()}:`;
  const line = headers.split('\r\n').find((entry) => entry.toLowerCase().startsWith(prefix));
  return line ? line.slice(line.indexOf(':') + 1).trim() : '';
}

function remaining(deadline) {
  return Math.max(1, deadline - performance.now());
}

async function establishTlsTunnel({ proxyUrl, targetUrl, timeoutMs, tlsOptions = {} }) {
  const proxy = validateProxyUrl(proxyUrl);
  const target = targetUrl;
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const socket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port || 80),
  });
  try {
    await waitForSocketEvent(socket, 'connect', remaining(deadline), '连接本地 HTTP 代理超时');
    const connectMs = elapsed(startedAt);
    const targetPort = Number(target.port || 443);
    const authority = `${target.hostname}:${targetPort}`;
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Connection: keep-alive\r\n\r\n`);
    const connectResponse = await readHeaders(socket, remaining(deadline), 'HTTP CONNECT 握手超时');
    const connectStatus = parseStatus(connectResponse.headers);
    const tunnelMs = elapsed(startedAt) - connectMs;
    if (connectStatus.statusCode !== 200) {
      const error = new Error(`HTTP CONNECT 被代理拒绝（${connectStatus.statusCode}）`);
      error.phase = 'proxy-connect';
      error.statusCode = connectStatus.statusCode;
      error.metrics = { connectMs, tunnelMs };
      throw error;
    }
    socket.pause();
    const tlsStartedAt = performance.now();
    const secureSocket = tls.connect({
      socket,
      servername: target.hostname,
      ALPNProtocols: ['http/1.1'],
      ...tlsOptions,
    });
    secureSocket.resume();
    await waitForSocketEvent(secureSocket, 'secureConnect', remaining(deadline), 'TLS 握手超时');
    return {
      socket: secureSocket,
      deadline,
      startedAt,
      metrics: { connectMs, tunnelMs, tlsMs: Math.round(performance.now() - tlsStartedAt) },
    };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function classifyHttpStatus(statusCode) {
  if (statusCode === 401 || statusCode === 403 || statusCode === 407) return 'authentication-rejected';
  if (statusCode >= 200 && statusCode < 400) return 'accepted';
  return 'http-rejected';
}

function failureResult(kind, startedAt, error) {
  return {
    kind,
    networkOk: false,
    ...(kind === 'websocket' ? { websocketOk: false } : {}),
    outcome: error.phase ?? 'network-error',
    statusCode: error.statusCode ?? null,
    connectMs: error.metrics?.connectMs ?? null,
    tunnelMs: error.metrics?.tunnelMs ?? null,
    tlsMs: null,
    ttfbMs: null,
    totalMs: elapsed(startedAt),
    error: error.message,
  };
}

export async function probeHttpsViaProxy({ proxyUrl, targetUrl, timeoutMs = 8000, tlsOptions = {} }) {
  const startedAt = performance.now();
  let secureSocket;
  try {
    const target = validateTargetUrl(targetUrl, ['https:']);
    const tunnel = await establishTlsTunnel({ proxyUrl, targetUrl: target, timeoutMs, tlsOptions });
    secureSocket = tunnel.socket;
    const requestStartedAt = performance.now();
    const requestPath = `${target.pathname || '/'}${target.search}`;
    secureSocket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: */*\r\nConnection: close\r\nUser-Agent: mihomo-route-sentinel/1\r\n\r\n`);
    const response = await readHeaders(secureSocket, remaining(tunnel.deadline), '等待 HTTPS 首字节超时');
    const { statusCode } = parseStatus(response.headers);
    return {
      kind: 'https',
      networkOk: true,
      outcome: classifyHttpStatus(statusCode),
      statusCode,
      ...tunnel.metrics,
      ttfbMs: Math.round(response.firstByteAt - requestStartedAt),
      totalMs: elapsed(startedAt),
    };
  } catch (error) {
    return failureResult('https', startedAt, error);
  } finally {
    secureSocket?.destroy();
  }
}

export async function probeWebSocketViaProxy({ proxyUrl, targetUrl, timeoutMs = 8000, tlsOptions = {} }) {
  const startedAt = performance.now();
  let secureSocket;
  try {
    const target = validateTargetUrl(targetUrl, ['wss:']);
    const tunnel = await establishTlsTunnel({ proxyUrl, targetUrl: target, timeoutMs, tlsOptions });
    secureSocket = tunnel.socket;
    const requestStartedAt = performance.now();
    const requestPath = `${target.pathname || '/'}${target.search}`;
    const websocketKey = randomBytes(16).toString('base64');
    secureSocket.write(
      `GET ${requestPath} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: mihomo-route-sentinel/1\r\n\r\n`,
    );
    const response = await readHeaders(secureSocket, remaining(tunnel.deadline), '等待 WebSocket 握手超时');
    const { statusCode } = parseStatus(response.headers);
    const expectedAccept = createHash('sha1')
      .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const websocketOk = statusCode === 101
      && getHeader(response.headers, 'upgrade').toLowerCase() === 'websocket'
      && getHeader(response.headers, 'connection').toLowerCase().split(/\s*,\s*/).includes('upgrade')
      && getHeader(response.headers, 'sec-websocket-accept') === expectedAccept;
    return {
      kind: 'websocket',
      networkOk: true,
      websocketOk,
      outcome: websocketOk
        ? 'upgraded'
        : (statusCode === 101 ? 'invalid-websocket-handshake' : classifyHttpStatus(statusCode)),
      statusCode,
      ...tunnel.metrics,
      ttfbMs: Math.round(response.firstByteAt - requestStartedAt),
      totalMs: elapsed(startedAt),
    };
  } catch (error) {
    return failureResult('websocket', startedAt, error);
  } finally {
    secureSocket?.destroy();
  }
}

function isolatedProbeFailure(kind) {
  return {
    kind,
    networkOk: false,
    ...(kind === 'websocket' ? { websocketOk: false } : {}),
    outcome: 'probe-error',
    statusCode: null,
    connectMs: null,
    tunnelMs: null,
    tlsMs: null,
    ttfbMs: null,
    totalMs: null,
    error: `${kind} 探测发生内部异常`,
  };
}

export async function probeRealLinks(config, {
  httpsProbe = probeHttpsViaProxy,
  websocketProbe = probeWebSocketViaProxy,
} = {}) {
  if (!config?.enabled) return { enabled: false, https: null, websocket: null };
  const common = { proxyUrl: config.proxyUrl, timeoutMs: config.timeoutMs };
  const [httpsResult, websocketResult] = await Promise.allSettled([
    httpsProbe({ ...common, targetUrl: config.httpsUrl }),
    websocketProbe({ ...common, targetUrl: config.websocketUrl }),
  ]);
  return {
    enabled: true,
    https: httpsResult.status === 'fulfilled' ? httpsResult.value : isolatedProbeFailure('https'),
    websocket: websocketResult.status === 'fulfilled'
      ? websocketResult.value
      : isolatedProbeFailure('websocket'),
  };
}
