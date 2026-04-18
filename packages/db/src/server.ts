// Server-only Supabase clients. Guarded by the `server-only` npm package so
// accidental import from a client component fails `next build` at compile
// time — not at runtime.
//
// Factories:
//   - supabaseServer(cookieHeader) — anon key, scoped to the caller's JWT
//     carried in the Cookie header. RLS evaluates against auth.uid().
//   - supabaseService() — service-role key, bypasses RLS. Use ONLY in
//     Inngest workers, webhook handlers, and admin RPCs.
//
// packages/db is framework-agnostic: the caller passes the Cookie string in.
// apps/web wraps supabaseServer() with next/headers's cookies().toString().
import 'server-only';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL missing');
if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing');

/**
 * Server-component / server-action Supabase client. Caller passes the raw
 * Cookie header from the request; Supabase uses it to look up the user's
 * JWT so RLS policies resolve against auth.uid(). Cost: ~0 per call
 * (construction only).
 */
export function supabaseServer(cookieHeader: string) {
  return createClient(supabaseUrl!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { cookie: cookieHeader } },
  });
}

/**
 * Service-role Supabase client. RLS is bypassed — every call here is
 * trusted. Used by Inngest functions (ingest pipeline, watchdog, onFailure
 * hook) and admin server actions.
 *
 * Expected call volume: once per Inngest step across the pipeline; not
 * per-request. Cost is zero (local construction).
 */
export function supabaseService() {
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY missing — required for service-role operations',
    );
  }
  return createClient(supabaseUrl!, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
