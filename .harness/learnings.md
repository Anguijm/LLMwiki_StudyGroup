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

## 2026-04-17 — Council round 3: secret scan, budget gating, tight tool allowlist

### KEEP
- Three rounds of council on the same PR produced monotonically better scores on every axis except product (which stayed flat as a principled veto). The system is doing what it's supposed to.
- SHA-pinning third-party actions at first-use, not after a security review, would have saved round 1. Do it reflexively.
- When an `if:` can't express what you need (case-insensitive match), move the decision to a shell step. GitHub Actions expression language is not a general-purpose matcher.

### IMPROVE
- Shipped v2 with `contains(body, '@Claude')` thinking that was case-insensitive. It isn't. When touching something that looks language-primitive (matching, comparing), verify the exact semantics before claiming coverage.
- Shipped v3 with an unconditional budget increment. "The watcher ran" is not the same as "the watcher succeeded." Any counter tied to cost must be gated on the thing-that-costs-money succeeding.

### INSIGHT
- The council makes me honest. Three rounds found seven real bugs I'd have shipped. Chat-summary approval would have shipped all of them.
- Muting a persona is a sharp tool — it's the right move when a persona is correctly flagging a decision you've already overridden, because their repeated veto doesn't add new signal. Document the mute, restore after one round, and don't make it a habit.
- For developer-facing automation: every feature needs a per-feature circuit breaker (e.g. `PR_WATCHER_ENABLED`) AND a global one (`.harness_halt`). Two levels of kill switch, one for config and one for emergencies.

### COUNCIL
- Round 3 scores: accessibility 9, architecture 9, cost 10, security 7 (+3 over r2), bugs 5 (+1), product 2. Verdict REVISE, one non-negotiable (secret scan). Human directed: fix all four must-dos, mute product for round 4.
- Product scored 2/10 three rounds in a row with increasingly strident language. Kill criteria now explicit in the council comment: if user-facing features don't ship next sprint, these workflows get disabled.

## 2026-04-17 — Council round 4: PROCEED + merge

### KEEP
- Four council rounds on one PR produced scores 3/5/7/9 on security and 3/4/5/6 on bugs. Every round surfaced real bugs and pushed the design. The system works as intended.
- Lead Architect said "ready for human approval" at round 4. Stopped here — further rounds are diminishing returns on polish.

### IMPROVE
- The budget counter "validate-numeric" step was a two-line bug that stood for two commits. Defensive validation of in-cache state should be the default pattern — don't assume external state is well-formed.
- `--body-file` for any `gh pr comment` call with untrusted content should be a rule, not a case-by-case decision. Adding to the security checklist.

### INSIGHT
- Forbidden flags deserve comments at the use site, not buried in docs. If a future contributor adds `--allow-untracked` to `council.yml` and a reviewer misses it, the tracked-plan gate silently stops working. The comment is a cheap tripwire.
- Hardening the system prompt with a "security-review this suggestion" footer is a cheap adversarial-injection defense that costs zero runtime and one reviewer second. Every agent-suggestion-to-human path should include a skepticism nudge.

### COUNCIL
- Round 4 scores: accessibility 7, architecture 10, bugs 6, cost 10, security 9. Product muted by prior direction. Verdict: PROCEED.
- Tracking issue #4 opened to restore `.harness/council/product.md` within 7 days.

## 2026-04-17 — v0 vertical slice: 8-round council + execution landed

### KEEP
- Plan-first, human-approved flow worked exactly as designed. r1 security was 3/10; r8 was 10/10. Every round surfaced real bugs or holes (SSRF column, coarse rate limit, slug race, orphan storage file, double-refund, Realtime channel leak, idempotency-collides-on-retry, missing server-side size cap, ...) and every round closed them without thrashing on taste. Trust the process.
- Content-hash idempotency key (`sha256(file_bytes)`) + partial unique index `where status not in ('failed','cancelled')` is the right pattern for retry semantics. Re-submitting the same file after a terminal failure gets a fresh job; concurrent double-submits collapse to the same one.
- Typed error catalogue (`IngestionErrorKind` exhaustive union) + classifier that fails typecheck on missing cases made the whole error-handling surface maintainable. Adding a new failure mode anywhere in the pipeline forces a deliberate UI-category decision.
- DI-friendly shape for the onFailure hook (inject supabase + tokenBudget + storage + metrics) made the SECURITY-CRITICAL double-refund test easy to write and easy to trust. That test alone justified the abstraction cost.
- Pushing in 3-commit batches + a 2-min background timer per batch pipelined the work: council reviewed batch N while I wrote batch N+1. Nine commits across the full scaffold only cost three council rounds (batches 1-2, 3-5, 6-8) — well under budget.

### IMPROVE
- r3 dropped bugs to 5 (new classes surfaced) right after r2 scored 9. Writing more plan = more surface to critique. Next plan, be more terse on interior details and trust that the typed shape catches them at implementation time.
- Product 10 → 8 → 9 → 6 → 7 → 7 → 9 → 10 oscillated because the reviewer kept arguing "trim the hardening; 4-user MVP doesn't need this." I rejected it twice, the human confirmed, and Lead Architect ultimately out-of-scoped it. Next time, put the security/velocity tradeoff into the plan's status block on round 1 so the product reviewer sees the decision as pre-made instead of re-opening it every round.
- The SQL comment drift in `atomic_null_reserved_tokens.sql` (r7's stale RETURNING-trick prose next to the real SELECT-FOR-UPDATE code) was a write-first-read-later mistake. Council caught it in round-on-batch. Always re-read a file before committing it.
- Realtime race: I kept describing the reconcile in the plan ("re-fetch then apply deltas") and the council kept sniffing that as underspecified until I committed to the exact buffer-queue-during-fetch algorithm. Plan algorithms that risk race conditions to the pseudocode level, not the prose level.

### INSIGHT
- Two things that land in "defense-in-depth" earn their weight even when primary controls already exist:
  - CSP header on top of rehype-sanitize. The sanitizer is the primary; CSP is free to add and catches whatever the sanitizer misses.
  - Trigger-backed integrity on top of RLS (concept_links cross-cohort). RLS is access control; triggers are integrity. A service-role writer bypasses RLS and can still violate the invariant — the trigger stops that.
- The single most useful pattern across this whole scaffold: **atomic claim in Postgres first; act on external state only on a successful claim return.** Used for the token refund (UPDATE ... RETURNING pre-value → INCRBY Upstash only on non-null). Same pattern fits any "act once, even under retry" problem across the surface.
- Orphan-file prevention was a 4-line fix: pre-allocate the job id + include `storage_path` on the INSERT. Doing the ID allocation client-side also unified the slug-hash and row-id into a single UUID — side benefit. When two independent problems have the same root cause (app-side ID generation), fixing both is one change, not two.
- `pgTAP` lockfile test (`pg_publication_tables == {ingestion_jobs}` exactly) is a pattern I want to reuse. Codify "the allow-list IS the test" anywhere the accident cost of adding something bad is high.

### COUNCIL
- Eight rounds. Scores evolution:
  - accessibility: 5 → 9 → 9 → 9 → 9 → 10 → 10 → 10
  - architecture: 9 → 10 → 10 → 10 → 10 → 10 → 9 → 10
  - bugs: 6 → 6 → 5 → 9 → 8 → 9 → 9 → 9
  - cost: 9 → 9 → 10 → 10 → 10 → 10 → 10 → 10
  - product: 10 → 10 → 8 → 9 → 6 → 7 → 7 → 10
  - security: 3 → 3 → 9 → 9 → 9 → 9 → 10 → 10
- Final r8 verdict: PROCEED, 0 non-negotiable violations, 0 must-dos.
- Three in-flight diff-reviews on the execution commits (batches 1-2, 3-5, 6-8) each returned PROCEED with at most two small nice-to-haves, all folded in by the time this reflection was written.
- Approved by human 2026-04-17 after r8 ("let's roll"). Execution landed as 10 commits on PR #5.
