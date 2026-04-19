'use client';

// Magic-link sign-in. The actual Supabase call lives server-side at
// /api/auth/magic-link; this form POSTs to that route so rate-limiting
// runs on the server and the email channel can't be flooded by a looping
// client. OAuth is a v1 addition with its own plan + council round.
import { useState } from 'react';

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
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setSent(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        data?.error && typeof data.error === 'string' && data.error.length > 0
          ? data.error
          : 'Unexpected error sending magic link.';
      setErr(message);
    } catch (caught) {
      setErr(
        caught instanceof Error && caught.message.length > 0
          ? caught.message
          : 'Unexpected error sending magic link.',
      );
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
        className="mt-1 block w-full border border-brand-100 rounded-md px-3 py-2 min-h-[44px] disabled:bg-brand-50 disabled:text-brand-700 disabled:cursor-not-allowed"
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
        className="mt-4 bg-brand-900 text-white px-4 py-2 rounded-md min-h-[44px] disabled:bg-brand-700 disabled:cursor-not-allowed"
      >
        {pending ? 'Sending…' : 'Send magic link'}
      </button>
    </form>
  );
}
