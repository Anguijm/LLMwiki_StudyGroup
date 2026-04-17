// User-text sanitizer (r7 approval-gate Q2).
// Applied at every server boundary (API route, server action) before values
// touch Postgres or an external API. The frontend is not trusted.
//
// - Strip null bytes and C0 controls (except whitespace we care about).
// - Strip C1 controls (\x80..\x9f).
// - NFC-normalize so visually identical strings hash the same.
// - Enforce a hard max length per field.

export const NOTE_TITLE_MAX = 512;
export const GETCONTEXT_QUERY_MAX = 2000;

// Keep: \t (0x09), \n (0x0a), \r (0x0d). Drop the rest of C0 + all C1.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function sanitizeUserText(input: string, maxLength: number): string {
  if (typeof input !== 'string') {
    throw new TypeError('sanitizeUserText: expected string');
  }
  const stripped = input.replace(CONTROL_CHARS, '');
  const normalized = stripped.normalize('NFC');
  // Intentionally do NOT trim — callers decide if whitespace-only is OK.
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

export function sanitizeNoteTitle(input: string): string {
  return sanitizeUserText(input, NOTE_TITLE_MAX);
}

export function sanitizeContextQuery(input: string): string {
  return sanitizeUserText(input, GETCONTEXT_QUERY_MAX);
}
