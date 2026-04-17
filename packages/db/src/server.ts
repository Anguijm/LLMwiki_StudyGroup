// Server-only Supabase clients. Guarded by the `server-only` npm package so
// accidental import from a client component fails `next build` at
// compile time — not at runtime.
//
// Two factories:
//   - supabaseServer()   — anon key, runs under the caller's JWT (RLS on).
//                          Use in server components + server actions that
//                          must observe RLS.
//   - supabaseService()  — service role key, bypasses RLS. Use ONLY in
//                          Inngest workers, webhook handlers, and admin
//                          RPCs. Never import from a component file.
import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL missing');
if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing');

/**
 * Server component + server action Supabase client.
 * Attaches the user's JWT from cookies so RLS policies evaluate against
 * auth.uid(). Costs ~0 per call (just object construction).
 */
export async function supabaseServer() {
  const cookieStore = await cookies();
  return createClient(supabaseUrl!, anonKey!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: {
        // Attach the session cookie so Supabase reads the JWT.
        cookie: cookieStore.toString(),
      },
    },
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
