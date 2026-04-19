// Browser-safe Supabase client. Only uses the anon key. Safe to import from
// client components. RLS is always enforced.
//
// Env reads use LITERAL `process.env.NEXT_PUBLIC_*` property access. Next.js
// statically inlines these at build time only when the property name is a
// compile-time literal — `process.env[name]` with a runtime variable does
// NOT get inlined and ships as `undefined` in the client bundle. That's why
// this file deliberately does not import `requireEnv`; that helper reads
// `process.env[name]` dynamically and is correct for server callers but
// fatal for client ones.
//
// Validation duplicates `requireEnv`'s empty/whitespace contract (covered
// by browser.test.ts) so the only thing that changes between this file and
// `requireEnv` is the inlining behaviour, not the error semantics.
import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser Supabase client. Session cookie-backed; reads + subscribes respect
 * the authenticated user's RLS policies.
 */
export function supabaseBrowser() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl || supabaseUrl.trim().length === 0) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL missing or empty');
  }
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey || anonKey.trim().length === 0) {
    throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing or empty');
  }
  return createBrowserClient(supabaseUrl, anonKey);
}
