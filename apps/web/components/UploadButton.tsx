'use client';

// PDF upload trigger. Content-hash idempotency: we compute sha256(file_bytes)
// client-side so duplicate submits (double-click, two tabs, retry) collapse
// to the same job on the server. Button disables on click until the
// response resolves.
import { useRef, useState } from 'react';
import { t } from '../lib/i18n';

interface UploadButtonProps {
  cohortId: string;
}

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function UploadButton({ cohortId }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = () => inputRef.current?.click();

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > 25 * 1024 * 1024) {
      setError(t('error.file_too_large'));
      return;
    }

    setPending(true);
    setError(null);
    try {
      const key = await sha256Hex(file);
      const form = new FormData();
      form.set('file', file);
      form.set('idempotency_key', key);
      form.set('cohort_id', cohortId);
      form.set('title', file.name.replace(/\.pdf$/i, ''));

      const res = await fetch('/api/ingest', { method: 'POST', body: form });
      if (!res.ok) {
        // Read as text first (cheap, always works) so a non-JSON error
        // (e.g., proxy/gateway HTML, Cloudflare challenge, Vercel 502)
        // still surfaces something useful instead of being swallowed by
        // a generic message. (council batch-9+ bugs fix).
        const raw = await res.text().catch(() => '');
        try {
          const body = raw ? JSON.parse(raw) : {};
          setError(body?.error?.message ?? t('error.generic'));
        } catch {
          // Trim and truncate HTML responses so the user's error toast
          // stays readable; full text goes to the server log.
          const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 200);
          setError(snippet || t('error.generic'));
        }
        return;
      }
    } catch {
      setError(t('error.generic'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        aria-describedby={error ? 'upload-error' : undefined}
        onChange={handleChange}
      />
      <button
        type="button"
        disabled={pending}
        onClick={handlePick}
        className="bg-brand-900 text-white px-4 py-2 rounded-md min-w-[10rem] min-h-[44px] disabled:opacity-60"
      >
        {pending ? t('dashboard.upload.pending') : t('dashboard.upload.button')}
      </button>
      {error && (
        <p id="upload-error" role="alert" className="mt-2 text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
