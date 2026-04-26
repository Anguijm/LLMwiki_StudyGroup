# Plan: (none — session handoff stub)

**Status:** no active plan; awaiting next session start.
**Last shipped arc:** PR #54 (#39 semantic chunking, squash `0ac920a`). Merged 2026-04-26 after 7 council rounds.

## Next session: open with the priority queue from `SESSION_HANDOFF.md`

User-stated priority order at session close (2026-04-26):

1. **Issue #7 dedicated PR — make `db-tests` a blocking CI gate.** Investigation in PR #54 reduced this from "unknown CI issue since v0" to two specific blockers + workarounds. See [comment on issue #7](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/7) for the full diagnosis. Two paths:
   - **Minimal**: split migration 4's GRANT off + add `--exclude supavisor` to `supabase start` in ci.yml + pin CLI version. Three small changes.
   - **Durable**: replace `supabase start` with a docker `services:` postgres container + `psql -f` migrations. ~50 LOC workflow rewrite, eliminates two failure classes at once.
2. **Remove `MAX_BODY_CHARS = 500_000`** stopgap in `inngest/src/functions/flashcard-gen.ts:37` — vestigial after #39 ships. One-line code change + the existing test ("body > 500_000 chars → skipped: body_too_long") needs updating to assert oversized inputs now fan out into sections instead of skipping.
3. **Anthropic prompt caching** on `simplify` + `flashcard-gen` handlers. 1h TTL on the stable system prompts (`SIMPLIFIER_V1`, `FLASHCARD_GEN_V1`). Cost optimization, ~50% input-token cost reduction expected on repeat ingest. Council r3 + r5 deferred nice-to-have.

## Session-start checklist (per CLAUDE.md §"Session I/O protocol")

- [ ] Read `.harness/session_state.json` — focus_area + last_council + notes.
- [ ] Tail `~20` lines of `.harness/yolo_log.jsonl` — recent ship events.
- [ ] Skim recent `.harness/learnings.md` entries — especially the 2026-04-26 PR #54 entry (documents the 7-round arc + the four-disposition model + the orthogonal-infrastructure soft rule).
- [ ] Verify circuit breaker absent (`ls .harness_halt`).
- [ ] If picking #7: read the [postgres-expert investigation comment on issue #7](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/7) FIRST — it documents what's been ruled out so the dedicated PR doesn't replay the same hypotheses.
- [ ] If picking the `MAX_BODY_CHARS` removal: read `inngest/src/functions/flashcard-gen.test.ts` to find the test that needs updating, AND survey downstream handlers to confirm none silently rely on the cap.

## Why this stub instead of a full plan

Writing a full plan now would spend context the next session needs for actual planning. The stub tells future-you what the priority queue is + where to read first; the plan itself materialises when next session starts.
