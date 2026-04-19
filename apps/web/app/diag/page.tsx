// Diagnostic page — pure server component, zero client-side JS, no imports
// from workspace packages. If this route renders but /auth doesn't, the
// bug lives in the /auth page's client component or one of its imports.
// If this one also goes blank, the issue is in the layout, the framework
// wiring, or the browser/network environment.
//
// Temporary; remove once blank-page issue is root-caused.

export const dynamic = 'force-static';

export default function DiagPage() {
  return (
    <div
      style={{
        padding: '1rem',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '16px',
        color: '#000',
        background: '#fff',
      }}
    >
      <h1 style={{ fontSize: '20px', fontWeight: 'bold' }}>diag: server component OK</h1>
      <p>
        If you can read this sentence, Vercel is serving valid HTML and your browser is
        rendering it.
      </p>
      <ul>
        <li>server-rendered time: {new Date().toISOString()}</li>
        <li>node version: {process.version}</li>
      </ul>
      <p>
        Next test: visit <a href="/auth">/auth</a> and compare.
      </p>
    </div>
  );
}
