'use client';

// Route-segment error boundary. When a client component inside the /app tree
// throws during render or hydration, Next.js renders this file's default
// export instead of a blank page. In production React usually shows nothing
// on uncaught errors — this boundary makes the failure visible so we can
// actually see what's going wrong in the browser.
//
// Temporary scaffolding for diagnosing the blank /auth page post-deploy.
// Once the root cause is identified + fixed, this can either stay (as a
// user-friendly error screen) or be replaced with a nicer production UI.
import { useEffect } from 'react';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[route-error]', error);
  }, [error]);

  return (
    <div
      role="alert"
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
        Route error
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
  );
}
