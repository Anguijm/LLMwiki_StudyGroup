# Learnings

Append-only knowledge base. Every completed task ends with a block below. Do not rewrite history; add new entries.

## Block format

```
## <YYYY-MM-DD HH:MM UTC> — <task title>
### KEEP
- <what worked; pattern worth repeating>
### IMPROVE
- <what to change next time>
### INSIGHT
- <non-obvious thing worth remembering; architecture lesson, cost gotcha, a user-truth, etc.>
### COUNCIL
- <notable feedback from the Gemini council run, if any; link to .harness/last_council.md snapshot if useful>
```

Keep each bullet tight. The goal is fast recall for the next session, not a blog post.

---

## 2026-04-16 — harness scaffolding landed
### KEEP
- Personas-as-files pattern from harness-cli lets the council stay version-controlled and PR-reviewable.
- Durable session split — human-readable `learnings.md`, machine-readable `session_state.json`, immutable `yolo_log.jsonl` — mirrors yolo-projects and holds up.
- Local-only Gemini runner avoids GitHub-secret rotation overhead and keeps council output out of PR comment noise.
### IMPROVE
- Quality gates deferred until Next.js scaffolding exists; revisit after the first few real commits.
- Post-commit hook only captures commit metadata; could later also summarize the diff via Haiku if cost allows.
### INSIGHT
- yolo-projects ships 210+ single-file HTML apps, so its tick/tock cron made sense there; here we are *one* complex app, so the hourly-propose pattern is a trap. Kept the council, dropped the cron.
- Cost cap of 15 Gemini calls per council run is a hard safety net, not a target — normal runs will use 7 (6 angles + Lead Architect).
### COUNCIL
- Not yet run. First invocation will be against the kickoff prompt once the user provides it.

## 2026-04-17 — PR-time Council action + post-mortem on chat-summary "approval"

### KEEP
- Override clause in CLAUDE.md (`override council: <reason>`) genuinely is the right escape hatch — used it for bootstrapping the council automation itself, the chicken-and-egg case the rule is designed for.
- `RequestBudget` (council.py) carried over cleanly into the CI environment. Same script, same cap, same audit shape.
- PR-comment dedup via marker comment + `gh api PATCH` keeps PR threads clean across many pushes.

### IMPROVE
- Earlier in this same task I gitignored `.harness/active_plan.md` "to keep the working dir clean." That made the plan invisible to the human's Codespace, which made the council unrunnable, which made me fall back on chat-summary approval. The fix (CLAUDE.md "What counts as approval" rule + council.py untracked-plan guard) is in place; remember the failure mode: **artifacts that govern decisions must travel with the repo, not just the agent's tree.**
- I shipped the PR-watcher prompt and workflow before realizing the local-only council decision had created friction for a phone-based developer. Should have re-questioned the trigger decision the moment "phone + Codespaces" became the user's reality.

### INSIGHT
- For a phone-based, Codespace-driven workflow, "local only" isn't actually local — it's "wherever the developer happens to be." The right primitive is "can run anywhere the secret is" not "must run on a developer machine." Codespace secret + GH Action secret cover the actual usage shape.
- The two PR-time actions (Council + Watcher) are complementary, not redundant: Council critiques *before* code lands (advisory), Watcher acts *after* code lands (executive). Same PR can use both safely.

### COUNCIL
- No council run for this change — explicit `override council: bootstrapping the council automation` from the human. Future Council action runs will retroactively review subsequent PRs that touch this workflow.

## 2026-04-17 — Council-driven demotion of PR watcher

### KEEP
- Ran the PR-time Gemini council action against its own PR. It worked: Product scored 1/10 for the watcher and flagged maintenance overhead as a kill concern; Security (5/10) flagged `contents: write` + unpinned action as unacceptable prompt-injection + supply-chain surface; Bugs (3/10) caught a race condition in `log_pr_watch.sh` and a wrong-branch checkout on `issue_comment`. That's exactly the value proposition — catching decisions the human alone would have shipped.
- Codex review on the same PR independently flagged the `issue_comment` checkout bug (P1) and the missing `check_suite` trigger (P2). Two independent reviewers agreeing on a bug is strong signal.
- Using `AskUserQuestion` to surface the "scope pivot" decision to the human, rather than picking one autonomously, was the right move.

### IMPROVE
- The first council run cost $0 because the key was missing and the action bailed early with a PR comment. That fail-loud-early path saved money, worth keeping.
- `log_pr_watch.sh` existed only because the watcher had `contents: write` and needed a durable log. When the permission went away, the script went away. Lesson: audit scripts for orphaned dependencies after any scope change.

### INSIGHT
- For a solo developer on a phone, "autonomous agent commits fixes directly to the PR branch" sounds appealing but buys very little over "agent suggests a commit you tap to accept." The tap cost is tiny; the security surface is not. Defer automation until the cost of *not* automating is real.
- The Product persona being willing to score a 1/10 is the whole reason to have it. A council where every persona scores 7+ on every plan is a rubber stamp.
- Pinning third-party actions to commit SHAs is a free-ish win (one-time lookup via `git ls-remote refs/tags/<v>`). Do this as a default for any new workflow, not only after a security review complains.

### COUNCIL
- Ran on PR #3 diff (2026-04-17). Scores: accessibility 10, architecture 10, cost 9, security 5, bugs 3, product 1. Verdict: REVISE. Seven ordered steps in the synthesis; six implemented this round (unit-test refactor of `council.py` deferred). Full report in the PR #3 comment thread.

## 2026-04-17 — Council round 2: cache-based budgets + concurrency fix

### KEEP
- Running the council twice on the same PR caught the Denial-of-Wallet issue in the v2 budget scripts. First pass missed it (scripts didn't exist yet); second pass saw the actual implementation and flagged it. Two rounds = two different signals.
- GitHub Actions expression language has no `toLower()`. Shell step with `${TITLE,,}` is the clean workaround.

### IMPROVE
- Should have reached for GH Actions cache for budget state from the start, not file-in-repo. "If a PR can modify it, it's not a safety mechanism" is a durable rule — add to the security checklist.
- Next time a council persona gives a harsh score (Product 1→2), don't move on until the human has *explicitly* heard the concern in first person, not via chat summary. I did this right in round 1 (AskUserQuestion), wrong in round 0 (gitignored plan).

### INSIGHT
- Budget/rate-limit state must live OUTSIDE the artifact being rate-limited. File-in-repo looks convenient but is self-referential. Cache, external KV, or platform variable are correct.
- Concurrency groups must use a key that's invariant across all event types for the same logical subject. `check_suite.id` is per-event; `pull_requests[0].number` is per-PR. The former is wrong for serializing "events about the same PR."
- `contains()` in GitHub Actions expression language is case-sensitive. When skip-directives matter, do the check in a shell step where you control the semantics.

### COUNCIL
- Round 2 scores: accessibility 10, architecture 10, cost 10, security 4, bugs 4, product 2. Verdict REVISE. Product veto.
- Human overrode the Product veto to fix everything. Product angle remains "do this instead of user-facing work" — if product features don't land within a sprint, council will be right and this will need to come down.
