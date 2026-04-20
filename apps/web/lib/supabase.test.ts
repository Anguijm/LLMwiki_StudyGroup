// Unit coverage for the Next.js cookies() adapter wired into
// createSupabaseClientForRequest in ./supabase.ts.
//
// Council r4 bugs concern: the previous draft swallowed every setAll
// throw behind `if (process.env.NODE_ENV !== 'production')`, which
// meant a genuine Route-Handler failure in prod left no trace. The
// current adapter discriminates on the error message: a Next.js
// "cookies can only be modified in a Server Action or Route Handler"
// throw is EXPECTED when a Server Component reads session state and is
// swallowed silently; anything else is logged via console.error (with
// cookie names/values omitted) so the bug is visible in production.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CookieAdapter = {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (
    cookies: Array<{ name: string; value: string; options?: unknown }>,
  ) => void;
};

// Stub next/headers. The test controls what cookies().set() throws.
const setStub = vi.fn();
const cookiesStub = {
  getAll: () => [] as Array<{ name: string; value: string }>,
  set: (name: string, value: string, options?: unknown) =>
    setStub(name, value, options),
};
vi.mock('next/headers', () => ({
  cookies: async () => cookiesStub,
}));

// Capture the adapter passed into createSupabaseClientForRequest so the
// test can drive the setAll path directly. The returned "client" object
// is a no-op stub; none of its methods are exercised.
const capturedAdapter: { current: CookieAdapter | null } = { current: null };

vi.mock('@llmwiki/db/server', () => ({
  createSupabaseClientForRequest: (cookies: CookieAdapter) => {
    capturedAdapter.current = cookies;
    return {};
  },
  createSupabaseClientForJobs: () => ({}),
  supabaseService: () => ({}),
}));

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  setStub.mockReset();
  capturedAdapter.current = null;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errSpy.mockRestore();
});

describe('supabaseForRequest — setAll cookie-write discriminator', () => {
  it('swallows the Next.js RSC read-only error silently (no log)', async () => {
    setStub.mockImplementation(() => {
      throw new Error(
        'Cookies can only be modified in a Server Action or Route Handler. ' +
          'Read more: https://nextjs.org/docs/...',
      );
    });
    const { supabaseForRequest } = await import('./supabase');
    await supabaseForRequest();
    expect(capturedAdapter.current).not.toBeNull();
    // Drive the adapter directly.
    capturedAdapter.current!.setAll([
      { name: 'sb-access-token', value: 'SECRET', options: {} },
    ]);
    // Expected RSC context → silent swallow. Nothing in console.error.
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs a partial-write summary on an unexpected setAll throw (Route Handler bug)', async () => {
    setStub.mockImplementation(() => {
      throw new Error('ECONNRESET — upstream write failed');
    });
    const { supabaseForRequest } = await import('./supabase');
    await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'sb-access-token', value: 'SECRET', options: {} },
    ]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [message, context] = errSpy.mock.calls[0] as [string, unknown];
    expect(message).toMatch(/setAll partial write/i);
    expect(message).toMatch(/1\/1/);
    // Regression guard: cookie name + value must NOT appear in the log.
    const contextString = JSON.stringify(context);
    expect(message).not.toContain('sb-access-token');
    expect(message).not.toContain('SECRET');
    expect(contextString).not.toContain('sb-access-token');
    expect(contextString).not.toContain('SECRET');
  });

  it('reports N/M when some writes succeed and some fail (council bugs r5)', async () => {
    // @supabase/ssr typically sends multiple chunked cookies; a partial
    // write (1 of 3 fails) must surface as "1/3 cookie writes failed"
    // so the debugger sees the split state at a glance.
    setStub.mockImplementation((name: string) => {
      if (name === 'sb-access-token.1') {
        throw new Error('ECONNRESET — upstream write failed');
      }
    });
    const { supabaseForRequest } = await import('./supabase');
    await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'sb-access-token.0', value: 'part0', options: {} },
      { name: 'sb-access-token.1', value: 'part1', options: {} },
      { name: 'sb-access-token.2', value: 'part2', options: {} },
    ]);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const [message] = errSpy.mock.calls[0] as [string, unknown];
    expect(message).toMatch(/1\/3/);
    expect(message).toMatch(/partial write/i);
    // Cookie identifiers and values must not appear in the summary.
    expect(message).not.toContain('sb-access-token');
    expect(message).not.toContain('part0');
    expect(message).not.toContain('part1');
    expect(message).not.toContain('part2');
  });

  it('continues processing the remaining cookies after one throws', async () => {
    // Regression: the loop must not halt on a single throw — otherwise
    // a single flaky cookie would skip the rest of the session chunks.
    const attempted: string[] = [];
    setStub.mockImplementation((name: string) => {
      attempted.push(name);
      if (name === 'second')
        throw new Error(
          'Cookies can only be modified in a Server Action or Route Handler',
        );
    });
    const { supabaseForRequest } = await import('./supabase');
    await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'first', value: 'a', options: {} },
      { name: 'second', value: 'b', options: {} },
      { name: 'third', value: 'c', options: {} },
    ]);
    expect(attempted).toEqual(['first', 'second', 'third']);
  });

  it('emits no summary log when all throws are the expected RSC case', async () => {
    // An all-RSC-expected pass should stay silent — the previous
    // iteration inadvertently logged once per cookie, which would be
    // noisy in every Server Component render.
    setStub.mockImplementation(() => {
      throw new Error(
        'Cookies can only be modified in a Server Action or Route Handler',
      );
    });
    const { supabaseForRequest } = await import('./supabase');
    await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'a', value: '1', options: {} },
      { name: 'b', value: '2', options: {} },
    ]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('treats a non-Error throw as unexpected and logs it', async () => {
    setStub.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- test-only
      throw 'bare string rejection';
    });
    const { supabaseForRequest } = await import('./supabase');
    await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'x', value: 'y', options: {} },
    ]);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
