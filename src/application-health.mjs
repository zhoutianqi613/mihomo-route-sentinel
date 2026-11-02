import { readFile, stat } from 'node:fs/promises';

const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_FUTURE_SKEW_MS = 5_000;
const KIND_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function baseResult(enabled = true) {
  return {
    enabled,
    fresh: false,
    ok: null,
    status: 'unknown',
    checkedAt: null,
    consecutiveFailures: null,
    kind: null,
  };
}

export function evaluateApplicationHealth(signal, { minimumFailures = 2 } = {}) {
  if (signal?.enabled !== true) return { ...baseResult(false), status: 'disabled', counted: false };
  const fresh = signal.fresh === true;
  const failures = Number.isInteger(signal.consecutiveFailures)
    ? Math.max(0, signal.consecutiveFailures) : null;
  const ok = typeof signal.ok === 'boolean' ? signal.ok : null;
  const counted = fresh && ok === false && failures != null && failures >= minimumFailures;
  return {
    enabled: true,
    fresh,
    ok,
    status: fresh
      ? (ok === true ? 'healthy' : (counted ? 'degraded' : 'pending'))
      : (typeof signal.status === 'string' && /^[a-z-]{1,32}$/.test(signal.status)
        ? signal.status : 'unknown'),
    checkedAt: typeof signal.checkedAt === 'string' ? signal.checkedAt : null,
    consecutiveFailures: failures,
    kind: typeof signal.kind === 'string' && KIND_PATTERN.test(signal.kind) ? signal.kind : null,
    counted,
  };
}

export async function readApplicationHealth(file, {
  maxAgeSeconds = 120,
  now = Date.now(),
} = {}) {
  if (!file) return { ...baseResult(false), status: 'disabled' };
  let info;
  try {
    info = await stat(file);
  } catch (error) {
    return {
      ...baseResult(),
      status: error?.code === 'ENOENT' ? 'missing' : 'invalid',
    };
  }
  if (!info.isFile() || info.size > MAX_SIGNAL_BYTES) {
    return { ...baseResult(), status: 'invalid' };
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { ...baseResult(), status: 'invalid' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.ok !== 'boolean'
      || typeof parsed.checkedAt !== 'string'
      || !Number.isInteger(parsed.consecutiveFailures)
      || parsed.consecutiveFailures < 0) {
    return { ...baseResult(), status: 'invalid' };
  }
  const checkedAtMs = Date.parse(parsed.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return { ...baseResult(), status: 'invalid' };
  const ageMs = now - checkedAtMs;
  const fresh = ageMs >= -MAX_FUTURE_SKEW_MS && ageMs <= maxAgeSeconds * 1000;
  return {
    enabled: true,
    fresh,
    ok: parsed.ok,
    status: fresh ? (parsed.ok ? 'healthy' : 'degraded') : 'stale',
    checkedAt: parsed.checkedAt,
    consecutiveFailures: parsed.consecutiveFailures,
    kind: typeof parsed.kind === 'string' && KIND_PATTERN.test(parsed.kind)
      ? parsed.kind : null,
  };
}
