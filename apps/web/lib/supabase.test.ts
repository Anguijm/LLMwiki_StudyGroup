// Unit coverage for the Next.js cookies() adapter wired into
// createSupabaseClientForRequest in ./supabase.ts.
//
// PR #28 (issue #26) replaces the previous best-effort setAll with a
// TRANSACTIONAL adapter:
//
//   - First unexpected throw halts the loop; subsequent cookies in the
//     batch are NOT attempted.
//   - Expected Next.js RSC read-only throws still swallow silently and
//     DO NOT halt (a Server Component can read session state without
//     aborting the whole batch; no real write was attempted).
//   - The adapter no longer logs on its own. Failure surfacing is the
//     caller's job via the Proxy-exposed accessors:
//       - supabase.getCookieWriteFailure()  → { errorName } | null
//       - supabase.getWrittenCookieNames()  → readonly string[]
//     The /auth/callback route reads these after exchangeCodeForSession
//     to decide whether to redirect to /auth?error=cookie_failure and
//     which names to roll back via store.delete().
//
// Council r1 on PR #28 non-negotiables enforced here:
//   - [security] No code / access_token / refresh_token in any log.
//   - [arch] Method names are getCookieWriteFailure /
//     getWrittenCookieNames, consistent across interface + Proxy +
//     tests + docs.
//   - [security] Proxy passes through unknown / symbol property reads
//     unchanged via Reflect.get — no blast-radius on unrelated auth
//     calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CookieAdapter = {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (
    cookies: Array<{ name: string; value: string; options?: unknown }>,
  ) => void;
};

// Stub next/headers. The test controls what cookies().set() throws.
const setStub = vi.fn();
const deleteStub = vi.fn();
const cookiesStub = {
  getAll: () => [] as Array<{ name: string; value: string }>,
  set: (name: string, value: string, options?: unknown) =>
    setStub(name, value, options),
  delete: (name: string) => deleteStub(name),
};
vi.mock('next/headers', () => ({
  cookies: async () => cookiesStub,
}));

// The @llmwiki/db/server mock exposes an instrumented fake client so
// the test can assert Proxy passthrough. Every property access on the
// underlying client is logged to `proxyPassthroughCalls`; when the test
// accesses `someProp` on the Supabase client returned from
// supabaseForRequest, the Proxy should NOT intercept (only our two
// accessor names) and the access should reach the fake client.
const capturedAdapter: { current: CookieAdapter | null } = { current: null };
const fakeClient: Record<string | symbol, unknown> = {
  auth: { signInWithOtp: vi.fn(), exchangeCodeForSession: vi.fn() },
  [Symbol.iterator]: function* () {
    yield 'underlying-iter';
  },
};

vi.mock('@llmwiki/db/server', () => ({
  createSupabaseClientForRequest: (cookies: CookieAdapter) => {
    capturedAdapter.current = cookies;
    return fakeClient;
  },
  createSupabaseClientForJobs: () => ({}),
  supabaseService: () => ({}),
}));

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  setStub.mockReset();
  deleteStub.mockReset();
  capturedAdapter.current = null;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// setAll transactional behavior
// ---------------------------------------------------------------------------
describe('supabaseForRequest — setAll transactional cookie-write', () => {
  it('swallows the Next.js RSC read-only error silently (no log, no failure state)', async () => {
    setStub.mockImplementation(() => {
      throw new Error(
        'Cookies can only be modified in a Server Action or Route Handler. ' +
          'Read more: https://nextjs.org/docs/...',
      );
    });
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'sb-access-token', value: 'SECRET', options: {} },
    ]);
    expect(errSpy).not.toHaveBeenCalled();
    expect(sb.getCookieWriteFailure()).toBeNull();
    expect(sb.getWrittenCookieNames()).toEqual([]);
  });

  it('continues through multiple RSC throws without halting and without logging', async () => {
    // Server Component context — every store.set throws the RSC read-only
    // error. Adapter should attempt every cookie in the batch (caller may
    // still be reading session state; the fact that no write lands is
    // fine), emit no log, and report no failure.
    const attempted: string[] = [];
    setStub.mockImplementation((name: string) => {
      attempted.push(name);
      throw new Error(
        'Cookies can only be modified in a Server Action or Route Handler',
      );
    });
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'a', value: '1', options: {} },
      { name: 'b', value: '2', options: {} },
      { name: 'c', value: '3', options: {} },
    ]);
    expect(attempted).toEqual(['a', 'b', 'c']);
    expect(errSpy).not.toHaveBeenCalled();
    expect(sb.getCookieWriteFailure()).toBeNull();
    expect(sb.getWrittenCookieNames()).toEqual([]);
  });

  it('records successful writes and halts on the first UNEXPECTED throw', async () => {
    // Council bugs r1 on PR #28: transactional. The first unexpected
    // throw must halt the loop; subsequent cookies in the same batch
    // are NOT attempted (no partial session lands in the browser).
    const attempted: string[] = [];
    setStub.mockImplementation((name: string) => {
      attempted.push(name);
      if (name === 'sb-access-token.1') {
        throw new Error('ECONNRESET — upstream write failed');
      }
    });
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'sb-access-token.0', value: 'part0', options: {} },
      { name: 'sb-access-token.1', value: 'part1', options: {} },
      { name: 'sb-access-token.2', value: 'part2', options: {} },
    ]);
    // Write #3 was NOT attempted (transactional halt).
    expect(attempted).toEqual(['sb-access-token.0', 'sb-access-token.1']);
    // Write #1 succeeded and is tracked for rollback.
    expect(sb.getWrittenCookieNames()).toEqual(['sb-access-token.0']);
    // Failure is surfaced with the thrown error's class name only.
    expect(sb.getCookieWriteFailure()).toEqual({ errorName: 'Error' });
    // Adapter no longer logs on its own — rollback + logging is the
    // caller's job (kept quiet here so the callback route's log is
    // the single authoritative signal).
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('halts on the FIRST unexpected throw even when later cookies would also throw', async () => {
    // Regression: the halt must not be confused by a second throw
    // on a subsequent cookie — we should never even ATTEMPT the
    // subsequent cookie.
    const attempted: string[] = [];
    setStub.mockImplementation((name: string) => {
      attempted.push(name);
      throw new Error(`${name}-failed`);
    });
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'first', value: 'a', options: {} },
      { name: 'second', value: 'b', options: {} },
      { name: 'third', value: 'c', options: {} },
    ]);
    expect(attempted).toEqual(['first']);
    expect(sb.getWrittenCookieNames()).toEqual([]);
    expect(sb.getCookieWriteFailure()).toEqual({ errorName: 'Error' });
  });

  it('treats a non-Error throw as unexpected and records its typeof as errorName', async () => {
    setStub.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- test-only
      throw 'bare string rejection';
    });
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'x', value: 'y', options: {} },
    ]);
    expect(sb.getCookieWriteFailure()).toEqual({ errorName: 'string' });
    expect(sb.getWrittenCookieNames()).toEqual([]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('subsequent setAll calls in the same request are no-ops after a halt (council r3 bugs)', async () => {
    // @supabase/ssr may invoke setAll multiple times in one request
    // lifecycle (session refresh plus code-exchange, etc.). If the FIRST
    // call halted transactionally, any later call must be a no-op — we
    // must not let a second batch land a partial session after the first
    // already produced a cookie_failure.
    const attempted: string[] = [];
    setStub.mockImplementation((name: string) => {
      attempted.push(name);
      if (name === 'first') {
        throw new Error('ECONNRESET — upstream write failed');
      }
    });
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();

    // First call: halts on `first`.
    capturedAdapter.current!.setAll([
      { name: 'first', value: 'a', options: {} },
    ]);
    expect(sb.getCookieWriteFailure()).toEqual({ errorName: 'Error' });
    expect(attempted).toEqual(['first']);

    // Second call: MUST be a no-op — no store.set attempts, failure
    // state unchanged, writtenNames unchanged.
    capturedAdapter.current!.setAll([
      { name: 'second', value: 'b', options: {} },
      { name: 'third', value: 'c', options: {} },
    ]);
    expect(attempted).toEqual(['first']); // unchanged
    expect(sb.getWrittenCookieNames()).toEqual([]);
    expect(sb.getCookieWriteFailure()).toEqual({ errorName: 'Error' });
  });

  it('successful writes populate getWrittenCookieNames in order', async () => {
    // No throws — everything writes. Names track in call order so the
    // rollback path can delete them without relying on store.getAll().
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'first', value: '1', options: {} },
      { name: 'second', value: '2', options: {} },
    ]);
    expect(sb.getWrittenCookieNames()).toEqual(['first', 'second']);
    expect(sb.getCookieWriteFailure()).toBeNull();
  });

  it('getWrittenCookieNames returns a snapshot — mutating it does not affect internal state', async () => {
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    capturedAdapter.current!.setAll([
      { name: 'only', value: '1', options: {} },
    ]);
    const snapshot = sb.getWrittenCookieNames() as string[];
    snapshot.push('phantom');
    expect(sb.getWrittenCookieNames()).toEqual(['only']);
  });
});

// ---------------------------------------------------------------------------
// Proxy passthrough — council security r1 top-risk #1 guard.
// ---------------------------------------------------------------------------
describe('supabaseForRequest — Proxy passthrough', () => {
  it('passes through access to underlying client properties (auth)', async () => {
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    // `sb.auth` must reach through to fakeClient.auth, not be intercepted
    // as one of our sentinel accessor names.
    expect(sb.auth).toBe(fakeClient.auth);
  });

  it('returns undefined for unknown string properties (passes through Reflect.get)', async () => {
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    expect((sb as any).__nonexistent__).toBeUndefined();
  });

  it('passes through symbol property access', async () => {
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    // The fake client defines Symbol.iterator; Proxy must not eat it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only
    expect((sb as any)[Symbol.iterator]).toBe(fakeClient[Symbol.iterator]);
  });

  it('preserves `in` operator (Reflect.has passthrough) — council nice-to-have', async () => {
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    expect('auth' in sb).toBe(true);
    expect('__nonexistent__' in sb).toBe(false);
    // Our sentinel names exist because Proxy's `get` resolves them; `in`
    // via default handler uses the target's `has`. We don't need `has`
    // to report our sentinels — what we need is no REGRESSION in how
    // `in` answers for real client properties.
  });

  it('getCookieWriteFailure() is always callable even before any setAll ran', async () => {
    // Council nice-to-have: early-read of the accessor must not throw.
    const { supabaseForRequest } = await import('./supabase');
    const sb = await supabaseForRequest();
    expect(sb.getCookieWriteFailure()).toBeNull();
    expect(sb.getWrittenCookieNames()).toEqual([]);
  });
});
