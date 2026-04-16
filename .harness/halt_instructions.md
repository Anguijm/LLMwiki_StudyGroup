# Halt instructions

The harness honors a circuit-breaker file: `.harness_halt` at the repository root (not inside `.harness/`). When this file exists, Claude Code stops all work and the council runner exits early.

## How to halt

```bash
echo "Reason: <why you're halting>" > .harness_halt
```

A one-line reason is enough. Multiple lines are fine — the full contents are surfaced.

Typical reasons:
- "Something is going wrong; stop the agent while I investigate."
- "Dependency X broke; don't write code that depends on it."
- "Budget incident; pause until I confirm cost posture."
- "I'm offline for the week; don't let anyone run the agent."

## What halts

- **Claude Code (via `CLAUDE.md`)** — on session start, if `.harness_halt` exists the agent prints the contents and refuses to act. The human removes the file to resume.
- **Gemini council (`council.py`)** — exits with code 2 and prints the halt reason. No API calls made, no `.harness/last_council.md` or `yolo_log.jsonl` updates.
- **Post-commit hook** — does *not* halt on `.harness_halt`. It's a local bookkeeping step; blocking it would prevent routine commits that might be the user reacting to the halt.

## How to resume

```bash
rm .harness_halt
```

That's it. No state to reset — `.harness_halt` is purely a trigger file. Nothing else is disturbed while the halt is in effect.

## What to do while halted

- Inspect `.harness/last_council.md` if the halt was triggered by a bad council output.
- Inspect recent `.harness/yolo_log.jsonl` entries to understand the session that ran into trouble.
- If the halt is long-lived, write a COUNCIL block in `.harness/learnings.md` documenting what happened and what would need to be true to resume.

## Not committed

`.harness_halt` is a local trigger file — do not commit it. It should be added to `.gitignore` when the Next.js scaffolding creates one. In the meantime, don't `git add` it.
