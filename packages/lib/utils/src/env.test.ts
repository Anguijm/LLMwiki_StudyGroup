import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireEnv } from './env';

const KEY = 'LLMWIKI_REQUIRE_ENV_TEST_KEY';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('requireEnv', () => {
  it.each([
    ['undefined', undefined],
    ['empty string', ''],
    ['single space', ' '],
    ['multiple spaces', '   '],
    ['newline', '\n'],
    ['tab', '\t'],
    ['mixed whitespace', ' \t\n '],
  ] as const)('throws when value is %s', (_label, value) => {
    if (value === undefined) {
      vi.stubEnv(KEY, undefined as unknown as string);
    } else {
      vi.stubEnv(KEY, value);
    }
    expect(() => requireEnv(KEY)).toThrowError(new RegExp(`${KEY} missing or empty`));
  });

  it('returns the raw value for a non-whitespace string', () => {
    vi.stubEnv(KEY, 'abc-123');
    expect(requireEnv(KEY)).toBe('abc-123');
  });

  it('returns the value as-is without trimming surrounding whitespace', () => {
    vi.stubEnv(KEY, '  padded-value  ');
    expect(requireEnv(KEY)).toBe('  padded-value  ');
  });

  it('includes the variable name in the error message', () => {
    vi.stubEnv(KEY, '');
    expect(() => requireEnv(KEY)).toThrowError(/LLMWIKI_REQUIRE_ENV_TEST_KEY/);
  });
});
