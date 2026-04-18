// User-text sanitizer (r7 approval-gate Q2).
// Applied at every server boundary (API route, server action) before values
// touch Postgres or an external API. The frontend is not trusted.
//
// - Strip null bytes and C0 controls (except whitespace we care about).
// - Strip C1 controls (\x80..\x9f).
// - NFC-normalize so visually identical strings hash the same.
// - Enforce a hard max length per field.

export const NOTE_TITLE_MAX = 512;
// Kept comfortably above VOYAGE_MAX_INPUT_CHARS (30k) so the sanitizer
// doesn't pre-trim before getContext's truncation layer can flag
// wasTruncated. The two layers handle different concerns: sanitize is a
// hard safety ceiling; getContext truncation is the embedding-model's
// token budget.
export const GETCONTEXT_QUERY_MAX = 32_000;

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

/**
 * Sanitize a filename before it's used anywhere in a storage path (r2-diff
 * council defense-in-depth). Drops path-separators, null bytes, controls, and
 * anything that could make the result escape its intended prefix.
 *
 * NOTE: v0 actually uses `ingest/<job_id>.pdf` — the filename never touches
 * the path. This helper is a backstop for future code that might.
 */
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]/g;
export function sanitizeFilename(input: string): string {
  // Controls + unsafe chars both become `_` (not dropped) so length can't
  // drop under the byte count a caller expected and so obvious attacks
  // (f\0o => foo) leave a visible sanitation trace.
  const stripped = input.replace(CONTROL_CHARS, '_').replace(UNSAFE_FILENAME_CHARS, '_');
  // Collapse any run of two-or-more dots (`..` path traversal) to a
  // single `_`, and replace leading dots so hidden-file paths (`.env`)
  // can't be synthesized.
  const normalized = stripped.replace(/\.{2,}/g, '_').replace(/^\.+/, '_');
  return normalized.length > 255 ? normalized.slice(0, 255) : normalized;
}
