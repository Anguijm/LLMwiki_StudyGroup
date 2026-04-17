# Auto-PR-watcher GitHub Action — v3 (council-round-2 fixes)

## Status

- Round 1 council (plan-time): product 1, security 5, bugs 3. Verdict REVISE → demoted watcher to read-only, pinned action to SHA, added `check_suite`, fixed checkout/case-sensitivity.
- Round 2 council (post-implementation diff): product 2, security 4, bugs 4, cost 10. Verdict REVISE with Product veto.
- Human override (2026-04-17): "override veto, fix everything."

## Round-2 fixes in this commit

- **Denial-of-Wallet fixed.** File-based `yolo_log.jsonl` budget scripts replaced with GitHub Actions cache. A PR can no longer modify the budget counter — state lives outside the repo in the Actions cache namespace. TOCTOU race acknowledged as accepted tradeoff per council.
- **Concurrency group unified.** `pr-watch.yml` now keys concurrency on the PR number for every trigger type (was mixing PR number and `check_suite.id`, which allowed two parallel runs for the same logical change).
- **Case-insensitive `[skip council]`.** `council.yml` now lowercases the PR title before matching, so `[Skip Council]` / `[SKIP COUNCIL]` also skip.
- **Model ID documented.** `claude-haiku-4-5-20251001` is correct per Anthropic's 2025-10-01 dated release of Haiku 4.5 (verified against the model registry). Added inline comment explaining the pin and pointing at `model-upgrade-audit.md` for upgrades.

## Files touched (v3)

- **Rewritten:** `.github/workflows/pr-watch.yml`, `.github/workflows/council.yml`.
- **Deleted:** `.harness/scripts/pr_watcher_budget.py`, `.harness/scripts/council_budget.py`. Both obsoleted by cache-based budget.
- **Edited:** `.harness/README.md` (remove budget scripts from file map, note cache-based state).
- **Unchanged:** prompt file, personas, council.py, CLAUDE.md.

## Explicitly still out of scope

- `council.py` unit-test refactor.
- Slack/Discord alerts.
- Formal DPA with third-party LLM providers.
- Secret-scanning step pre-LLM-call (council nice-to-have; not in the critical path).
- Tightening `gh api:*GET*` to a specific endpoint allowlist (council nice-to-have).

## Verification

- [ ] `PR_WATCHER_ENABLED` unset → watcher skips (current state on PR #3).
- [ ] First pr-watch run → cache miss, count starts at 0 → 1 → save.
- [ ] Second run → cache restore hits → count reads 1 → 2 → save.
- [ ] Seed cache with count=150 via a throwaway run, subsequent run over-budget-skips with a PR comment.
- [ ] PR title `[Skip Council]` / `[SKIP COUNCIL]` → council job body skips (no Gemini calls, no comment).
- [ ] Rapid events fire both `pull_request:synchronize` and `check_suite:completed` for the same PR → only one watcher run proceeds (the other is cancelled by the shared concurrency group).

## Audit trail

- Council round 1 report: PR #3 comment marker `<!-- council-report -->`, dated 2026-04-17T01:15:34Z.
- Council round 2 report: same comment, edited in place, dated 2026-04-17T03:10:15Z.
- Human decisions: "demotion" (round 1), "override veto, fix everything" (round 2). Both in chat transcript.
