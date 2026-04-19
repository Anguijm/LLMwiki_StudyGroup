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
      for (const { name, value, options } of cookiesToSet) {
        try {
          store.set(name, value, options);
        } catch {
          // Cookie mutation is only supported in Route Handlers and
          // Server Actions. When this client is used from a Server
          // Component render, Next.js throws here — that case is
          // EXPECTED and correct (an RSC should not be rewriting the
          // user's session cookie). Drop the write so the read path
          // still returns fresh user data. Any other failure mode
          // (e.g. a Route Handler where writes should work) will
          // surface in dev via this log without exposing the cookie.
          if (process.env.NODE_ENV !== 'production') {
            // eslint-disable-next-line no-console
            console.debug(
              'supabase: setAll failed in a context where cookie writing ' +
                'is not supported (e.g., Server Component). This is expected ' +
                'when reading session state from an RSC; ignoring.',
            );
          }
        }
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
