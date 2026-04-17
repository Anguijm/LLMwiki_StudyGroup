// Structured metric emitter. Writes JSON lines to stdout so Vercel +
// Supabase log drains can pick them up and route to downstream tools.
//
// This is deliberately thin — no client SDK, no external dependency. v0
// treats "metric" as "a well-shaped log line"; v1+ can point these at
// a proper TSDB without touching callers.
//
// Envelope: { level, ts, metric, value, labels?, ...kv }
//
// Every call from an Inngest step MUST include a `job_id` label so a
// metric can be joined back to its ingestion_jobs row.

type Primitive = string | number | boolean | null;

interface BaseMetric {
  metric: string;
  value: number;
  labels?: Record<string, Primitive>;
}

function emit(level: 'info' | 'warn' | 'error', m: BaseMetric, extra?: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    ts: new Date().toISOString(),
    kind: 'metric',
    ...m,
    ...extra,
  });
  // Use console.warn for info/warn so Vercel functions log captures it;
  // use console.error for error (same routing, different severity).
  if (level === 'error') console.error(line);
  else console.warn(line);
}

export function counter(name: string, labels?: Record<string, Primitive>): void {
  emit('info', { metric: name, value: 1, labels });
}

export function increment(name: string, by: number, labels?: Record<string, Primitive>): void {
  emit('info', { metric: name, value: by, labels });
}

export function histogram(name: string, value: number, labels?: Record<string, Primitive>): void {
  emit('info', { metric: name, value, labels });
}

export function warn(name: string, value: number, labels?: Record<string, Primitive>): void {
  emit('warn', { metric: name, value, labels });
}

export function errorMetric(
  name: string,
  value: number,
  labels?: Record<string, Primitive>,
  extra?: Record<string, unknown>,
): void {
  emit('error', { metric: name, value, labels }, extra);
}

// Convenience wrapper for duration measurement.
export async function withDuration<T>(
  name: string,
  labels: Record<string, Primitive>,
  run: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const out = await run();
    histogram(name, (Date.now() - start) / 1000, { ...labels, status: 'ok' });
    return out;
  } catch (err) {
    histogram(name, (Date.now() - start) / 1000, { ...labels, status: 'error' });
    throw err;
  }
}
