// Next.js wrappers around the framework-agnostic factories in
// @llmwiki/db/server. Keeps next/headers out of the DB package so the DB
// package is usable from Inngest and future non-Next callers.
import 'server-only';
import { cookies } from 'next/headers';
import {
  createSupabaseClientForRequest,
  createSupabaseClientForJobs,
  supabaseService,
} from '@llmwiki/db/server';

/**
 * State exposed by the Proxy-wrapped Supabase client so the /auth/callback
 * route can detect a partial session-cookie write and roll back.
 *
 * Added in PR #28 (issue #26). See §B of .harness/active_plan.md.
 *
 *   - `getCookieWriteFailure()` — returns `{ errorName }` for the first
 *     unexpected setAll throw that halted the transaction, or `null` if
 *     no halt occurred in this request's lifetime. `errorName` is the
 *     thrown error's `.name` (or `typeof` for non-Error throws); the
 *     value is a class identifier only — never a message, stack, or
 *     cookie payload. Caller uses it to choose `cookie_failure` over
 *     `server_error` when both produce failures.
 *
 *   - `getWrittenCookieNames()` — returns the names of cookies that
 *     successfully wrote BEFORE the halt (if any). Returns a fresh
 *     array copy each call — mutating it does not affect the adapter.
 *     Caller iterates and `cookies().delete(name)` each so the browser
 *     is not left with a partial session-cookie set.
 */
export interface CookieWriteState {
  getCookieWriteFailure(): { errorName: string } | null;
  getWrittenCookieNames(): readonly string[];
}

type SupabaseClientForRequest = ReturnType<typeof createSupabaseClientForRequest>;

/**
 * Request-scoped Supabase client wired to Next.js's `cookies()` API.
 * Reads AND writes cookies — so this is the correct factory for Route
 * Handlers, Server Actions, AND Server Components (reads only).
 *
 * Returns the Supabase client wrapped in a Proxy that surfaces
 * cookie-write transaction state (see {@link CookieWriteState}).
 * The Proxy intercepts ONLY the two sentinel accessor names — every
 * other property / symbol read flows through `Reflect.get` unchanged,
 * so the wrapper is transparent to consumers that only need the
 * standard Supabase surface.
 *
 * ### Transactional setAll
 *
 * @supabase/ssr's PKCE flow calls `setAll([...])` with multiple chunked
 * cookies in a single invocation. Before PR #28 we tried every cookie
 * and summary-logged partial failures. That was wrong for auth: a
 * partial session-cookie write lands a broken session in the browser
 * and the user experiences a silent login failure after clicking a
 * valid link.
 *
 * The current adapter halts on the first UNEXPECTED throw. The expected
 * Next.js "cookies can only be modified in a Server Action or Route
 * Handler" throw from Server Components still swallows silently and
 * does NOT halt (no write was actually attempted; the SC may still
 * want to read session state). Anything else records a failure and
 * stops the loop — the caller (route handler) reads the failure and
 * rolls back.
 *
 * The adapter NEVER logs on its own. Logging lives where the rollback
 * is decided — the route handler knows the error kind and writes a
 * single authoritative line. Keeping the adapter quiet avoids
 * double-logging and keeps the log set grep-stable for monitoring.
 */
export async function supabaseForRequest(): Promise<
  SupabaseClientForRequest & CookieWriteState
> {
  const store = await cookies();

  let failure: { errorName: string } | null = null;
  const writtenNames: string[] = [];

  const client = createSupabaseClientForRequest({
    getAll() {
      return store.getAll().map(({ name, value }) => ({ name, value }));
    },
    setAll(cookiesToSet) {
      // Skip entirely if a prior setAll call in this request already
      // halted the transaction — @supabase/ssr can batch multiple
      // setAll invocations, and we must not accept writes after a halt.
      if (failure) return;

      for (const { name, value, options } of cookiesToSet) {
        try {
          store.set(name, value, options);
          writtenNames.push(name);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isExpectedRscContext =
            /cookies.*modif|server\s*action|route\s*handler/i.test(msg);
          if (isExpectedRscContext) {
            // Server Component context — writes are forbidden by
            // Next.js. Not an error; skip this name and continue so
            // the SC can finish reading session state.
            continue;
          }
          // Unexpected failure. Record (first wins) and halt the loop.
          // Subsequent cookies in this batch are NOT attempted — a
          // partial session-cookie set is the very failure mode this
          // halt is closing.
          failure = {
            errorName: err instanceof Error ? err.name : typeof err,
          };
          break;
        }
      }
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'getCookieWriteFailure') return () => failure;
      if (prop === 'getWrittenCookieNames') return () => [...writtenNames];
      return Reflect.get(target, prop, receiver);
    },
  }) as SupabaseClientForRequest & CookieWriteState;
}

/**
 * Read-only Supabase client for cookie-less server contexts. Prefer
 * supabaseForRequest above; this factory is exposed for Inngest-style
 * workers that receive a raw Cookie header string and have no response
 * to carry Set-Cookie.
 */
export { supabaseService, createSupabaseClientForJobs };
