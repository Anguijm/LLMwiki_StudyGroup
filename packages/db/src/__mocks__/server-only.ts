// No-op stand-in for the `server-only` npm package during vitest runs.
// The real module throws on import outside a Next.js Server Component
// context; tests execute outside that context, so alias to this empty file.
export {};
