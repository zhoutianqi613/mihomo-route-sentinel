import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function protocolError(name, field, detail) {
  const error = new Error(`Controller 响应 ${name} 的字段 ${field} 无效：${detail}`);
  error.code = 'CONTROLLER_PROTOCOL';
  error.controllerName = name;
  error.field = field;
  return error;
}

/** 校验 /proxies/{name} 的响应形状；形状不符时 fail-closed，避免调用方解引用崩溃。 */
export function normalizeProxy(name, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw protocolError(name, 'proxy', '必须是 JSON 对象');
  }
  if (typeof data.type !== 'string' || !data.type) {
    throw protocolError(name, 'type', '必须是非空字符串');
  }
  if (data.now !== undefined && typeof data.now !== 'string') {
    throw protocolError(name, 'now', '存在时必须是字符串');
  }
  if (data.all !== undefined
      && (!Array.isArray(data.all) || data.all.some((entry) => typeof entry !== 'string'))) {
    throw protocolError(name, 'all', '存在时必须是字符串数组');
  }
  return data;
}

function discoverWindowsPipe(patternText) {
  if (process.platform !== 'win32') return '';
  const pattern = new RegExp(patternText, 'i');
  const matches = fs.readdirSync('\\\\.\\pipe\\').filter((name) => pattern.test(name));
  matches.sort((a, b) => {
    const rank = (name) => name.includes('production') ? 0 : 1;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return matches[0] ? `\\\\.\\pipe\\${matches[0]}` : '';
}
function buildTransport(config) {
  const requested = config.transport;
  if (requested === 'pipe' || requested === 'auto') {
    const pipePath = config.pipePath || discoverWindowsPipe(config.pipePattern);
    if (pipePath) return { kind: 'pipe', pipePath };
    if (requested === 'pipe') throw new Error('未找到匹配的 Mihomo Named Pipe');
  }
  return { kind: 'http', url: new URL(config.url) };
}

export class MihomoController {
  constructor(config, env = process.env) {
    this.config = config;
    this.transport = buildTransport(config);
    this.secret = config.secretEnv ? env[config.secretEnv] ?? '' : '';
  }

  describe() {
    if (this.transport.kind === 'pipe') {
      return { kind: 'pipe', endpoint: this.transport.pipePath.replace(/-[a-f0-9]{16,}$/i, '-[id]') };
    }
    return { kind: 'http', endpoint: this.transport.url.origin };
  }

  rediscoverPipeTransport() {
    const pipePath = this.config.pipePath || discoverWindowsPipe(this.config.pipePattern);
    return pipePath ? { kind: 'pipe', pipePath } : null;
  }

  async requestOnce(method, requestPath, body, { signal } = {}) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;

    const options = this.transport.kind === 'pipe'
      ? { socketPath: this.transport.pipePath, path: requestPath, method, headers, signal }
      : {
          protocol: this.transport.url.protocol,
          hostname: this.transport.url.hostname,
          port: this.transport.url.port,
          path: `${this.transport.url.pathname.replace(/\/$/, '')}${requestPath}`,
          method,
          headers,
          signal,
        };
    const client = this.transport.kind === 'http' && this.transport.url.protocol === 'https:' ? https : http;
    const maxResponseBytes = Number.isFinite(this.maxResponseBytes) && this.maxResponseBytes > 0
      ? Math.trunc(this.maxResponseBytes)
      : MAX_RESPONSE_BYTES;

    return await new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const rejectTooLarge = (observedBytes) => {
        const error = new Error(
          `Mihomo API 响应超过 ${maxResponseBytes} 字节上限（已接收 ${observedBytes} 字节）`,
        );
        error.code = 'CONTROLLER_RESPONSE_TOO_LARGE';
        error.limitBytes = maxResponseBytes;
        error.observedBytes = observedBytes;
        fail(error);
        req?.destroy();
      };
      req = client.request(options, (res) => {
        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          res.destroy();
          rejectTooLarge(declaredLength);
          return;
        }
        const chunks = [];
        let receivedBytes = 0;
        res.on('data', (chunk) => {
          if (settled) return;
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes) {
            chunks.length = 0;
            res.destroy();
            rejectTooLarge(receivedBytes);
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (settled) return;
          settled = true;
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (text) {
            try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data });
          } else {
            const error = new Error(`Mihomo API ${method} ${requestPath} 返回 ${res.statusCode}`);
            error.status = res.statusCode;
            error.data = data;
            reject(error);
          }
        });
      });
      req.setTimeout(this.config.requestTimeoutMs, () => {
        const timeout = new Error('Mihomo API 请求超时');
        timeout.code = 'ETIMEDOUT';
        req.destroy(timeout);
      });
      req.on('error', fail);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async request(method, requestPath, body, options) {
    if (this.config.transport === 'auto' && this.transport.kind === 'http') {
      const rediscovered = this.rediscoverPipeTransport();
      if (rediscovered) this.transport = rediscovered;
    }
    try {
      return await this.requestOnce(method, requestPath, body, options);
    } catch (error) {
      const recoverable = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
      if (!recoverable.has(error?.code)) throw error;
      if (!['auto', 'pipe'].includes(this.config.transport)) throw error;
      const rediscovered = this.rediscoverPipeTransport();
      // Pipe 重启窗口内可能暂时消失；auto 的 HTTP fallback 也必须持续尝试回到 Pipe。
      if (!rediscovered) throw error;
      this.transport = rediscovered;
      return this.requestOnce(method, requestPath, body, options);
    }
  }

  async getConfigs() {
    const { data } = await this.request('GET', '/configs');
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw protocolError('configs', 'response', '必须是 JSON 对象');
    }
    if (data.mode !== undefined && typeof data.mode !== 'string') {
      throw protocolError('configs', 'mode', '存在时必须是字符串');
    }
    return data;
  }

  async patchConfigs(patch) {
    await this.request('PATCH', '/configs', patch);
  }

  async getProxy(name) {
    const { data } = await this.request('GET', `/proxies/${encodeURIComponent(name)}`);
    return normalizeProxy(name, data);
  }

  async getDelay(name, url, timeoutMs, options) {
    const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
    const result = await this.request('GET', `/proxies/${encodeURIComponent(name)}/delay?${query}`, undefined, options);
    if (!Number.isFinite(result.data?.delay)) throw new Error('延迟响应缺少 delay');
    return result.data.delay;
  }

  async getGroupDelays(name, url, timeoutMs, options) {
    const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
    const result = await this.request('GET', `/group/${encodeURIComponent(name)}/delay?${query}`, undefined, options);
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error('代理组延迟响应格式无效');
    }
    const delays = new Map(Object.entries(result.data).filter(([, delay]) => Number.isFinite(delay)));
    if (delays.size === 0) throw new Error('代理组延迟响应没有有效节点');
    return delays;
  }

  async select(group, name) {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  }
}
