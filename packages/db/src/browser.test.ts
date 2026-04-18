// Regression suite for the lazy env-var contract on the browser-side
// Supabase factory. Same shape as server.test.ts but scoped to the two
// public vars — the browser factory never touches the service-role key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const;

const MISSING_VALUES: ReadonlyArray<readonly [label: string, value: string | undefined]> = [
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace', '   '],
  ['newline', '\n'],
  ['tab', '\t'],
];

function setValid() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-abc');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('packages/db/src/browser — module import', () => {
  it('does not throw at import time with all env vars unset', async () => {
    for (const key of REQUIRED_ENV) vi.stubEnv(key, undefined as unknown as string);
    await expect(import('./browser')).resolves.toBeDefined();
  });

  it('does not throw at import time with all env vars empty', async () => {
    for (const key of REQUIRED_ENV) vi.stubEnv(key, '');
    await expect(import('./browser')).resolves.toBeDefined();
  });
});

describe('supabaseBrowser()', () => {
  for (const [label, value] of MISSING_VALUES) {
    it(`throws when NEXT_PUBLIC_SUPABASE_URL is ${label}`, async () => {
      setValid();
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', value as string);
      const { supabaseBrowser } = await import('./browser');
      expect(() => supabaseBrowser()).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
    });

    it(`throws when NEXT_PUBLIC_SUPABASE_ANON_KEY is ${label}`, async () => {
      setValid();
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', value as string);
      const { supabaseBrowser } = await import('./browser');
      expect(() => supabaseBrowser()).toThrowError(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    });
  }

  it('returns a client when both required vars are set', async () => {
    setValid();
    const { supabaseBrowser } = await import('./browser');
    const client = supabaseBrowser();
    expect(client).toBeDefined();
  });
});
