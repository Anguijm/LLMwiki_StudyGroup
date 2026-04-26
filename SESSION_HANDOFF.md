# Session handoff

The "Start here next session" block is at the top. Everything below is historical log; do not edit it after a session closes — append a new block.

---

## Start here next session — 2026-04-26 → ?

**Current branch:** `main` (clean — last session-end PR #55 merged).
**Last merged feature PR:** [#54 — #39 semantic chunking → section-as-note + atomic RPC](https://github.com/Anguijm/LLMwiki_StudyGroup/pull/54), squash `0ac920a`, merged 2026-04-26.

### Priority queue (in order)

1. **Issue #7 dedicated PR — make `db-tests` a blocking CI gate.**
   - Investigation reduced this from "unknown CI issue since v0" to two specific blockers (full diagnosis posted as a [comment on #7](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/7)). The two blockers + recommended fixes:
     - **Supabase CLI statement-splitter on migration 4** (`20260417000004_atomic_null_reserved_tokens.sql`). Splitting the GRANT off file 4 advanced the failure past this. Apply the same split to file 4 + (prophylactically) files 5, 24-2, 26-1 — OR rewrite migration 4 to avoid `RETURNS TABLE (col)` + `RETURN NEXT` body shape (caller in `inngest/src/functions/on-failure.ts` would need updating to a scalar return).
     - **`supavisor` (Postgres pooler) container fails to bring up its ulimit on the GitHub Actions runner.** Workaround: add `--exclude supavisor` to the `supabase start` command in `ci.yml`. We don't need pooling for pgTAP.
   - Once both unblocked, flip `continue-on-error: true` to `false` at `.github/workflows/ci.yml:117`.
   - Larger-but-more-durable alternative: replace `supabase start` entirely with a docker `services:` postgres container + `psql -f` for migrations. Bypasses the CLI splitter AND the supavisor dependency. ~50 LOC workflow rewrite.

2. **Remove `MAX_BODY_CHARS = 500_000` stopgap in `inngest/src/functions/flashcard-gen.ts:37`.**
   - PR #54 (#39) made this vestigial — section-as-note guarantees per-section bodies fit well below the cap. The skip path at lines 234-242 will never fire under the new pipeline.
   - One-line code removal + the corresponding test ("body > 500_000 chars → skipped: body_too_long") needs updating to assert that oversized inputs now fan out into sections instead of skipping. Revisit `inngest/src/functions/flashcard-gen.test.ts`.

3. **Anthropic prompt caching on `simplify` + `flashcard-gen` handlers** (council r3 + r5 deferred nice-to-have, cost optimization).
   - Both handlers use large stable prompt prefixes (`SIMPLIFIER_V1` and `FLASHCARD_GEN_V1`). 1h TTL caching cuts input-token cost ~50% on repeat ingest within an hour. Plan + impl.

### Blockers

None. All v1 follow-ups from prior sessions remain open (see `BACKLOG.md` Open issues), but none gate the priority queue.

### Heads-up

- `.claude/agents/postgres-expert.md` is a new project-scoped subagent definition. Project sessions starting fresh will pick it up; can be invoked via `Agent(subagent_type="postgres-expert", prompt=…)` for SECURITY DEFINER / trigger / pgTAP reviews.
- The CI `validate` job now has a "silent-skip guardrail" step that asserts an allowlist of test files actually appear in vitest output. If you add a new high-leverage test file, add it to the `EXPECTED` array in `ci.yml`. Issue #52 will replace the manual list with a generated manifest.

---

## Historical log

### 2026-04-25 → 2026-04-26 (session that shipped PR #54)

- Shipped PR #54 (#39 semantic chunking, squash `0ac920a`). 7 council rounds (REVISE → PROCEED → PROCEED → PROCEED → REVISE → REVISE → PROCEED). Bugs trajectory 5 → 6 → 8 → 9 → 9 → 6 → 10. 48 new tests across pgTAP / chunker / voyage / ingest-pdf suites.
- Created project-scoped subagent at `.claude/agents/postgres-expert.md` for SECURITY DEFINER / trigger / pgTAP reviews (council r6 procedural ask).
- Investigated #7 db-tests flake; ruled out two hypotheses (CLI version float, multi-statement file pattern), confirmed splitter-on-migration-4 is the first blocker, identified supavisor ulimit as the second blocker. Reverted speculative attempts on PR #54 to keep the merge focused on #39; full diagnosis posted as comment on issue #7.
- See `.harness/learnings.md` 2026-04-26 entry for KEEP/IMPROVE/INSIGHT/COUNCIL detail.

### Earlier sessions

See `.harness/learnings.md` for per-session reflections going back to harness init (2026-04-16).
