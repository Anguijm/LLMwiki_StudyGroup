// Regression suite for the lazy env-var contract on the server-side
// Supabase factories. Council r2 blocker: empty / whitespace env vars must
// also fail the guard.
//
// Test matrix: for each factory and each required var, the three "missing"
// flavors must throw at invocation. The module itself must NEVER throw at
// import time, even with every var scrubbed — that's what broke Vercel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

const MISSING_VALUES: ReadonlyArray<readonly [label: string, value: string | undefined]> = [
  ['undefined', undefined],
  ['empty string', ''],
  ['whitespace', '   '],
  ['newline', '\n'],
  ['tab', '\t'],
];

function scrubAll() {
  for (const key of REQUIRED_ENV) {
    vi.stubEnv(key, undefined as unknown as string);
  }
}

function setValid() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key-abc');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-xyz');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('packages/db/src/server — module import', () => {
  it('does not throw at import time with all env vars unset', async () => {
    scrubAll();
    await expect(import('./server')).resolves.toBeDefined();
  });

  it('does not throw at import time with all env vars empty', async () => {
    for (const key of REQUIRED_ENV) vi.stubEnv(key, '');
    await expect(import('./server')).resolves.toBeDefined();
  });
});

describe('supabaseServer()', () => {
  for (const [label, value] of MISSING_VALUES) {
    it(`throws when NEXT_PUBLIC_SUPABASE_URL is ${label}`, async () => {
      setValid();
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', value as string);
      const { supabaseServer } = await import('./server');
      expect(() => supabaseServer('cookie=x')).toThrowError(
        /NEXT_PUBLIC_SUPABASE_URL/,
      );
    });

    it(`throws when NEXT_PUBLIC_SUPABASE_ANON_KEY is ${label}`, async () => {
      setValid();
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', value as string);
      const { supabaseServer } = await import('./server');
      expect(() => supabaseServer('cookie=x')).toThrowError(
        /NEXT_PUBLIC_SUPABASE_ANON_KEY/,
      );
    });
  }

  it('returns a client when both required vars are set', async () => {
    setValid();
    const { supabaseServer } = await import('./server');
    const client = supabaseServer('cookie=x');
    expect(client).toBeDefined();
    expect(typeof (client as { from?: unknown }).from).toBe('function');
  });
});

describe('supabaseService()', () => {
  for (const [label, value] of MISSING_VALUES) {
    it(`throws when SUPABASE_SERVICE_ROLE_KEY is ${label}`, async () => {
      setValid();
      vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', value as string);
      const { supabaseService } = await import('./server');
      expect(() => supabaseService()).toThrowError(/SUPABASE_SERVICE_ROLE_KEY/);
    });

    it(`throws when NEXT_PUBLIC_SUPABASE_URL is ${label}`, async () => {
      setValid();
      vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', value as string);
      const { supabaseService } = await import('./server');
      expect(() => supabaseService()).toThrowError(/NEXT_PUBLIC_SUPABASE_URL/);
    });
  }

  it('returns a client when all required vars are set', async () => {
    setValid();
    const { supabaseService } = await import('./server');
    const client = supabaseService();
    expect(client).toBeDefined();
    expect(typeof (client as { from?: unknown }).from).toBe('function');
  });
});
