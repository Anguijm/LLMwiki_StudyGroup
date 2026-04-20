# Plan: fix magic-link email template (PKCE `ConfirmationURL`, not `TokenHash`)

**Status:** draft, awaiting council + human approval.
**Branch:** `claude/plan-session-agenda-DWzNf`.
**Scope:** auth surface + institutional-knowledge correction — non-negotiable council run required.
**P0:** without this, no user can complete sign-in on production. PR #22 shipped a half-fix; the template side was wrong.

## Problem

Human smoke test on production (2026-04-21, Android Chrome + Gmail, same-device same-browser) bounces back to `/auth` with the generic "Could not sign you in right now" copy. Two consecutive attempts, both failed identically.

Evidence trail:

1. Vercel runtime log, `requestPath=/auth/callback`, level=error: `[auth/callback] sign-in failed { kind: 'server_error' }`. No preceding `[auth/callback] unexpected exchange failure` line → the try-block did not throw; `exchangeCodeForSession` returned a `{ error }` shape that fell through `mapSupabaseError`.
2. Supabase Dashboard Logs → Auth, same attempt: `/token | 404: invalid flow state, no valid flow state found`. This is the upstream error `mapSupabaseError` couldn't classify.
3. Both attempts produced `server_error`, not `token_used`. If Gmail prefetch had consumed the code the second click would have matched `invalid_grant` → `token_used`. It didn't. The failure is structural, not code-reuse.

## Root cause

PR #22 set both email templates (Confirm signup, Magic Link) to

```
{{ .SiteURL }}/auth/callback?code={{ .TokenHash }}
```

and documented this pattern as correct for PKCE in `.harness/learnings.md` 2026-04-20 18:20 UTC INSIGHT block and `README.md` §B.6.

**That template is the primitive for `supabase.auth.verifyOtp({ token_hash, type })`.** It is NOT the primitive for `supabase.auth.exchangeCodeForSession(code)`, which is what our callback at `apps/web/app/auth/callback/route.ts:159` calls.

Concretely:

- `{{ .TokenHash }}` is a hash of the OTP. No `auth.flow_state` row is keyed by it.
- `exchangeCodeForSession(code)` looks up a PKCE `flow_state` by the `code` argument. Receiving a `token_hash` instead of a PKCE `code` produces the exact "no valid flow state found" 404 we observed.

The PR #22 plan → council → merge loop never caught this because nobody clicked a live magic link end-to-end before merge. Dashboard screenshots were attached but no human sign-in smoke test preceded approval. The reflection review (PR #25 r1) caught two other mis-generalizations but did not verify the template claim against Supabase's PKCE docs.

## Fix (Supabase Dashboard + docs + learnings correction — zero Next.js code change)

The callback already does the right thing; the email link just needs to point at the right primitive. Supabase's default `{{ .ConfirmationURL }}` renders to `https://<project>.supabase.co/auth/v1/verify?token=<hash>&type=<type>&redirect_to=<our_callback>`. Supabase verifies the OTP, creates the PKCE `flow_state`, and redirects to `/auth/callback?code=<real_pkce_code>`. Our existing `exchangeCodeForSession(code)` then exchanges a real PKCE code against a real flow state — which is what the code was written for.

### A. Supabase Dashboard (manual, pre-merge)

1. **Auth → Email Templates → Magic Link:** replace the custom `{{ .SiteURL }}/auth/callback?code={{ .TokenHash }}` body link with Supabase's default that uses `{{ .ConfirmationURL }}`. Standard snippet:
   ```html
   <a href="{{ .ConfirmationURL }}">Log In</a>
   ```
2. **Auth → Email Templates → Confirm signup:** same change. Both templates are independent; both must be edited.
3. **Auth → URL Configuration → Redirect URLs allowlist:** confirm `https://llmwiki-study-group.vercel.app/auth/callback` + the preview wildcard are still present. `{{ .ConfirmationURL }}` uses `emailRedirectTo` as its `redirect_to`; an allowlist miss would 400 the verify step. No change expected, just verification.
4. Screenshot each of the three panes; attach to the PR body as pre-merge evidence. Keep the naming scheme PR #22 established.

### B. Human smoke test post-dashboard-change, pre-merge

The human performs real end-to-end sign-in scenarios on production. **This is a merge gate, not a post-merge check.** The class of bug this plan exists to fix is specifically the kind that unit tests and dashboard screenshots cannot catch.

Three scenarios, all required for merge (council bugs r1):

**B.1 — Happy path, same device, same browser.** Submit the magic-link form and click the link from the same device/browser. Pass criteria:

- `/auth/callback` returns 307 to `/` (not to `/auth?error=...`).
- Landing on `/` shows the authenticated surface (not a middleware bounce back to `/auth`).
- Supabase Dashboard → Logs → Auth shows `/token | request completed` with no 404 immediately after.

**B.2 — Stale link.** Submit the magic-link form twice in quick succession (same email). Click the FIRST link. Pass criteria:

- `/auth/callback` returns 307 to `/auth?error=token_used` (or, if Supabase invalidates by time rather than use, `?error=token_expired`).
- `/auth` renders the allowlisted copy for that kind — "This sign-in link has already been used. Request a new one." or "This sign-in link has expired. Request a new one." — never the raw query param.
- Supabase Dashboard → Logs → Auth shows the invalidation with an error message that `mapSupabaseError` recognizes (matches `/already.*used|consumed|used_otp|invalid_grant|expired/`).

**B.3 — Cross-device click (known-limitation test, not a pass/fail gate).** Submit the form on device A; click the link on device B with a different browser profile. **Expected outcome: `/auth?error=server_error`**, because PKCE with `@supabase/ssr` stores the code verifier as an `HttpOnly` cookie on device A; device B has no verifier, so `exchangeCodeForSession` fails with "no valid flow state found" — the same upstream error we're fixing for same-device today, just for a structural reason specific to cross-device.

This row is a **document-and-accept** test, not a revert trigger. Record the observed behavior in the PR body so the limitation is explicit. If cross-device sign-in is later deemed required, that's a separate plan (see Out-of-scope §Cross-device sign-in UX below).

**Council bugs r1 rebuttal (cross-device):** the bugs persona's r1 edge-case note expected cross-device to succeed and framed failure as "surprising device-binding." It is not surprising given our architecture — PKCE with cookie-stored verifier is device-bound by design, independently of Fix A. Fix A corrects the template-primitive mismatch; it does not change the verifier storage model. If council r2 persists on cross-device success being a requirement, the correct response is to escalate to a Fix B plan (switch callback to `verifyOtp({ token_hash, type })`, which does not require a device-local verifier) — not to claim Fix A will satisfy it.

If B.1 fails, revert the template changes and re-open the plan. If B.2 fails, the template fix is still valid but the error-kind regex at `callback/route.ts:101-105` needs extending — file a follow-up issue rather than blocking this PR. If B.3 fails in the unexpected direction (cross-device actually succeeds), that's information worth recording but does not block merge.

### C. Runbook correction — `README.md` §B.6

Rewrite the template instructions. Replace the `?code={{ .TokenHash }}` recipe with:

- Default template (`{{ .ConfirmationURL }}`) + `exchangeCodeForSession(code)` in the callback. ← What we do.
- Alternative (documented, not recommended for this repo): custom `?token_hash=&type=` template + `verifyOtp({ token_hash, type })`. Call out explicitly that the template choice binds the callback primitive — one implies the other, picking the wrong pair is the bug that landed this plan.

Link to Supabase's PKCE flow docs inline so a future operator can verify directly against upstream rather than trusting this file.

### D. Learnings correction — `.harness/learnings.md`

Append a new reflection entry dated today (2026-04-21) with KEEP / IMPROVE / INSIGHT / COUNCIL blocks covering:

- **KEEP:** human smoke test as a merge gate for auth changes. Supabase Dashboard Logs → Auth as a first-look diagnostic path. Plan-first protocol enabling this corrective PR to land through council rather than as a hot-fix.
- **IMPROVE:** PR #22 merged an auth fix without a live end-to-end sign-in. Dashboard screenshots are not a substitute for a single real click-through. Future auth-surface PRs include a human smoke test row in the test matrix and do not merge until it's checked.
- **INSIGHT:** the Supabase PKCE email-template choice binds the callback primitive. `{{ .ConfirmationURL }}` ↔ `exchangeCodeForSession(code)`. `?token_hash=&type=` ↔ `verifyOtp({ token_hash, type })`. Mixing pairs produces "no valid flow state found" at the `/token` endpoint with no client-visible diagnostic. Explicitly annotate the prior PR #22 INSIGHT block as superseded — do not silently edit the old entry; leave it visible so the correction trail survives.
- **COUNCIL:** this plan's rounds.

Also add a ground-truth-drift note: the PR #25 reflection review narrowed two insights against live code, but did not verify the template claim against Supabase docs. Knowledge-content review catches logic mis-generalizations; it doesn't catch upstream-fact errors unless the reviewer is asked to verify against upstream. Future persona reviews on auth content should explicitly instruct a docs cross-check.

### E. Mark prior PR #22 INSIGHT as superseded

In-place note on the 2026-04-20 18:20 UTC INSIGHT bullet about PKCE email templates. One line:

> **SUPERSEDED 2026-04-21:** the `?code={{ .TokenHash }}` template is for `verifyOtp`, not `exchangeCodeForSession`. See 2026-04-21 entry for the correction. Template was the root cause of the observed sign-in failure.

Don't delete the original text. Leaving the wrong claim visible with a correction pointer is how future agents learn the lesson rather than re-discovering it.

### F. Code-to-config anchor on the callback route

Add a top-of-file comment block to `apps/web/app/auth/callback/route.ts` that explicitly names the email-template dependency and points at `README.md` §B.6. Suggested wording (final text at execution time):

> This route assumes the Supabase "Magic Link" and "Confirm signup" email templates use the default `{{ .ConfirmationURL }}` body link. If either template is changed to the `?token_hash=&type=` form, `exchangeCodeForSession` below will fail with "no valid flow state found" and every sign-in will return `?error=server_error`. See `README.md` §B.6 for the template-vs-callback-primitive binding.

Rationale: the code and the dashboard config are tightly coupled; without an in-repo anchor a future maintainer changing the template can't know they're also changing the callback behavior. Council security r1 nice-to-have, elevated to execution step because the PR #22 → PR #27 chain is itself the proof that the coupling matters. One comment, zero runtime change.

## Out of scope for this PR

- **Playwright end-to-end smoke test (issue #20).** The ideal regression guard for this class of bug is a headless run that clicks a real link, but Playwright setup is non-trivial (Supabase test-user provisioning, email-capture fixture, CI secrets). Stays as issue #20; add a reference to this plan in that issue so the motivation survives.
- **Cross-device sign-in UX.** PKCE with `@supabase/ssr`'s cookie-stored verifier is device-bound by design: the user must click the magic link on the same device/browser that submitted the form. The B.3 smoke test row documents this explicitly. If cross-device sign-in becomes a product requirement, the options are (a) switch the callback to `verifyOtp({ token_hash, type })` with a custom `?token_hash=&type=` template (Fix B in this session's diagnosis — moves to a non-device-bound flow), (b) add a 6-digit OTP code path as an alternative sign-in method, or (c) migrate to a shared server-side verifier store keyed by email. Each is its own plan + council round. File as a new issue if prioritized; not in flight today.
- **`mapSupabaseError` regex extension** to classify "no valid flow state" as its own kind. Once the template is correct, this path is unreachable for a properly-configured project. If it fires again in prod it's a genuine server_error and the generic copy is correct.
- **Supabase-hosted `/auth/v1/verify` failure surfaces.** Council bugs r1 noted: if the allowlist is misconfigured or Supabase's verify endpoint 500s, the user lands on a Supabase-branded error page before ever reaching our app, and we have no hook to observe it. Not mitigable in our code without moving the OTP-verification step in-app (that's Fix B). Monitoring via Supabase Auth logs is the existing mitigation; no new instrumentation in this PR.
- **Issue #26** (transactional setAll + fail-open alerting) remains queued; separate surface, separate PR.
- **Terraform / Management API for dashboard state.** Council carry-out from PR #22. Would have prevented this regression but is a v1 workstream.
- Any v1 feature work.

## Test matrix

This plan is primarily a configuration + docs change. No new automated tests are added because the callback/route integration tests from PR #22 already cover the code path; the bug is upstream of the code. The smoke test in §B is the acceptance test.

| Step | Expected |
|---|---|
| Magic Link template rendered with a test send | Link URL starts with `https://<project>.supabase.co/auth/v1/verify?token=...&type=magiclink&redirect_to=...`, NOT `https://llmwiki-study-group.vercel.app/auth/callback?code=...` |
| Confirm signup template rendered with a test send | Same shape as above, `type=signup` |
| Click the Magic Link from a real inbox on the same device/browser as the form submission | 307 to `/auth/callback`, callback returns 307 to `/`, landing page shows authenticated surface |
| Supabase Dashboard Logs → Auth during the click | `/token \| request completed`, no 404 |
| Vercel runtime log during the click | No `[auth/callback] sign-in failed` line |
| Redirect URLs allowlist unchanged | Entry `https://llmwiki-study-group.vercel.app/auth/callback` present; preview wildcard present |

## Rollback

Revert the template changes in the Supabase Dashboard (restore `?code={{ .TokenHash }}` form). User returns to the observed broken state. Revert the README and learnings commits via `git revert`. No schema, RLS, code, or dependency changes to undo.

## Non-negotiables (inherited + this plan)

Inherited:

- **RLS unchanged.** Anon key only; no service-role exposure.
- **No logging** of `code` or session tokens in any branch. The callback at `apps/web/app/auth/callback/route.ts:175-180` already redacts.
- **Redirect URLs allowlist** unchanged; APP_BASE_URL-only server policy from PR #17 stands.
- **Error surfacing** on `/auth` — no silent redirect. Unchanged; we're not touching the error rendering surface.
- **Council required.** No `[skip council]` under any framing. The CLAUDE.md institutional-knowledge clause means `learnings.md` and `README.md` edits route through council even when there is no code diff.

Added by this plan:

- **[product]** Human smoke test is a merge gate for this PR. No merge without the §B pass criteria in the PR body.
- **[product]** Dashboard screenshots attached pre-merge (both templates + URL configuration).
- **[institutional knowledge]** Prior PR #22 INSIGHT block annotated as superseded, not deleted. Correction trail survives.
- **[institutional knowledge]** New reflection entry records the `{{ .ConfirmationURL }}` ↔ `exchangeCodeForSession` / `?token_hash` ↔ `verifyOtp` binding so future sessions can't mix the pairs.

## Success + kill criteria

- **Success metric:** first human sign-in on production completes 302 → `/` with a valid session. Follow-on: the 24h callback-error rate from the shipped logging drops to the Vercel-noise floor (< 1% of attempts).
- **Failure metric:** same log-derived callback-error rate. If > 5% 24h post-merge, revert the template changes and re-open this plan.
- **Cost:** $0 marginal. Supabase Auth is MAU-billed; this plan does not change volume.

## Council history

- **r1** (PR #27 @ commit `af9c3ba`, 2026-04-20T20:27:50Z) — PROCEED, a11y 9 / arch 10 / bugs 9 / cost 10 / product 10 / security 9. Folded: expanded smoke test matrix (B.1 same-device happy path, B.2 stale-link error copy, B.3 cross-device document-and-accept), §F code-to-config anchor comment on the callback route, new out-of-scope lines for cross-device UX and Supabase `/verify` failure surfaces. Rebutted in plan: bugs persona's r1 cross-device expectation — PKCE with cookie-stored verifier is device-bound by design; Fix A does not change that. Escalation path documented (Fix B / OTP codes) if cross-device becomes required.
- Awaiting r2.

## Approval checklist (CLAUDE.md gate)

Before any implementation work (dashboard edits count as implementation), all three must be true:

1. This file is committed on `claude/plan-session-agenda-DWzNf` and pushed to origin.
2. A PR is open against `main`; the latest `<!-- council-report -->` comment from `.github/workflows/council.yml` was posted against a commit SHA ≥ the commit that last modified this plan.
3. The human has typed an explicit `approved` / `ship it` / `proceed` after seeing (1) and (2).

If any gate fails, stop and surface the gap.
