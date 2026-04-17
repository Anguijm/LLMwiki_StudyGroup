# Auto-PR-watcher GitHub Action — v5 (council-round-4 polish, MERGE-READY)

## Status

- Round 1: product 1, security 5, bugs 3. REVISE.
- Round 2: product 2, security 4, bugs 4. REVISE.
- Round 3: product 2, security 7, bugs 5. REVISE.
- Round 4: (product muted), security 9, bugs 6, arch 10, cost 10, a11y 7. **PROCEED** — "ready for human approval."
- Human direction this round: "1–6 then merge."

## Round-4 fixes (v5)

- **Prompt hardened** (security non-negotiable 1): `claude-pr-watcher-prompt.md` now mandates every `suggestion` block be prefixed with a warning asking the human to security-review AI-suggested code before accepting. Backstop against prompt-injection-to-commit-suggestion via a sloppy reviewer.
- **`--allow-untracked` forbidden in CI** (security non-negotiable 2): Comment added in `council.yml` at the `council.py` invocation explaining exactly why the flag is a CI footgun (would let attacker-controlled PRs "approve" untracked plans, bypassing the tracked-plan gate in CLAUDE.md).
- **Concurrency group fallback** (bug): `pr-watch.yml` now falls back to `github.run_id` when `check_suite.pull_requests[0].number` is empty. Prevents non-PR check_suite events from sharing the group "pr-watch-" and cancelling each other.
- **Halt comment shell-safe** (bug): Both workflows now use `--body-file` (via `mktemp` + `printf`) instead of `--body "..."` when posting the halt reason. Neutralizes shell metacharacters in `.harness_halt` content.
- **Budget counter numeric validation** (bug): Both workflows validate `.budget/count` is `^[0-9]+$` before arithmetic. Corrupted or truncated cache values fall back to 0 with a GitHub Actions warning.
- **Tracking issue for product restoration**: Issue #4 opened with a 7-day kill switch (restore or disable the watchers).

## Files touched (v5)

- **Edited:** `.github/workflows/pr-watch.yml`, `.github/workflows/council.yml`, `.github/claude-pr-watcher-prompt.md`.
- **New (GitHub):** Issue #4 to track `product.md` restoration.
- **Unchanged:** council.py, CLAUDE.md, .gitleaks.toml, personas.

## Explicitly still out of scope (accepted debt)

- Unit tests for `council.py` `_plan_is_tracked` / `_plan_has_unstaged_changes`. Council mentions these; Lead Architect called them non-blocking.
- i18n of PR-comment status messages.
- Slack/Discord alerts when watcher responds.
- Formal DPA with Anthropic/Google.
- CodeQL workflow (security nice-to-have, separate scope).
- Atomic budget counter (TOCTOU race accepted per cost tradeoff).

## Verification (post-merge)

- [ ] Issue #4 tracks product.md restoration; resolve in ≤7 days.
- [ ] First green council run against main after merge → all scores ≥ 6 (product restored).
- [ ] Enable watcher for one test PR (`PR_WATCHER_ENABLED=true`); confirm the warning footer shows on any suggestion block it posts.
- [ ] `.harness_halt` test with `test "$(reboot)"` content → halt comment renders the literal string.
- [ ] Seed `.budget/count` with `abc` → workflow warns and proceeds with 0.

## Audit trail

- Round 1 report: PR #3 comment, 2026-04-17T01:15:34Z. REVISE.
- Round 2 report: same, 2026-04-17T03:10:15Z. REVISE.
- Round 3 report: same, 2026-04-17T03:31:55Z. REVISE.
- Round 4 report: same, 2026-04-17T04:04:39Z. **PROCEED**.
- Human decisions: "demotion" → "override veto, fix everything" → "fix all four, mute product" → "1–6 then merge".
