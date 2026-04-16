# .harness/

Development framework for LLMwiki_StudyGroup. This directory is methodology-as-code: a Gemini-powered review council, durable session state, a git hook that captures every commit, and operational runbooks.

Not application code. Safe to delete if you want the project without the harness; the Next.js app does not depend on it.

Inspired by:
- **[harness-cli](https://github.com/anguijm/harness-cli)** — multi-persona council pattern.
- **[yolo-projects](https://github.com/anguijm/yolo-projects)** — durable session state, append-only audit log, circuit breaker, model-upgrade discipline.

## One-time setup

```bash
# 1. Install the Python dependencies for the council runner.
pip install -r .harness/scripts/requirements.txt

# 2. Point your local git at the harness hooks.
bash .harness/scripts/install_hooks.sh

# 3. Export your Gemini API key (add to ~/.zshrc or ~/.bashrc to persist).
export GEMINI_API_KEY="..."
```

Verify:

```bash
git config --get core.hooksPath           # → .harness/hooks
python3 .harness/scripts/council.py -h    # → help text, no import errors
```

## File map

```
.harness/
├── README.md                # this file
├── council/
│   ├── README.md            # how to add/remove angles
│   ├── security.md          # persona: RLS, auth, secrets, prompt injection
│   ├── architecture.md      # persona: boundaries, migrations, idempotency, RAG
│   ├── product.md           # persona: cohort value, scope, mobile, SRS/wiki
│   ├── bugs.md              # persona: nulls, races, retries, edges
│   ├── cost.md              # persona: Haiku/Opus routing, caching, budget
│   ├── accessibility.md     # persona: WCAG AA, keyboard, screen reader
│   └── lead-architect.md    # resolver: synthesizes the six into one plan
├── scripts/
│   ├── council.py           # Gemini council runner (local)
│   ├── install_hooks.sh     # one-time: git config core.hooksPath
│   ├── requirements.txt     # Python deps for council.py
│   ├── security_checklist.md# authoritative non-negotiables (loaded by council)
│   ├── pr_watcher_budget.py # monthly run-count pre-flight for PR watcher
│   └── log_pr_watch.sh      # appends pr_watch_run entries after watcher runs
├── hooks/
│   └── post-commit          # auto-updates session_state.json + yolo_log.jsonl
├── memory/                  # session snapshots (agent-written, gitignored contents OK)
│   └── .gitkeep
├── session_state.json       # current state (active plan, focus, last council, last commit)
├── yolo_log.jsonl           # append-only audit trail
├── learnings.md             # human-readable KB (KEEP / IMPROVE / INSIGHT / COUNCIL)
├── model-upgrade-audit.md   # 5-layer checklist for model swaps
├── halt_instructions.md     # how to use the .harness_halt circuit breaker
└── last_council.md          # (created by council.py) latest run report
```

## Running the council

On a plan you've drafted:

```bash
# Write your plan (or have the agent write it):
# .harness/active_plan.md

python3 .harness/scripts/council.py --plan .harness/active_plan.md
```

On a working-tree diff (post-implementation review):

```bash
python3 .harness/scripts/council.py --diff                  # vs origin/main
python3 .harness/scripts/council.py --diff --base main      # vs local main
```

Output:
- **stdout** — Lead Architect synthesis printed in full.
- `.harness/last_council.md` — full report (all six critiques + synthesis).
- `.harness/yolo_log.jsonl` — one new line with `{event: "council_run", scores, ...}`.
- `.harness/session_state.json` — `last_council` block updated.

Cost cap: **15 Gemini calls per run** (hard). With the seven default personas, each run is 7 calls.

## Durable session state

Three tiers, each optimized for a different consumer:

| File | Reader | Writer | Purpose |
|------|--------|--------|---------|
| `session_state.json` | Agent at session start, council runner, humans | Agent at session end, council runner, post-commit hook | Latest state — current plan, focus, last council, last commit. Overwritten. |
| `yolo_log.jsonl` | Humans browsing history, agent at session start | Council runner, post-commit hook, agent end-of-task | Append-only audit trail. Never overwritten. |
| `learnings.md` | Agent at session start, humans | Agent after each task | Accumulated prose-form knowledge. KEEP / IMPROVE / INSIGHT / COUNCIL blocks. |

### `session_state.json` schema

```json
{
  "schema_version": 1,
  "active_plan": "path/to/active_plan.md | null",
  "focus_area": "short human-readable string",
  "approval_state": "idle | awaiting_approval | approved | in_progress",
  "last_council": {
    "ts": "ISO-8601",
    "source": "PLAN FILE: ... | DIFF vs origin/main",
    "scores": { "security": 9, "architecture": 8, "...": "..." }
  } | null,
  "last_commit": {
    "hash": "...", "short": "...", "subject": "...",
    "author": "...", "branch": "...", "committed_at": "ISO-8601",
    "files_changed": 3
  } | null,
  "notes": "optional freeform field"
}
```

### `yolo_log.jsonl` event shapes

```json
{"ts": "...", "event": "harness_init", "note": "..."}
{"ts": "...", "event": "commit", "commit": { "hash": "...", "short": "...", "subject": "...", ... }}
{"ts": "...", "event": "council_run", "source": "...", "model": "...", "scores": { ... }}
{"ts": "...", "event": "pr_watch_run", "pr": "...", "trigger": "...", "over_budget": false}
{"ts": "...", "event": "task_complete", "title": "...", "summary": "..."}
```

New event types are fine — keep them flat JSON, one object per line, always with `ts` and `event`.

### Commit-triggered refresh (intentional two-step)

The `post-commit` hook runs on every commit and rewrites `session_state.json` + appends a line to `yolo_log.jsonl`. Because those are tracked files, they show up modified after the commit and land in the *next* commit. This is deliberate — it avoids hook recursion and keeps the log one step behind HEAD, which is exactly what a log should do.

Workflow:

1. You commit code → hook fires → state files updated.
2. Your next commit (code or not) includes the state-file updates alongside whatever else changed.
3. For purely bookkeeping commits, `git commit --allow-empty -m "chore: refresh harness state"` works if you want an isolated state-only commit.

## Council angles

See `council/README.md` for the full list and how to add new ones. Short version:

1. Drop a new `*.md` into `.harness/council/` following the persona shape.
2. Update the table in `council/README.md`.
3. Done — the runner auto-picks it up.

To disable an angle without deleting it, rename `<angle>.md` → `<angle>.md.disabled`.

## Circuit breaker

Write `.harness_halt` at repo root (with a reason). The agent and council both stop. `rm .harness_halt` to resume. Full details in `halt_instructions.md`.

## Model discipline

When you swap any model (Claude tier, Gemini version, embedding model, transcription model), walk `.harness/model-upgrade-audit.md` before merging. Five layers, none optional.

## What's not here (yet)

- **Quality gates** (`npm run lint` / `typecheck` / `test` wrappers for the council to consume). Deferred until the Next.js scaffolding exists. When they land, they'll live at `.harness/scripts/quality_gates.sh`.
- **Tick/tock hourly cron.** That's a yolo-projects pattern for generating many small apps; this repo is one complex app, so it's the wrong mode.

## PR watcher (GitHub Actions)

Separate from the local Gemini council: the repo has a **Claude-powered PR watcher** that reacts to events on every open PR — Codex review comments, CI failures, and `@claude` mentions. Triage-only; every action is bounded by the scope policy.

Files:
- `.github/workflows/pr-watch.yml` — workflow.
- `.github/claude-pr-watcher-prompt.md` — the watcher's system prompt (scope policy lives here).
- `.harness/scripts/pr_watcher_budget.py` — monthly run-count pre-flight (cap: 150 runs/month).
- `.harness/scripts/log_pr_watch.sh` — appends `{event: "pr_watch_run", ...}` to `yolo_log.jsonl` after every run.

One-time setup (required):
- Add `ANTHROPIC_API_KEY` as a repo secret (*Settings → Secrets and variables → Actions → New repository secret*). User-owned GitHub accounts cannot share secrets across repos; copy the value from wherever else you have it.

Scope (enforced by the prompt, not the workflow):
- Watcher edits `.harness/` (except `council/*.md`, `scripts/council.py`, and `CLAUDE.md`) and source files for localized lint/type/test fixes.
- Watcher asks the human for: migrations, RLS changes, dependency bumps, auth/secret/CSP edits, workflow edits, any change > 200 LOC, Codex P0/`critical` comments.
- Watcher never merges, force-pushes, amends, or pushes to `main`.
- Uses Claude Haiku 4.5 by default; ~$3–6/month expected.

Relationship to the local council:
- **Council = pre-plan advisor, run by you before writing code. Gemini-powered. Local-only.**
- **Watcher = post-PR triage, runs in CI without a session attached. Claude-powered.**

They don't overlap. The council edits what you're about to do; the watcher reacts to what's already been pushed.

## Troubleshooting

**"GEMINI_API_KEY not set."** Export it in your shell (`~/.zshrc` or `~/.bashrc`).

**"google-generativeai not installed."** `pip install -r .harness/scripts/requirements.txt` inside the venv you use for this repo.

**Council stuck on one angle.** Each call has 2 retries with exponential backoff. If one angle consistently times out, check Gemini's status page — the script will still produce a report with the failed angle flagged.

**Post-commit hook not running.** Check `git config --get core.hooksPath` prints `.harness/hooks`. If empty, rerun `bash .harness/scripts/install_hooks.sh`.

**Post-commit hook runs but state files don't update.** Check `.harness/hooks/post-commit` is executable (`chmod +x`). Some checkout modes drop the executable bit.
