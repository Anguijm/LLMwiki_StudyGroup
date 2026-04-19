# Plan: `force-dynamic` on root layout so CSP nonces stamp on rendered HTML

## Status

PR #13 shipped per-request CSP nonce middleware. Prod verification via
`curl -sI` shows:

- `/diag` CSP header: `script-src 'self' 'nonce-fmsWsovI2Yc95ZLEsJiFBQ==' 'strict-dynamic'`
- `/auth` CSP header: `script-src 'self' 'nonce-Y9CKrXcfBxyCewIUGwlqLw==' 'strict-dynamic'`
- `cache-control: private, no-store, max-age=0` ✅
- `connect-src` wildcard `*.vercel.app` gone ✅

User-facing after PR #13:

- `/diag` renders and stays — **visually looks fixed**. But: no inline
  script tags carry a `nonce=` attribute, so client JS (if any) is
  CSP-blocked. `/diag` is a pure server component with no hydration
  requirements, so this is latent but not visible.
- `/auth` renders and stays — the form is visible. **But: the "Send
  magic link" button does nothing.** React never hydrates because
  CSP + `'strict-dynamic'` blocks every script tag (none have nonces).

## Why the nonce isn't on scripts

Build output from `next build`:

```
├ ○ /auth     912 B    165 kB
├ ○ /diag     133 B    103 kB
```

`○` = **static**. Both pages are **prerendered at build time** into
frozen HTML. Middleware runs at request time and sets `x-nonce` on
the request — but the HTML was already serialized during `next build`
when no `x-nonce` existed. There is no request-time render pass that
could stamp the nonce onto Next.js's emitted script tags.

For per-request nonces to land on per-page scripts, the page has to
be rendered per request. In Next.js 15 App Router, that means the
route segment config `dynamic = 'force-dynamic'`.

## Fix

Add a single line to `apps/web/app/layout.tsx`:

```tsx
export const dynamic = 'force-dynamic';
```

Layout-level route segment config propagates to children. Every page
now renders per request, Next.js sees `x-nonce` on the request, and
stamps `nonce="<value>"` on every script tag it emits. CSP
`'nonce-<value>' 'strict-dynamic'` then permits those scripts and
their transitively-loaded chunks.

`/diag` overrides with its own `dynamic = 'force-static'`, so it stays
prerendered. That's fine — `/diag` is diagnostic-only, no client JS
needed; CSP-blocked scripts on it are a non-issue.

## Why this is the minimal correct fix

**Not** "convert `/auth` to a server component wrapper + client child."
That would touch auth code surface, require import shuffling, and still
leave any future client page broken by default. Layout-level
`force-dynamic` is future-proof: any new client component under `/app`
automatically gets the nonce treatment.

**Not** "remove `'strict-dynamic'` and rely on `'self'`." Under plain
`'self'`, Next.js's inline Flight-payload `<script>` tags (no `src`,
inline content like `self.__next_f.push(...)`) are still blocked
because `'self'` only permits same-origin *external* scripts. Inline
scripts need `'unsafe-inline'`, a nonce, or a hash.

**Not** "add `'unsafe-inline'` to script-src." Defeats the whole point
of the PR #13 fix and opens XSS defense-in-depth on an auth-adjacent
surface.

## Cost trade-off (explicit)

PR #13 already set `Cache-Control: private, no-store, max-age=0` in
middleware, which disables Vercel Edge HTML caching for every
middleware-matched route. That means we've already paid the "no HTML
cache" cost. Forcing dynamic rendering adds no further cost at the
CDN layer — it just changes the origin render path from "serve
prebuilt HTML" to "render on demand." Per-request render is still
fast (React 19 streaming, `/auth` is tiny), and we have no traffic
volume that makes this a concern.

Cohort-scale math: worst case 100 users × 20 page loads/day = 2000
origin renders/day = ~60k/month. Vercel Hobby SSR invocation limit
is 100k/day. Well within budget.

## Verification plan

Local (pre-push):

1. `pnpm --filter web run typecheck` — adding a const export shouldn't
   introduce TS errors; confirms nothing broke.
2. `pnpm --filter web run test` — existing tests still pass; no new
   test needed (the change's observable behavior is a CDN/render-mode
   switch, not testable in vitest).
3. `env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production npx next build`
   in `apps/web/`. The build output should now show:
   - `ƒ /auth` (dynamic)
   - `○ /diag` (static; overrides layout)
   - `ƒ /` (still dynamic; was already dynamic)
   - `ƒ /note/[slug]` (still dynamic)

Post-deploy (prod):

4. `curl -sL https://llmwiki-study-group.vercel.app/auth | grep -oE 'nonce="[^"]+"' | head -5` shows at least one `nonce="..."` attribute on a `<script>` tag.
5. Human visits `/auth`, types an email, clicks "Send magic link" →
   either receives the email or sees a "Check your email" confirmation
   message. No silent button.
6. Human completes the full sign-in round-trip: email arrives,
   clicking the link lands on the dashboard (`/`), the cohort
   upsert runs, the notes list renders.

## Non-goals

- Changing anything on `/diag`. It stays static intentionally.
- Changing `/note/[slug]`. Already dynamic.
- Adding `nonce={nonce}` to any explicit `<Script>` components. We
  don't use any; Next.js auto-stamps inline scripts when the page
  is dynamic and `x-nonce` is set.
- Refactoring `/auth/page.tsx` into a server-component wrapper.
  Unnecessary complication; layout-level `force-dynamic` handles it.
- Adding Vercel ISR or page-level revalidate config. Not needed for
  the cohort scale.
- Re-enabling HTML edge caching. PR #13 deliberately disabled it for
  CSP coherence; that constraint stands.

## Non-negotiables (carry-over from PR #13)

- `connect-src` stays scoped (no `*.vercel.app` wildcard).
- `script-src` keeps `'strict-dynamic'` + nonce.
- Middleware matcher still excludes `/api/inngest` and `/auth/callback`.
- No `[skip council]` — this directly affects the auth flow's
  hydration behavior, which is an auth-surface change.

## Rollback

If making all pages dynamic surfaces an unexpected regression:

- Revert the single commit on `main` → layout returns to implicit
  static-by-default.
- User is back to PR #13's post-state: `/diag` renders, `/auth`
  renders but button dead. Known regression boundary; no worse than
  right now.

## Open questions for council

1. **Should `/note/[slug]` be forced static via `force-static`?**
   Individual notes don't need per-user personalization (RLS handles
   that). Prerendering them would save origin compute. But they
   contain dashboardy interactivity (future: edits, comments) that
   may need JS. Defer — not in scope for this fix.

2. **Should we add a Playwright / smoke test that asserts `/auth`
   has `nonce="..."` on at least one script tag post-deploy?**
   The current regression suite is unit-level; an end-to-end check
   would catch a future `dynamic = 'force-static'` regression. Worth
   a follow-up issue, not in this PR's scope.

## Why not bundle the /diag cleanup (issue #12) here?

CLAUDE.md directive: "Don't add features, refactor, or introduce
abstractions beyond what the task requires. A bug fix doesn't need
surrounding cleanup." `/diag` removal is a separate, already-tracked
concern (issue #12). Folding it in would expand the security surface
being council-reviewed in this plan. Strictly out of scope.

## Execution order

Single commit. The change is one line in one file plus a reflection
block in `learnings.md` (appended, not in scope of the code change
but per CLAUDE.md session protocol).

1. Edit `apps/web/app/layout.tsx` — add `export const dynamic = 'force-dynamic';`.
2. Run local verification (steps 1-3 above).
3. Commit with `fix(web): force-dynamic on root layout so CSP nonces stamp`.
4. Push, council r2 on diff.
5. On PROCEED → human approval → merge.
6. Post-merge: steps 4-6 of §Verification plan.
7. Reflect in `.harness/learnings.md`.
