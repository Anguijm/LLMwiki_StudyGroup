// Next.js wrappers around the framework-agnostic factories in
// @llmwiki/db/server. Keeps next/headers out of the DB package so the DB
// package is usable from Inngest and future non-Next callers.
import 'server-only';
import { cookies } from 'next/headers';
import { supabaseServer, supabaseService } from '@llmwiki/db/server';

/**
 * Server-component / server-action Supabase client scoped to the current
 * request's session cookie. Observes RLS via auth.uid().
 */
export async function supabaseForRequest() {
  const store = await cookies();
  return supabaseServer(store.toString());
}

export { supabaseService };
