// Supabase Auth code-exchange landing URL. The magic-link email points at
// /auth/callback?code=...; we exchange the code for a session cookie and
// redirect to the dashboard.
import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@llmwiki/db/server';

export async function GET(req: NextRequest) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) return NextResponse.redirect(new URL('/auth', req.url));

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    const url = new URL('/auth', req.url);
    url.searchParams.set('error', error.message);
    return NextResponse.redirect(url);
  }

  return NextResponse.redirect(new URL('/', req.url));
}
