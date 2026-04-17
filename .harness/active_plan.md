# Auto-PR-watcher GitHub Action — v4 (council-round-3 fixes)

## Status

- Round 1: product 1, security 5, bugs 3. Demotion + SHA pin + checkout fix.
- Round 2: product 2, security 4, bugs 4. Cache budgets + concurrency + case-insensitive skip.
- Round 3: product 2, security 7, bugs 5. Verdict REVISE with one non-negotiable (secret scan).
- Human override: "Fix all four. Mute product for this next run."

## Round-3 fixes

- **Secret-scan step before LLM calls** (security non-negotiable): `gitleaks/gitleaks-action@dcedce43c6f43de0b836d1fe38946645c9c638dc` added in both `pr-watch.yml` and `council.yml`, immediately after checkout and before the LLM call. If gitleaks flags a key/PII in the PR diff, the workflow fails and the LLM step never runs. Config in `.gitleaks.toml` extends the default ruleset and allowlists docs/persona files that mention placeholder keys.
- **Budget-gated on success** (bug): `pr-watch.yml` now gates the increment + save steps on `steps.claude-watcher.outcome == 'success'`. Previous version consumed budget even when tool runs failed.
- **Case-insensitive `@claude`** (bug): Replaced the `if:`-level string match with a shell step using `${BODY,,}`. `@claude`, `@Claude`, `@CLAUDE`, `@ClauDe` all match. Coarse `if:` now only filters on event type + actor.
- **Tightened tool allowlist** (security): `Bash(gh api:*GET*)` removed entirely. Agent has `gh pr view|diff|comment|review` which cover the supported use cases; anything else requires asking the human.

## Product muted

- Per human direction, `.harness/council/product.md` renamed to `product.md.disabled` for this one round. Council runner skips anything not ending in `.md`. **Rename it back** after the next successful round to restore the feedback loop. Tracked in verification checklist.

## Files touched (v4)

- **New:** `.gitleaks.toml`.
- **Edited:** `.github/workflows/pr-watch.yml`, `.github/workflows/council.yml`, `.harness/scripts/security_checklist.md`.
- **Renamed:** `.harness/council/product.md` → `product.md.disabled` (temporary).
- **Unchanged:** prompt file, council.py, CLAUDE.md.

## Explicitly still out of scope

- `council.py` mockable git helpers (architecture persona nice-to-have).
- Slack/Discord alerts.
- Formal DPA with third-party LLM providers.
- i18n of status messages (accessibility nice-to-have).

## Verification

- [ ] `PR_WATCHER_ENABLED` unset → watcher skips (current state).
- [ ] `@CLAUDE` in a PR comment → watcher fires.
- [ ] PR with a fake `sk-ant-example` string outside the allowlisted files → gitleaks fails the workflow, no LLM call made.
- [ ] PR that triggers the watcher but `npm run lint` fails → budget counter **not** incremented on subsequent runs.
- [ ] `[Skip Council]` in PR title → council job body skips.
- [ ] **Restore `product.md`** (`git mv product.md.disabled product.md`) after the next green council round. Do NOT leave product muted long-term.

## Audit trail

- Round 1 report: PR #3 comment `<!-- council-report -->`, 2026-04-17T01:15:34Z.
- Round 2 report: same comment, updated 2026-04-17T03:10:15Z.
- Round 3 report: same comment, updated 2026-04-17T03:31:55Z.
- Human decisions: "demotion" (r1), "override veto, fix everything" (r2), "fix all four, mute product for next run" (r3).
