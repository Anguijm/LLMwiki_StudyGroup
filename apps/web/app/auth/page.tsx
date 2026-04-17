'use client';

// Magic-link sign-in page. Kept intentionally minimal — OAuth is a v1
// addition with its own plan + council round.
import { useState } from 'react';
import { supabaseBrowser } from '@llmwiki/db/browser';

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit: React.FormEventHandler<HTMLFormElement> = async (e) => {
    e.preventDefault();
    setErr(null);
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${location.origin}/auth/callback` },
    });
    if (error) setErr(error.message);
    else setSent(true);
  };

  if (sent) {
    return <p>Check your email for a sign-in link.</p>;
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
        className="mt-1 block w-full border border-brand-100 rounded-md px-3 py-2 min-h-[44px]"
      />
      {err && (
        <p id="auth-error" role="alert" className="mt-2 text-danger text-sm">
          {err}
        </p>
      )}
      <button
        type="submit"
        className="mt-4 bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px]"
      >
        Send magic link
      </button>
    </form>
  );
}
