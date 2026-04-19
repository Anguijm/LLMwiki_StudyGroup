// Server-only Supabase clients. Guarded by the `server-only` npm package so
// accidental import from a client component fails `next build` at compile
// time — not at runtime.
//
// === Which factory do I pick? ===
//
// There are three factories below. The middle one is the default for HTTP
// request handlers; the other two are for narrower contexts. Picking the
// wrong one silently breaks auth, so the naming is deliberately explicit
// (council arch r2 PR #22).
//
//   - createSupabaseClientForRequest(adapter) — READ + WRITE cookies.
//     Use from Next.js Route Handlers, Server Actions, and Server
//     Components. Supports the PKCE auth flow: exchangeCodeForSession()
//     can write the session cookie via the adapter's setAll callback.
//     apps/web/lib/supabase.ts wraps this with the next/headers cookies()
//     API.
//
//   - createSupabaseClientForJobs(cookieHeader) — READ-ONLY cookies.
//     Use from Inngest workers, webhook handlers, and any context where
//     there is no response to carry Set-Cookie. Accepts a raw Cookie
//     header string so RLS resolves against auth.uid() when a caller JWT
//     is available. If you pass this to a PKCE exchangeCodeForSession()
//     call, the session lands on the floor — that's the bug PR #22 was
//     opened to fix.
//
//   - supabaseService() — service-role key, bypasses RLS. Use ONLY in
//     Inngest workers, webhook handlers, and admin RPCs. Never reaches
//     the client bundle (guarded by server-only).
//
// === Env read discipline ===
//
// Env reads are LAZY — they happen inside each factory on invocation,
// never at module top level. Module-top-level throws break Next.js's
// "Collecting page data" build phase for any route that transitively
// imports this file.
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import { requireEnv } from '@llmwiki/lib-utils/env';

/**
 * Request-scoped Supabase client that can READ and WRITE cookies.
 * The caller supplies a cookies adapter with getAll/setAll; we plumb
 * that into @supabase/ssr's createServerClient and configure the PKCE
 * auth flow so exchangeCodeForSession() can persist the session via
 * Set-Cookie on the outgoing response.
 *
 * Cost: ~0 per call (local construction; no network).
 */
export function createSupabaseClientForRequest(cookies: CookieMethodsServer) {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createServerClient(supabaseUrl, anonKey, {
    cookies,
    auth: {
      flowType: 'pkce',
      detectSessionInUrl: false,
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

/**
 * Read-only Supabase client for cookie-less server contexts (Inngest
 * workers, webhook handlers, cron). Caller passes a raw Cookie header
 * string if a user JWT is available so RLS resolves against auth.uid().
 *
 * Do NOT use this for auth flows that need to persist a session — the
 * client has no way to write Set-Cookie. Use createSupabaseClientForRequest
 * for that.
 *
 * Cost: ~0 per call (construction only).
 */
export function createSupabaseClientForJobs(cookieHeader: string) {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { cookie: cookieHeader } },
  });
}

/**
 * Service-role Supabase client. RLS is bypassed — every call here is
 * trusted. Used by Inngest functions (ingest pipeline, watchdog,
 * onFailure hook) and admin server actions.
 *
 * Expected call volume: once per Inngest step across the pipeline; not
 * per-request. Cost is zero (local construction).
 */
export function supabaseService() {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
