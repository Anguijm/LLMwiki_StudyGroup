# Auto-PR-watcher GitHub Action — REVISED per council (2026-04-17)

## Status

Original plan scored: accessibility 10, architecture 10, cost 9, security 5, bugs 3, product 1. Lead Architect verdict: **REVISE**. This plan is the revision approved by the human on 2026-04-17.

## What changed from v1

- **Watcher is now read-only.** `contents: write` → `contents: read`. No `Edit`, no `Write`, no `Bash(git:*)`. The watcher writes GitHub suggestion blocks in review comments; the human taps "Commit suggestion" to apply.
- **Third-party action pinned.** `anthropics/claude-code-action@v1` → `anthropics/claude-code-action@496f0537244eccbaa9b0eeff94084c64e1fe6a56` (SHA for current v1). Supply-chain guard.
- **`check_suite` trigger added.** The watcher now triggers on failed CI check suites, matching the original promise (Codex P2).
- **`@claude` matching is case-insensitive.** Was `startsWith('@claude')`; now includes `@Claude` variant (bugs persona flag).
- **`issue_comment` checkout bug fixed.** Was falling back to `github.ref` (base branch); now resolves PR number first and calls `gh pr checkout <number>` (Codex P1).
- **Self-recursion guard.** Workflow now skips when `github.actor == 'github-actions[bot]'` so watcher can't react to its own comments.
- **`log_pr_watch.sh` deleted.** It did a read-modify-write on `session_state.json` and push-back, both of which are now unnecessary (no CI commits) and were racy (bugs persona).
- **Error suppression removed from council.yml.** `|| echo warning` and `|| true` patterns gone; script failures now fail the job visibly.
- **Council action gains a monthly cap.** New `.harness/scripts/council_budget.py` mirrors the watcher's budget, default 60 runs/month, configurable via env (cost persona).

## Files touched

- **New:** `.harness/scripts/council_budget.py`.
- **Rewritten:** `.github/workflows/pr-watch.yml`, `.github/claude-pr-watcher-prompt.md`.
- **Edited:** `.github/workflows/council.yml`, `.harness/README.md`, `.harness/learnings.md`.
- **Deleted:** `.harness/scripts/log_pr_watch.sh`.
- **Unchanged:** application code (still zero), `CLAUDE.md`, `.harness/council/*.md`, `.harness/scripts/council.py`.

## Explicitly out of scope this round

- Unit tests for `council.py` (architecture persona suggested this; deferring — it's a medium refactor and not a blocker).
- Slack/Discord alerts when the watcher responds (security persona nice-to-have; deferring).
- Formal DPA with Anthropic/Google (security nice-to-have; deferring — acknowledged risk).
- Changes to the Gemini council's persona library or scoring rubric.

## Verification plan

- [ ] `PR_WATCHER_ENABLED` unset → watcher skips all events (already confirmed on PR #3 current state).
- [ ] Set `PR_WATCHER_ENABLED=true` on a throwaway test PR → watcher reacts to Codex comment with a suggestion block (no commit).
- [ ] `@Claude` (capital C) in a PR comment → watcher still reacts.
- [ ] Trigger a CI failure → watcher runs on the `check_suite.completed` event.
- [ ] `council.py` deliberately made to exit 1 → council workflow job fails visibly (not silently warning).
- [ ] Monthly cap: seed `yolo_log.jsonl` with 60 fake `council_run` entries this month → workflow skips with an explanatory comment.
- [ ] No `.harness/session_state.json` or `.harness/yolo_log.jsonl` commits from CI appear on the PR branch.

## Approval

Council-reviewed on 2026-04-17 (scores above). Human approved the demotion path after comparing trade-offs vs. full-kill. Recording the trail in `.harness/learnings.md` for the audit chain.
