// Browser-safe Supabase client. Only uses the anon key. Safe to import from
// client components. RLS is always enforced.
//
// Env reads are LAZY — they happen inside the factory on invocation, never
// at module top level. A module-top-level throw would break any route that
// transitively imports this file during Next.js's build-time page-data pass.
import { createBrowserClient } from '@supabase/ssr';
import { requireEnv } from '@llmwiki/lib-utils/env';

/**
 * Browser Supabase client. Session cookie-backed; reads + subscribes respect
 * the authenticated user's RLS policies.
 */
export function supabaseBrowser() {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  return createBrowserClient(supabaseUrl, anonKey);
}
