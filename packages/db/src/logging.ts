// Log redactor. Strips sensitive tokens before logs hit the drain.
// CLAUDE.md non-negotiable: no PII or API keys in logs.
//
// Two passes:
//   1. Any object key matching *_(key|secret|token|password|authorization)
//      replaces its value with [REDACTED]. Catches structured payloads.
//   2. String values are scanned for obvious secret shapes (Bearer tokens,
//      known vendor key prefixes, bare 32+ char hex/base64). Catches the
//      case where an upstream error message inlines the key in its text.

const SENSITIVE_KEY_PATTERN = /^(.*_(key|secret|token|password|authorization))$/i;
const REDACTED = '[REDACTED]';

// Heuristic value-level scrubbing. Patterns deliberately broad to err on
// the side of over-redaction in a log line vs. leaking a key.
const VALUE_SCRUB_PATTERNS: Array<[RegExp, string]> = [
  // HTTP Authorization header shapes.
  [/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]'],
  [/Basic\s+[A-Za-z0-9+/=]{16,}/gi, 'Basic [REDACTED]'],
  // Anthropic, OpenAI, Voyage API-key prefixes.
  [/sk-(?:ant|[A-Za-z])[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
  [/pa-[A-Za-z0-9_-]{16,}/g, '[REDACTED_API_KEY]'],
  // JWT-shaped strings (three base64url parts joined by dots).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED_JWT]'],
  // Long bare hex strings (likely a hash / secret).
  [/\b[a-f0-9]{40,}\b/gi, '[REDACTED_HEX]'],
  // Upstash redis REST URLs carry the token in the query string.
  [/(rest_token=)[A-Za-z0-9_-]{8,}/gi, '$1[REDACTED]'],
];

function scrubString(s: string): string {
  let out = s;
  for (const [pat, replacement] of VALUE_SCRUB_PATTERNS) {
    out = out.replace(pat, replacement);
  }
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
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
