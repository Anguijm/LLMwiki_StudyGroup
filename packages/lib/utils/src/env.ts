// Lazy env-var validator. Call at invocation time, never at module top level —
// module-top-level throws break Next.js's "Collecting page data" build phase
// for every route module that transitively imports the caller.
//
// Rejects nullish, empty string, and all-whitespace (including \n, \t). A
// pasted-but-empty Vercel env var is functionally identical to missing; fail
// at the factory call with a clear message instead of opaquely inside a
// downstream SDK.

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v.trim().length === 0) {
    throw new Error(`${name} missing or empty`);
  }
  return v;
}
