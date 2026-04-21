# PR #27 pre-merge evidence

Human smoke-test screenshots + Supabase dashboard edits for the magic-link
template fix (`{{ .TokenHash }}` → `{{ .ConfirmationURL }}`). All screenshots
captured 2026-04-22 on Android Chrome.

## Dashboard edits (§A)

- **01-template-magic-link.jpg** — Supabase → Auth → Email Templates →
  Magic Link. Body source shows `<a href="{{ .ConfirmationURL }}">Log In</a>`
  with the "Successfully updated email template" confirmation toast.
- **02-template-confirm-signup.jpg** — same surgery on the Confirm signup
  template. Body source + save-confirmation toast.
- **03-redirect-urls-allowlist.jpg** — Auth → URL Configuration → Redirect
  URLs. Both entries present: `https://llmwiki-study-group.vercel.app/auth/callback`
  and the preview wildcard `https://llmwiki-study-group-*.vercel.app/auth/callback`
  (wildcard correctly in the subdomain, not after `.vercel.app`). No changes
  made here; screenshot confirms no drift from PR #22.

## Smoke test B.1 (§B.1) — happy path, same-device → PASS

- **04-smoke-b1-vercel-logs.jpg** — Vercel runtime log, 2026-04-22 04:26 UTC:
  `POST /api/auth/magic-link 200` → `GET /auth/callback 307` → `GET / 200`.
  No `[auth/callback] sign-in failed` line anywhere in the trace.
- **05-smoke-b1-supabase-auth-logs.jpg** — Supabase Logs → Auth, same
  04:26 UTC window. Full PKCE round-trip: `/otp request completed` →
  `mail.send` → `/verify request completed` → `Login` → `/token request
  completed` → `/user request completed`. Zero `/token | 404 invalid flow
  state` entries (the PR #22 regression signature).
- **06-smoke-b1-authenticated-dashboard.jpg** — post-sign-in landing page.
  "LLM Wiki · Study Group" with Upload PDF, Your notes, and Recent ingestion
  jobs surfaces rendered. Session cookie persisted; the callback redirect
  to `/` was served the authenticated dashboard (not a middleware bounce
  back to `/auth`).

## Smoke test B.2 (§B.2) — stale link → classification gap documented

- **07-smoke-b2-auth-page-error-copy.jpg** — `/auth` after re-clicking a
  consumed magic link. Visible copy: **"Could not sign you in right now.
  Please try again."** This is the `server_error` allowlisted message,
  NOT the expected `token_used` / `token_expired` copy.
- **08-smoke-b2-supabase-auth-logs.jpg** — Supabase Logs → Auth during B.2
  at 04:36–04:37 UTC. Shows: first `/otp` + `mail.send`, second `/otp`
  hitting Supabase's own per-email 60s lockout (`429: For security
  purposes...`), then `/verify request completed` (first click) followed
  by `/verify 403: Email link is ...` (re-click on the consumed link).

**Disposition:** template fix is valid (B.1 is clean proof); B.2's
classification deviation from `token_used`/`token_expired` to
`server_error` is the exact follow-up carry-out the plan §B permits as
a non-blocker. The `mapSupabaseError` regex at `apps/web/app/auth/callback/route.ts:101-105`
does not match Supabase's `/verify` 403 "Email link is invalid or has
expired" wording (or the alternate redirect path Supabase uses for that
failure). Filed as a follow-up issue after merge.

## B.3 — not executed

Per plan §B.3, cross-device is a document-and-accept test, not a merge
gate. Not executed in this smoke run. Accepted as architectural
limitation: PKCE with `@supabase/ssr`'s cookie-stored verifier is
device-bound by design; cross-device sign-in would require either
switching the callback to `verifyOtp({ token_hash, type })` (Fix B,
future work) or adding a 6-digit OTP code path.
