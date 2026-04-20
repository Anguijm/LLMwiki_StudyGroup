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
 * Request-scoped Supabase client wired to Next.js's `cookies()` API.
 * Reads AND writes cookies — so this is the correct factory for Route
 * Handlers, Server Actions, AND Server Components (reads only).
 *
 * For PKCE sign-in: /auth/callback hits exchangeCodeForSession, which
 * writes the session cookie via the setAll callback below. Before PR
 * #22 this path used a read-only client and the session landed on the
 * floor. See packages/db/src/server.ts for the factory split rationale.
 *
 * In a Server Component, Next.js forbids cookie mutation — `store.set`
 * throws. That's expected when a component reads session state via this
 * client, so we catch the throw and debug-log rather than propagate.
 */
export async function supabaseForRequest() {
  const store = await cookies();
  return createSupabaseClientForRequest({
    getAll() {
      return store.getAll().map(({ name, value }) => ({ name, value }));
    },
    setAll(cookiesToSet) {
      // Discriminate two failure modes per write (council bugs r4) AND
      // accumulate unexpected failures so we can surface one partial-
      // write summary at the end (council bugs r5).
      //
      //   1. Server Component context — Next.js forbids cookie mutation
      //      from render. The thrown error's message contains "Cookies
      //      can only be modified in a Server Action or Route Handler"
      //      (or minor variants across Next versions). Expected when an
      //      RSC reads session state via this client; swallow silently.
      //
      //   2. Anything else — a Route Handler or Server Action where the
      //      write SHOULD have succeeded but didn't. @supabase/ssr
      //      typically sends multiple chunked cookies in one setAll
      //      call; if one fails but others succeed the user is left
      //      with a partial session. Continuing the loop is right
      //      (best-effort: maybe one chunk was transient), but a
      //      post-loop summary log makes the partial-write signal
      //      explicit so a future debug session doesn't miss it.
      const unexpectedErrorNames: string[] = [];
      for (const { name, value, options } of cookiesToSet) {
        try {
          store.set(name, value, options);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isExpectedRscContext =
            /cookies.*modif|server\s*action|route\s*handler/i.test(msg);
          if (isExpectedRscContext) continue;
          unexpectedErrorNames.push(
            err instanceof Error ? err.name : typeof err,
          );
        }
      }
      if (unexpectedErrorNames.length > 0) {
        // eslint-disable-next-line no-console
        console.error(
          `supabase: setAll partial write — ${unexpectedErrorNames.length}/` +
            `${cookiesToSet.length} cookie writes failed in a write-capable ` +
            'context. Session may be inconsistent. Cookie names and values ' +
            'omitted to avoid leakage.',
          { errorNames: unexpectedErrorNames },
        );
      }
    },
  });
}

/**
 * Read-only Supabase client for cookie-less server contexts. Prefer
 * supabaseForRequest above; this factory is exposed for Inngest-style
 * workers that receive a raw Cookie header string and have no response
 * to carry Set-Cookie.
 */
export { supabaseService, createSupabaseClientForJobs };
