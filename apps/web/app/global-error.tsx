'use client';

// Global error boundary. Catches errors thrown from the root layout itself
// (which error.tsx can't reach, because error.tsx is inside the layout).
// Required by Next.js App Router — if this file is absent and the layout
// throws, the user gets a blank page with no hint of why.
//
// Temporary scaffolding for diagnosing the blank /auth page post-deploy.
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[global-error]', error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        <div
          role="alert"
          aria-live="assertive"
          style={{
            padding: '1rem',
            margin: '1rem',
            border: '2px solid #b91c1c',
            background: '#fef2f2',
            color: '#7f1d1d',
            fontFamily: 'monospace',
            fontSize: '14px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <strong style={{ display: 'block', marginBottom: '0.5rem', fontSize: '16px' }}>
            Global error
          </strong>
          <div>
            <strong>message:</strong> {error.message}
          </div>
          {error.digest ? (
            <div>
              <strong>digest:</strong> {error.digest}
            </div>
          ) : null}
          {error.stack ? (
            <details style={{ marginTop: '0.5rem' }}>
              <summary>stack</summary>
              <pre style={{ marginTop: '0.25rem', fontSize: '12px' }}>{error.stack}</pre>
            </details>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '0.75rem',
              padding: '0.5rem 1rem',
              background: '#b91c1c',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
