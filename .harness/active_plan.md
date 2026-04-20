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

The human performs a real end-to-end sign-in on production (magic link to real inbox, click from the same device/browser, confirm redirect to `/` with a session cookie). **This is a merge gate, not a post-merge check.** The class of bug this plan exists to fix is specifically the kind that unit tests and dashboard screenshots cannot catch.

Pass criteria:

- `/auth/callback` returns 307 to `/` (not to `/auth?error=...`).
- Landing on `/` shows the authenticated surface (not a middleware bounce back to `/auth`).
- Supabase Dashboard → Logs → Auth shows `/token | request completed` with no 404 immediately after.

If any of the three fail, revert the template changes, re-open the plan.

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

## Out of scope for this PR

- **Playwright end-to-end smoke test (issue #20).** The ideal regression guard for this class of bug is a headless run that clicks a real link, but Playwright setup is non-trivial (Supabase test-user provisioning, email-capture fixture, CI secrets). Stays as issue #20; add a reference to this plan in that issue so the motivation survives.
- **`mapSupabaseError` regex extension** to classify "no valid flow state" as its own kind. Once the template is correct, this path is unreachable for a properly-configured project. If it fires again in prod it's a genuine server_error and the generic copy is correct.
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

- Awaiting r1.

## Approval checklist (CLAUDE.md gate)

Before any implementation work (dashboard edits count as implementation), all three must be true:

1. This file is committed on `claude/plan-session-agenda-DWzNf` and pushed to origin.
2. A PR is open against `main`; the latest `<!-- council-report -->` comment from `.github/workflows/council.yml` was posted against a commit SHA ≥ the commit that last modified this plan.
3. The human has typed an explicit `approved` / `ship it` / `proceed` after seeing (1) and (2).

If any gate fails, stop and surface the gap.
