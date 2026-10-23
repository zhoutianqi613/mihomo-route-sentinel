import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

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

  async requestOnce(method, requestPath, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    if (this.secret) headers.Authorization = `Bearer ${this.secret}`;

    const options = this.transport.kind === 'pipe'
      ? { socketPath: this.transport.pipePath, path: requestPath, method, headers }
      : {
          protocol: this.transport.url.protocol,
          hostname: this.transport.url.hostname,
          port: this.transport.url.port,
          path: `${this.transport.url.pathname.replace(/\/$/, '')}${requestPath}`,
          method,
          headers,
        };
    const client = this.transport.kind === 'http' && this.transport.url.protocol === 'https:' ? https : http;

    return await new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
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
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async request(method, requestPath, body) {
    if (this.config.transport === 'auto' && this.transport.kind === 'http') {
      const rediscovered = this.rediscoverPipeTransport();
      if (rediscovered) this.transport = rediscovered;
    }
    try {
      return await this.requestOnce(method, requestPath, body);
    } catch (error) {
      const recoverable = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
      if (!recoverable.has(error?.code)) throw error;
      if (!['auto', 'pipe'].includes(this.config.transport)) throw error;
      const rediscovered = this.rediscoverPipeTransport();
      // Pipe 重启窗口内可能暂时消失；auto 的 HTTP fallback 也必须持续尝试回到 Pipe。
      if (!rediscovered) throw error;
      this.transport = rediscovered;
      return this.requestOnce(method, requestPath, body);
    }
  }

  async getConfigs() {
    return (await this.request('GET', '/configs')).data;
  }

  async patchConfigs(patch) {
    await this.request('PATCH', '/configs', patch);
  }

  async getProxy(name) {
    return (await this.request('GET', `/proxies/${encodeURIComponent(name)}`)).data;
  }

  async getDelay(name, url, timeoutMs) {
    const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
    const result = await this.request('GET', `/proxies/${encodeURIComponent(name)}/delay?${query}`);
    if (!Number.isFinite(result.data?.delay)) throw new Error('延迟响应缺少 delay');
    return result.data.delay;
  }

  async select(group, name) {
    await this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name });
  }
}
