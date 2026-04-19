// Lazy env-var validator. Call at invocation time, never at module top level —
// module-top-level throws break Next.js's "Collecting page data" build phase
// for every route module that transitively imports the caller.
//
// Rejects nullish, empty string, and all-whitespace (including \n, \t). A
// pasted-but-empty Vercel env var is functionally identical to missing; fail
// at the factory call with a clear message instead of opaquely inside a
// downstream SDK.
//
// !!! SERVER-ONLY !!!
// This helper reads `process.env[name]` with a runtime-variable key. Next.js
// can only inline `NEXT_PUBLIC_*` env vars when the property name is a
// compile-time literal (`process.env.NEXT_PUBLIC_FOO`), not a dynamic one.
// In a client bundle, `process.env` is an empty shim, so calling this helper
// with any NEXT_PUBLIC name (or any name at all) returns `undefined` and
// throws. Client-bundled callers MUST read env vars via direct, literal
// property access — see packages/db/src/browser.ts for the pattern.

/**
 * Read a required env var by name. Throws if missing or whitespace-only.
 *
 * @remarks
 * Server-only. Do NOT use in client components or any module that ends up
 * in the Next.js client bundle — the dynamic `process.env[name]` access
 * here cannot be statically inlined by Next.js, so it always throws on the
 * client. Read `process.env.NEXT_PUBLIC_*` via literal property access in
 * client code instead. See `packages/db/src/browser.ts`.
 */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v.trim().length === 0) {
    throw new Error(`${name} missing or empty`);
  }
  return v;
}
