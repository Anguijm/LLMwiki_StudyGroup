'use client';

// Magic-link sign-in page. Kept intentionally minimal — OAuth is a v1
// addition with its own plan + council round.
import { useState } from 'react';
import { supabaseBrowser } from '@llmwiki/db/browser';

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    if (pending) return;
    setErr(null);
    setPending(true);
    try {
      const supabase = supabaseBrowser();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${location.origin}/auth/callback` },
      });
      if (error) setErr(error.message);
      else setSent(true);
    } catch (caught) {
      setErr(caught instanceof Error ? caught.message : 'Unexpected error sending magic link.');
    } finally {
      setPending(false);
    }
  };

  if (sent) {
    return (
      <p role="status" aria-live="polite">
        Check your email for a sign-in link.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-sm">
      <label htmlFor="email" className="block text-sm font-medium text-brand-900">
        Email
      </label>
      <input
        id="email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-describedby={err ? 'auth-error' : undefined}
        disabled={pending}
        className="mt-1 block w-full border border-brand-100 rounded-md px-3 py-2 min-h-[44px] disabled:opacity-60"
      />
      {err && (
        <p id="auth-error" role="alert" aria-live="assertive" className="mt-2 text-danger text-sm">
          {err}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        aria-busy={pending}
        className="mt-4 bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {pending ? 'Sending…' : 'Send magic link'}
      </button>
    </form>
  );
}
