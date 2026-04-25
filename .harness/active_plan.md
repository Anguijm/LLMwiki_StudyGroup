# Plan: (none — session handoff stub)

**Status:** no active plan; awaiting next session start.
**Last shipped arc:** PR #51 (Tier E fail-closed hot-fix, squash `bd6f22c`) → PR #50 (PR #48 reflection, squash `0c51c19`). Both merged 2026-04-24/25.

## Next session: open with surveying issue #39 (semantic chunking)

User-stated priority order at session close (2026-04-25):

1. **#39 — semantic chunking** (highest leverage; v1 unlock for downstream handlers — flashcards, wiki-linking, gap-analysis all benefit from per-section notes vs. the current `MAX_BODY_CHARS` stopgap). **NOTE: plan must explicitly address prompt injection** — chunked content reaches an LLM, so framing boundaries (e.g., the existing `<untrusted_content>` wrapping pattern from `packages/lib/ai/src/anthropic.ts`) must apply per chunk per `.harness/scripts/security_checklist.md`. Per PR #53 r1 security non-negotiable.
2. **#52 — CI guardrail to prevent silently-skipped tests** (security infrastructure; PR #51 r3 security persona's strong-endorse follow-up; protects the §"Rebutting council findings" rule's "consistently passing test" requirement).
3. **Deploy-readiness validation** (apply migrations `20260424000001` + `20260424000002` on the live Supabase project; `pnpm install` for `ts-fsrs@5.0.0`; manual end-to-end with a real PDF).

## Session-start checklist (per CLAUDE.md §"Session I/O protocol")

- [ ] Read `.harness/session_state.json` — focus_area + last_council + notes.
- [ ] Tail `~20` lines of `.harness/yolo_log.jsonl` — recent ship events.
- [ ] Skim recent `.harness/learnings.md` entries — especially the 2026-04-24/25 PR #48 + PR #50 entries (they document the FSRS pipeline + the rebut-vs-fold-vs-defer working model + the test-config-audit lesson).
- [ ] Verify circuit breaker absent (`ls .harness_halt`).
- [ ] Survey relevant repo state for #39 BEFORE drafting the plan (per the §IMPROVE bullet from PR #48 reflection: "read external dep .d.ts BEFORE writing wrapper" — same discipline applies to in-house: read `inngest/src/functions/chunker.test.ts` + `ingest-pdf.ts` + `MAX_BODY_CHARS` callsites + flashcard-gen interaction first).

## Why this stub instead of a full plan

Writing #39's full plan now would spend context the next session needs for actual planning. The stub tells future-you what the priority queue is + where to read first; the plan itself materialises when next session starts.
