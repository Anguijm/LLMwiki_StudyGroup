// Log redactor. Strips sensitive tokens before logs hit the drain.
// CLAUDE.md non-negotiable: no PII or API keys in logs.

const SENSITIVE_KEY_PATTERN = /^(.*_(key|secret|token|password|authorization))$/i;
const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export function logInfo(event: string, payload: Record<string, unknown> = {}): void {
  console.warn(JSON.stringify({ level: 'info', event, ...((redact(payload) as object) ?? {}) }));
}

export function logError(event: string, payload: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ level: 'error', event, ...((redact(payload) as object) ?? {}) }));
}
