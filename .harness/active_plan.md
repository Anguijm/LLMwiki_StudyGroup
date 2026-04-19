# Session handoff: CSP + auth fix arc shipped, framework persona is next session's opener

## What landed this session

Three sequential PRs on `main` closing out the production blank-page →
dead-button bug:

| PR | Commit | Scope |
|---|---|---|
| **#13** | `eb707b0` | Per-request CSP nonce via `apps/web/middleware.ts`. Replaced static `script-src 'self'` (which blocked Next.js 15's inline Flight-payload scripts) with nonce + `'strict-dynamic'`. `Cache-Control: private, no-store, max-age=0` to prevent Vercel Edge serving stale HTML with mismatched nonces. Matcher excludes `/api/inngest` and `/auth/callback`. Removed `https://*.vercel.app` wildcard from `connect-src`. Council arc r1→r4 PROCEED. |
| **#16** | `ffec953` | `export const dynamic = 'force-dynamic'` on `apps/web/app/layout.tsx`. Per-request nonces can't stamp on prerendered HTML (baked at build time before middleware runs); layout-level `force-dynamic` forces every route to render per-request so Next.js reads `x-nonce` and stamps scripts correctly. Note: Next.js's layout-level `force-dynamic` overrides child `force-static`, so `/diag` is now dynamic too (acceptable — no DB calls, no interactivity). |
| **#17** | `f4fc657` | New rate-limited server-side `apps/web/app/api/auth/magic-link/route.ts`; client `/auth/page.tsx` now `fetch()`es it. `packages/db/src/browser.ts` reads `process.env.NEXT_PUBLIC_*` via literal property access (Next.js can't inline dynamic `process.env[name]`). New Tier C limiter in `@llmwiki/lib-ratelimit` (per-IP 5/hr, per-email 3/hr). Open-redirect protection (required `APP_BASE_URL`, no Host-header fallback). Email alias stripping in rate-limit key. UX hardening on `/auth` (pending state, aria-live regions, "Sending…" copy swap). Council arc r1→r4, two REVISEs (security at r2, bugs at r3) both folded in. |

Verified in prod via curl:
- CSP header carries per-request nonce.
- All `<script>` tags carry matching `nonce="..."` attributes.
- `/api/auth/magic-link` returns 400 on bad JSON, bad email shape,
  missing email, whitespace-only email, oversize email, missing
  `x-forwarded-for`.
- `APP_BASE_URL` confirmed set in Vercel All-Environments.
- Human tested the button: first deploy (post PR #17) response
  unverified as of handoff — user to confirm next session.

## Next session's opener (priority order)

### 1. Framework specialist council persona (issue #18)

**Why this is #1:** Three sequential PRs this session all landed on
Next.js / Vercel framework-boundary issues (static vs dynamic rendering;
middleware vs prerender timing; client-bundle inlining semantics). The
existing six personas (a11y, arch, bugs, cost, product, security) reason
about general code quality, not framework-specific footguns. Adding a
seventh persona collapses the three-PR arc into one.

Draft `.harness/council/framework.md` covering:
- App Router static vs dynamic (`○` vs `ƒ`) and how it interacts with
  middleware / cookies / headers / CSP.
- Build-time vs runtime `process.env` access (literal vs dynamic).
- Edge runtime vs Node.js runtime differences.
- Hydration error reach (async / pre-hydration failures bypass
  `error.tsx`).
- RSC / Flight payload flow and inline-script nonce stamping.
- Cache-Control × Vercel Edge interaction.
- `NEXT_PUBLIC_` prefix semantics (the "accidental client secret"
  class).
- Server Component vs Client Component module-graph implications
  (`server-only`, `'use client'`).

Include an explicit escape hatch: "if this diff does not touch
Next.js / Vercel / React-server semantics, return `Score: 10` and
`No framework concerns.`" — mitigates noise on DB migrations, pure
styling changes, etc.

Plan → PR → council r1 (the persona file is the thing being reviewed,
so r1 will be self-referential but that's fine) → human approval →
merge. `council.py` glob already scans `.harness/council/*.md` so no
wiring change needed.

### 2. Confirm the button works end-to-end

User's browser test of the merged `/auth` form is the real success
metric for the whole three-PR arc. If the button still doesn't work,
check the `[magic-link]` server log lines (new in PR #17) — upstream
Supabase / Upstash errors are now logged with full context. Vercel
Functions → Runtime Logs → filter for `[magic-link]`.

### 3. Complete the sign-in → dashboard round trip

Once the button works:
- Click magic link in email.
- Land on `/auth/callback` (redirect-only route, excluded from
  middleware).
- Session cookie set; redirect to `/`.
- Dashboard renders (cohort upsert, notes list, ingestion jobs).
- Test a PDF upload end-to-end.

This is the first real smoke test of the v0 vertical slice shipped
in PR #5. If anything breaks on this path, it's the first real bug
since the auth-flow blocker.

## Open issues queued by this session

- **#18** — Framework persona (above; next session's #1).
- **#19** — Five PR #17 council r4 nice-to-haves: client `AbortSignal`
  timeout, null-byte email test, case-variant bucket test, multi-IP
  XFF test, serial IP→email rate check.
- **#20** — Playwright nonce smoke test. Would have prevented the
  PR #17 dead-button bug if it had existed.
- **#14** — CSP `report-uri` endpoint.
- **#15** — `style-src` hardening (remove `'unsafe-inline'`).
- **#12** — `/diag` removal + error-boundary production hardening.
  Now that the full fix arc is green, `/diag` can be deleted.
  Low-effort cleanup.
- **#7** — `db-tests` pgTAP flake (still `continue-on-error`).
- **#6** — Storage RLS metadata refactor (v0 deferral).

## Non-goals for next session

- Feature work (v1 kickoff waits for confirmed end-to-end sign-in
  + a PDF upload smoke test).
- Merging any of the open issues above without their own plan +
  council round.
- Re-opening the CSP nonce design.

## Opening protocol (per CLAUDE.md)

1. Read `.harness/session_state.json`.
2. Read last ~20 lines of `.harness/yolo_log.jsonl`.
3. Read the 2026-04-19 16:55 UTC block in `.harness/learnings.md`.
4. Read this plan (§Next session's opener).
5. Human will provide the end-to-end sign-in test result.
6. If sign-in works → go to roadmap item #1 (framework persona).
7. If sign-in fails → diagnose via Vercel Runtime Logs + `[magic-link]`
   server-side error lines before spinning new council.
