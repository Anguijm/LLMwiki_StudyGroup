# Auto-PR-watcher GitHub Action

## Goal

Every PR opened on `anguijm/LLMwiki_StudyGroup` gets Claude as a persistent reviewer. Claude reads Codex review comments and CI failures, investigates each, and either:
1. Pushes a fix commit when confident and in-scope, or
2. Leaves a PR comment explaining why no action, or
3. Escalates to the human via PR comment when ambiguous or out-of-scope.

This is the repo-side automation equivalent of the local `subscribe_pr_activity` tool — durable, runs without a Claude Code session attached, triggered by GitHub webhooks.

## Motivation & boundaries

- **Not a replacement for the Gemini council.** The Gemini council is a *pre-plan* advisor run by the developer before code is written. This watcher is *post-PR triage* — it reacts to signals on PRs already in flight. Different axes; they don't overlap.
- **Not a replacement for human approval.** Merges, force-pushes, dependency changes, auth/RLS edits, and CLAUDE.md/council edits stay human-only.
- **Must respect the circuit breaker.** If `.harness_halt` exists on the PR branch at checkout, the workflow exits early with a comment referencing the halt reason.
- **Must feed the durable session state.** Every run appends a `{event: "pr_watch_run", pr, trigger, actions_taken}` line to `.harness/yolo_log.jsonl` on the PR branch.

## Trigger events

- `pull_request`: `opened`, `synchronize`, `reopened` (for first-pass review + rerun after new commits)
- `pull_request_review_comment`: `created` (for Codex review comments specifically)
- `pull_request_review`: `submitted` (for batch review summaries)
- `issue_comment`: `created` (so `@claude` mentions in PR conversation route to the watcher)
- `check_suite`: `completed` (only when `conclusion == "failure"`, to trigger CI-failure triage)

Skip `push` and `pull_request_target` — too broad, security risk on fork PRs.

## Secrets & auth

- **`ANTHROPIC_API_KEY`** — repo-scoped secret the user adds manually at *Settings → Secrets and variables → Actions → New repository secret*. User-owned GitHub accounts can't share secrets across repos; the value must be copied from whichever other repo already has it. The plan does not commit the key, does not log it, does not reference it outside the workflow env.
- **`GITHUB_TOKEN`** — auto-provided per-run by GitHub Actions. Scoped via the workflow's `permissions:` block; never extended beyond what's needed.

## Permissions (workflow-level, least-privilege)

```yaml
permissions:
  contents: write         # push fix commits to PR branch
  pull-requests: write    # comment, request changes, dismiss reviews
  issues: write           # reply to issue_comment events
  checks: read            # inspect failed check runs
```

No `actions: write`, no `packages:`, no `id-token`.

## Files to create

### 1. `.github/workflows/pr-watch.yml`

- Uses `anthropics/claude-code-action@v1` (pinned to a major) as the core.
- `concurrency` group `pr-watch-${{ github.event.pull_request.number || github.event.issue.number }}` with `cancel-in-progress: true` so rapid-fire events collapse.
- `timeout-minutes: 15` per run.
- Explicit `if:` gates:
  - For `issue_comment`: only run if `github.event.issue.pull_request != null` *and* the comment body starts with `@claude` (case-insensitive).
  - For `pull_request_review_comment`: only run if the commenter is `chatgpt-codex-connector[bot]` *or* contains `@claude`.
  - For `check_suite`: only run if `github.event.check_suite.conclusion == 'failure'` *and* the suite is attached to an open PR.
- Steps:
  1. Halt check — `if [ -f .harness_halt ]; then gh pr comment --body "Halt file present..."; exit 0; fi`
  2. `claude-code-action` run with a system prompt loaded from `.github/claude-pr-watcher-prompt.md` (so the scope policy lives in a reviewable file, not buried in YAML).
  3. Append to `.harness/yolo_log.jsonl` and commit if the action left changes.

### 2. `.github/claude-pr-watcher-prompt.md`

System prompt for `claude-code-action`, containing the full scope policy below. Lives in its own file so changes to agent behavior get a diff in review and can be council-reviewed.

### 3. `.harness/README.md` — append a "PR watcher" section

One short paragraph pointing at the workflow and the prompt file, noting the `ANTHROPIC_API_KEY` setup step.

## Scope policy (embedded in `claude-pr-watcher-prompt.md`)

**Claude is allowed to autonomously:**
- Edit files under `.harness/` except `.harness/council/*.md` and `CLAUDE.md`.
- Fix failing `npm run lint`, `npm run typecheck`, `npm test` runs when the fix is localized and obvious.
- Respond to Codex `P1`/`P2`/`P3` review comments with either a fix commit or a PR comment explaining why the suggestion was declined.
- Push commits to the PR branch (never `main`, never force-push, never amend).
- Leave PR review comments and issue comments.

**Claude must ask the human (leave a comment, do not act) for:**
- Any edit to `CLAUDE.md`, `.harness/council/*.md`, or `.harness/scripts/council.py` (the system that watches itself — explicit guardrail against drift).
- RLS policy changes or Supabase migrations.
- Adding/removing/upgrading runtime dependencies in `package.json`.
- Auth, secret, or CSP surface changes.
- Changes to `.github/workflows/*` (the watcher should not edit its own workflow).
- Any change > 200 LOC or touching > 10 files.
- Codex `P0` or `critical`-tagged comments.

**Claude must never:**
- Merge PRs.
- Force-push.
- Amend existing commits.
- Disable hooks (`--no-verify`).
- Push to `main`, `master`, or any protected branch.
- Run destructive git operations.
- Commit secrets or tokens, even from `GITHUB_TOKEN` context.

## Cost posture

- Default model: **Claude Haiku 4.5** for routine triage. Haiku handles Codex P2/P3 suggestions and lint fixes well and is ~5× cheaper than Sonnet.
- Escalation model: **Claude Sonnet 4.6** only when the prompt-level `escalate: true` flag fires (Codex P0/P1, CI failure spanning multiple files, ambiguous-intent comments). The prompt file documents the escalation rule.
- Opus is not used by the watcher — Opus is reserved for the human's local development sessions.
- **Monthly budget**: cap the workflow at ~150 runs/month via a `scripts/pr_watcher_budget.py` pre-flight that reads `.harness/yolo_log.jsonl`, counts this month's `pr_watch_run` events, and exits 0 early with a PR comment if over budget. Target cost with Haiku: ~$3–6/month.

## Durability integration

- Every run appends a line to `.harness/yolo_log.jsonl` with fields: `{ts, event: "pr_watch_run", pr, trigger, model, actions_taken, tokens_in, tokens_out, cost_estimate}`.
- That append happens in the workflow after the Claude step, whether or not Claude made code changes.
- `.harness/session_state.json`'s `last_pr_watch` block gets updated with `{pr, ts, actions_taken}` on every run — mirroring the `last_council` block.
- The existing `post-commit` hook already logs the commits Claude pushes, so the audit chain is: `pr_watch_run` → `commit` → next `pr_watch_run`.

## Verification

- [ ] Push a PR with a deliberate lint error; watcher triggers, fixes it, commits, comments.
- [ ] Open a PR, add a `@claude` comment asking a question; watcher responds without code changes.
- [ ] Post a `@claude` comment from a non-owner account (use a test fork) — watcher refuses politely.
- [ ] Touch `.harness_halt` on a branch; watcher skips with a halt comment.
- [ ] Simulate a cost-cap breach by seeding `yolo_log.jsonl` with fake `pr_watch_run` entries; watcher skips.
- [ ] Codex P1 comment arrives on a PR; watcher fixes and pushes; Codex re-review passes.
- [ ] Watcher attempts to edit `CLAUDE.md` (test by giving it a prompt that implies it should); refuses and comments.
- [ ] `yolo_log.jsonl` and `session_state.json` show the run in a downstream commit.

## Out of scope

- Auto-merging PRs.
- Review comments on commits outside PRs.
- Opening PRs proactively for features the user didn't request.
- Changes to the local Gemini council.
- Changes to `CLAUDE.md` or the circuit-breaker file.
- Monitoring of the `main` branch directly (the watcher is PR-only).
- Organization migration (required if we ever want to share `ANTHROPIC_API_KEY` across `anguijm/*` repos — deferred as separate decision).

## Open questions for the council

1. **Self-modifying-system risk.** The watcher can edit files under `.harness/` except the explicitly-excluded ones. Is the exclusion list tight enough, or should `.harness/` be entirely read-only to the watcher? Trade-off: read-only prevents it from adding entries to `yolo_log.jsonl`, which is the whole audit trail.
2. **Codex-comment allowlist.** Right now the watcher reacts to any review comment from `chatgpt-codex-connector[bot]`. Should it also react to comments from humans marked with a specific emoji or label? Risk of expanding the trigger surface.
3. **Model choice.** Haiku 4.5 for triage — acceptable for cost, but does it have enough judgment to know when to escalate? Worth a trial run against historical PRs first?
4. **Concurrency and race conditions.** Two rapid events (e.g. Codex comment + CI failure on the same commit) could race. The `cancel-in-progress` concurrency group handles it, but the cancelled run might have partially pushed. Verification item 7 covers this, but worth council scrutiny.
5. **PR-branch as append target.** The watcher pushes `yolo_log.jsonl` updates to the PR branch. After merge, the `main` branch gets those entries. Is that the right place, or should `yolo_log.jsonl` be branch-protected and updates batched post-merge? The current design prioritizes audit-trail-always-on over branch cleanliness.
