// Browser-safe Supabase client. Only uses the anon key. Safe to import from
// client components. RLS is always enforced.
import { createBrowserClient } from '@supabase/ssr';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) throw new Error('NEXT_PUBLIC_SUPABASE_URL missing');
if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY missing');

/**
 * Browser Supabase client. Session cookie-backed; reads + subscribes respect
 * the authenticated user's RLS policies.
 */
export function supabaseBrowser() {
  return createBrowserClient(supabaseUrl!, anonKey!);
}
