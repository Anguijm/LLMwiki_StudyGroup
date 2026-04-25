# Plan: #39 — semantic chunking (PDFs → per-section `notes` rows)

**Status:** draft, awaiting council + human approval per CLAUDE.md §"What counts as approval".
**Issue:** [#39](https://github.com/Anguijm/LLMwiki-StudyGuide/issues/39).
**Last shipped arc:** PR #51 (Tier E fail-closed, `bd6f22c`) → PR #50 (PR #48 reflection, `0c51c19`).
**Prior context loaded:** issue #39 body, `inngest/src/functions/{chunker,ingest-pdf,flashcard-gen}.ts`, `supabase/migrations/20260417000001_initial_schema.sql` (notes + concept_links + cohort RLS pattern), `docs/security/rate-limiter-audit.md` (Tier A/B), `.harness/scripts/security_checklist.md`, recent learnings (PR #48/#50/#51).

## TL;DR

Make ingest produce **one `notes` row per semantic section** (chapter / heading-group / paragraph-cluster) instead of one row per PDF. Downstream handlers (flashcard-gen, wiki-link, gap-analysis) fan out per-section without code changes. Implements issue #39's design verbatim: extend `notes` with `parent_note_id` + `section_path`, *do not* introduce a new `chunks` table.

## Goal / success criteria

1. A 300-page textbook upload produces N section-`notes` rows where each section's `body_md` fits within 60% of Claude Haiku 4.5's 200k-token input window (~120k tokens ≈ 480k chars English / ~160k chars CJK-conservative).
2. The existing `flashcard-gen` handler runs once per section (not once per document) with no code changes — section notes look exactly like document notes from its perspective.
3. The `MAX_BODY_CHARS = 500_000` stopgap in `flashcard-gen.ts:37` is no longer load-bearing (every section comes in well under it).
4. RLS isolation is preserved: a user who can read the parent note can read its sections; a user from a different cohort sees neither.
5. No regression in the existing ingest happy path (one PDF → notes → flashcards) for documents that produce only one section.

## Out of scope

- Multi-modal section types (images, tables, code blocks as their own note types) — orthogonal feature.
- Cross-document section linking ("Chapter 4 of textbook A aligns with Lecture 7 of course B") — gap-analysis territory.
- User-editable section boundaries — UI feature.
- Recomputing / re-chunking existing single-row notes — migration path: existing rows get `parent_note_id = null` and `section_path = null`; new uploads use the new chunker. No backfill.
- `/note/[slug]` UI changes for section breadcrumbs / sibling navigation — separate cosmetic PR (per issue #39 §Scope).
- `flashcard-gen.ts` rewrite. The handler's idempotency + token-budget pattern already works per-`note_id`; section notes inherit it. Removing `MAX_BODY_CHARS` is a follow-up cleanup, not a blocker.

## Architecture decision: section-as-note (NOT separate `chunks` table)

The handoff stub mentioned a "new `chunks` table." After reading issue #39 + the existing schema, **section-as-note is the right design**:

- **Each section is a `notes` row** with `parent_note_id` FK to the original document's note, `section_path` text breadcrumb, and its own `body_md` / `embedding` / `cohort_id`.
- **The original document is also a `notes` row** (the parent), with `parent_note_id = null`, `body_md` set to a TOC summary or empty, and embedding optional (per below).
- **No new `chunks` table.** Adding one would require: a parallel RLS policy, parallel cohort-integrity trigger, a separate fan-out path for downstream handlers. The notes table already has all of those.

Trade-offs of this choice:

| Concern | Section-as-note (chosen) | Separate `chunks` table |
|---|---|---|
| RLS | inherits `notes` cohort policy ✓ | new policy needed |
| Handler fan-out | existing `flashcard-gen` works as-is ✓ | rewrite needed |
| Search / SRS card → context "from section X of doc Y" | `section_path` is in the notes row ✓ | requires JOIN on every read |
| Parent-doc-only operations (delete, retry) | needs a sibling-aware delete cascade | trivially scoped to one row |
| Embeddings | each section gets its own — better retrieval | parent-only embedding loses granularity |

Issue #39 specifies section-as-note; this plan follows it.

## Data isolation model (per CLAUDE.md §"Plan-time required content")

**Model:** **per-cohort** (no change from existing `notes` policy).

**Justification:** Sections inherit the parent document's `cohort_id`. A study group's textbook chapters are cohort-shared in the same way the document itself is — same blast radius, same audit story. The existing `notes_select` / `notes_insert` / `notes_update` policies (`supabase/migrations/20260417000002_rls_policies.sql:49-74`) already filter by `cohort_id IN (memberships of auth.uid())` and apply unchanged.

**Cross-cohort integrity:** sections must have `cohort_id == parent.cohort_id` (a section can't claim a different cohort than its parent). Enforced by a trigger paralleling `check_concept_link_cohort_integrity` (initial_schema.sql:118-139). RLS guards reads; the trigger guards service-role writes. Trigger name: `check_section_note_cohort_integrity`. Sketch:

```sql
create or replace function public.check_section_note_cohort_integrity()
returns trigger language plpgsql as $$
declare parent_cohort uuid;
begin
  if new.parent_note_id is null then return new; end if;
  select cohort_id into parent_cohort from public.notes where id = new.parent_note_id;
  if parent_cohort is null then
    raise exception 'section_note references missing parent: %', new.parent_note_id;
  end if;
  if parent_cohort <> new.cohort_id then
    raise exception 'section_note_cohort_mismatch: parent=%, section=%',
      parent_cohort, new.cohort_id;
  end if;
  return new;
end $$;
```

## Schema changes (one migration)

Migration: `supabase/migrations/<YYYYMMDD>000001_notes_section_hierarchy.sql`.

```sql
alter table public.notes
  add column parent_note_id uuid references public.notes(id) on delete restrict,
  add column section_path text;

-- Sibling-section lookup index (parent → ordered children).
create index notes_parent_note_id_idx on public.notes (parent_note_id)
  where parent_note_id is not null;

-- Cohort-integrity trigger (mirrors concept_links pattern).
create or replace function public.check_section_note_cohort_integrity() ...;
create trigger notes_section_cohort_integrity
  before insert or update on public.notes
  for each row execute function public.check_section_note_cohort_integrity();
```

**Rollback:** `supabase/migrations/<YYYYMMDD>000002_notes_section_hierarchy_down.sql` drops the trigger, function, index, and columns. Safe to run as long as no production rows have `parent_note_id is not null` — i.e., before any new ingests run on the new schema. Document this prerequisite in the rollback file's header comment.

**Why `on delete restrict`** (not `cascade`): consistent with every other FK in `notes`. A user deleting a parent document should explicitly delete its sections first (or the app deletes them in a single transaction). Cascade hides intent and bypasses RLS in subtle ways.

## Pipeline changes

### `chunker.ts` — semantic chunking, not just token-windowing

Current behavior (`inngest/src/functions/chunker.ts:27-61`): walk `parsed.blocks`, flush at heading boundaries OR when `bufferTokens >= CHUNK_TARGET_TOKENS = 1200`. Returns flat `Chunk[]` for embedding only.

New behavior: same walk, but emits **`Section[]`** with structural metadata so the persist step knows what becomes a notes row.

```ts
export interface Section {
  index: number;          // 0..N-1 ordering within the parent doc
  title: string | null;   // heading text, or null for "untitled section N"
  path: string;           // breadcrumb, e.g. "Chapter 4 / 4.3 Pyruvate Oxidation"
  text: string;           // body_md content for this section
  estimatedTokens: number;
}
```

Boundary detection (priority order, picks the first that yields > 1 section):

1. **Top-level structural markers** if the parser emits them: TOC entries, `block.type === 'heading' && level <= 2`. Each such heading starts a new section.
2. **Heading-level fallback**: any `block.type` matching `/^heading/i` starts a new section.
3. **Length fallback**: if (1) and (2) yield only 1 section AND that section's `estimatedTokens > CHUNK_TARGET_TOKENS_PER_SECTION (= 30_000, the 60%-of-Haiku budget)`, split at paragraph boundaries within budget.

Caps:
- `MAX_SECTIONS = 200` (rename of existing `MAX_CHUNKS`; same constant, same `TooManyChunksError` semantics, same `pdf_too_many_chunks` error kind — preserves the error contract).
- Per-section `MAX_SECTION_TOKENS = 50_000` (~200k chars English) — hard ceiling. Exceeding raises `SectionTooLargeError` → new error kind `pdf_section_too_large`.

### `ingest-pdf.ts` — fan out to N notes rows

Two changes:

1. **`chunk` step now returns `Section[]`** instead of `Chunk[]`. Token-budget reservation already iterates the array with `chunks.reduce((s, c) => s + c.estimatedTokens * 2, 0)` — works unchanged.

2. **`persist` step** becomes a transaction-style insert of (parent + sections) all at once:
   - Single section: behaves exactly like today (1 notes row, `parent_note_id = null`, `section_path = null`). No regression for small PDFs.
   - Multiple sections: insert parent first (TOC-summary or empty body, no embedding), then bulk-insert children with `parent_note_id = parent.id` and inherited `cohort_id`. Children get their own embeddings (computed in a new `embed-sections` step paralleling the existing `embed`).
   - All inserts share the same `source_ingestion_id` semantics: parent gets the original `job_id`; children get `null` (so the unique constraint on `source_ingestion_id` doesn't fire on them). Idempotency for the parent stays intact.

3. **Post-ingest events fan out per section, not per document:**
   ```ts
   for (const sectionNote of sectionNotes) {
     await step.sendEvent(`post-ingest-flashcards-${sectionNote.id}`, {
       name: 'note.created.flashcards',
       data: { note_id: sectionNote.id },
     });
   }
   ```
   Idempotency: `flashcard-gen` already keys on `event.data.note_id` (`flashcard-gen.ts:387`). Each section_note has its own UUID, so each fires once even on event double-delivery. **This is the council's bugs non-negotiable from the handoff stub** (use `event.data.note_id`, not `event.id`).

### Embedding strategy

- **Each section gets its own Voyage-3 embedding** (one call per section, batched if Voyage supports batch — TBD; if not, sequential within the existing `embed` step's loop).
- **Parent doc embedding:** computed only if `simplified.length <= VOYAGE_MAX_EMBED_CHARS = 30_000`. Otherwise skip — parent is a navigation node, not a search target. Search hits the section embeddings; parent surfaces via `parent_note_id` lookup.
- This change increases per-document embedding cost from 1 call to N calls — acknowledged in the cost section below.

## Cost posture (per CLAUDE.md §"Cost posture")

**Model selection:** chunking itself is **structural**, not LLM-driven — we use parsed PDF blocks + regex on heading markup, no LLM call for the boundary detection. Council's "use Haiku" non-negotiable applies to the *downstream* per-section operations (simplify, flashcard-gen) — those already use Haiku. **No new LLM callsite is added by the chunker.** Verify in plan review: yes, the boundary detection is pure-function over `parsed.blocks`.

**Per-document cost ceiling:** the existing `token_budget_reserve` step already enforces this — it reserves `chunks.reduce((s, c) => s + c.estimatedTokens * 2, 0) + chunks.length * 50` tokens against the user's Tier B 100k/hour budget. Section-level chunking changes the *granularity* of that estimate but not the *total* — a 480k-char document still reserves ~240k tokens whether it's 1 chunk or 40 sections. **If the total exceeds Tier B's per-hour ceiling, the user gets a `token_budget_exhausted` error and the job fails-closed today** — same behavior, no regression.

**Permanent caching:** the council's "cache generated chunks permanently in Supabase (never re-chunk a note)" rule from the handoff stub maps to: **section notes ARE the cache**. Once `ingest-pdf` produces them, they're persisted as `notes` rows with all the durability of the rest of the schema. The `unique source_ingestion_id` index on the parent note is the idempotency key — a re-run of the ingest job for the same `job_id` finds the existing parent and short-circuits. No re-chunking occurs.

**Embedding cost ratio:** going from 1 → N embeddings per document. For a 40-section textbook at ~$0.0001/Voyage embedding, that's $0.004 per textbook vs. $0.0001. Negligible at 4-user scale; document the exact number in a `// per-call cost` comment at the new `embed-sections` callsite per CLAUDE.md.

## Tier A trigger rate limit (security non-negotiable)

The council's "per-user rate limit on triggers (e.g., 10 documents queued per user per hour) to prevent denial-of-wallet via rapid bulk ingest" maps to **Tier A, which already exists** (`packages/lib/ratelimit/src/index.ts:53-84`, `INGEST_EVENTS_PER_HOUR = 5`). It's wired into the ingest entry point per `docs/security/rate-limiter-audit.md` row 1 (`Tier A: ingest events 5/user/hour fail-closed`).

**No new tier needed.** This plan inherits the existing Tier A protection. Confirm in implementation: the entry point that calls `inngest.send({ name: 'ingest.pdf.requested', ...})` is already gated by `makeIngestEventLimiter().reserve(userId)`. If audit reveals it's NOT gated there, that's a pre-existing bug unrelated to #39 — file as a separate issue, do not bundle.

## Prompt-injection wrapping (security non-negotiable)

Section content reaches an LLM in two downstream paths:
1. `simplify` step in `ingest-pdf.ts` — already wraps via `SIMPLIFIER_V1` (verified: `packages/prompts/src/index.test.ts:8-10` asserts `<untrusted_content>`, "not instructions", "IGNORE those instructions" framing).
2. `flashcard-gen` step — already wraps via `FLASHCARD_GEN_V1`.

**Both are per-call wrappings** — they apply to whatever chunk is fed to that prompt. Going from 1 large chunk to N section-sized chunks changes nothing about the wrapping discipline; each Claude call still sees `<untrusted_content>...</untrusted_content>` framing. **No new wrapping work needed.** Council's "framing boundaries must apply per chunk" non-negotiable is satisfied by the existing prompts.

## PII logging discipline (security non-negotiable)

Existing pattern from `flashcard-gen.ts:408-413`: structured logs with `{alert: true, tier: '<name>', errorName: <class>, note_id: <uuid>, user_id: <uuid>}` only. **No PII (no body content, no titles, no user emails).**

The new `embed-sections` step + the persist fan-out logic MUST follow this pattern. Specifically:

- Log `note_id`, `parent_note_id`, `cohort_id`, `errorName`, `step` only.
- **Never** log `section.text`, `section.title`, `section_path`, or `body_md` content.
- A failing test in `ingest-pdf.test.ts` will assert this: `expect(logSpy).not.toHaveBeenCalledWith(expect.objectContaining({ body: expect.anything() }))` (extending the existing PII-safety test pattern from `apps/web/components/ErrorBoundary.test.tsx:42-62`).

## a11y for downstream UI surfaces (a11y non-negotiable)

Semantic chunking is a backend job — no new UI in this PR. **But** future PRs that surface section structure (`/note/[slug]` breadcrumb, sibling navigation, search-by-section) will need:

- Semantic HTML for the section tree (`<nav>` + `<ol>` for breadcrumbs, not `<div>` chains).
- Screen-reader labels for "Section 4.3 of Chapter 4" navigation.
- Axe-core smoke tests extending the pattern from `apps/web/app/review/page.test.tsx` (PR #42 + PR #48).

This plan **records the requirement here** so the issue #39 follow-up UI ticket carries it forward, but does not implement it (out of scope). When the UI follow-up PR opens, its plan must explicitly cite this requirement.

## Test strategy

New tests (location → assertion):

1. `inngest/src/functions/chunker.test.ts` (extend) — section-boundary detection:
   - Single-heading doc → 1 section, `parent_note_id` semantics covered in pipeline test.
   - Multi-heading doc → N sections with correct `path` breadcrumbs.
   - No-heading doc above token budget → length-fallback split at paragraph boundaries.
   - `MAX_SECTIONS = 200` cap → throws `TooManyChunksError`.
   - Per-section cap `MAX_SECTION_TOKENS = 50_000` → throws `SectionTooLargeError`.

2. `inngest/src/functions/ingest-pdf.test.ts` (extend) — fan-out behavior:
   - 1-section result → 1 notes row, no `parent_note_id`, no regression vs. today.
   - N-section result → 1 parent + N children with correct `cohort_id` inheritance, `parent_note_id` set, `section_path` populated.
   - Cohort-integrity trigger fires on a service-role insert with mismatched `cohort_id`.
   - Idempotency: re-running the same `job_id` finds the existing parent + does not re-insert sections.
   - PII-safety: `console.error` mock asserts no body content / no section_path values in error logs.

3. `supabase/tests/notes_section_hierarchy.sql` (pgTAP) — RLS + cohort-integrity at the database boundary:
   - User in cohort A reads parent + sections in cohort A. ✓
   - User in cohort B reads neither. ✓
   - Service-role insert with mismatched cohort_id raises `section_note_cohort_mismatch`. ✓
   - Note: `db-tests` is `continue-on-error` (#7) — these tests are evidence-of-intent but per §"Rebutting council findings" rule #2 a security rebuttal must cite a *consistently passing* test. The TS-level cohort-integrity test in `ingest-pdf.test.ts` is the load-bearing assertion; pgTAP is corroboration.

4. `apps/web` test suite — verify no regression to existing flashcard / review flows. Section notes look identical to document notes; existing tests should pass unchanged.

### Vitest-include coverage check (per #52 / PR #51 reflection)

Verify the new test files are *actually picked up* by vitest before declaring tests passing. Specifically:
- `inngest/vitest.config.ts` (or workspace root) `include` pattern matches `inngest/src/functions/*.test.ts` ✓ (existing pattern).
- New `supabase/tests/*.sql` are in the existing `db-tests` job's globbing pattern.
- Run `pnpm test --reporter=verbose` and grep output for the new test file names. If absent, fail the PR before merging.

## Phased execution (small, testable increments on the same PR)

Each phase is a separate commit on the feature branch. Each push re-runs council on the diff.

1. **Schema migration + cohort-integrity trigger.** No code changes. Tests: pgTAP for the trigger.
2. **Chunker section-detection.** Pure function refactor of `chunker.ts`. Tests: unit tests for boundary detection + caps.
3. **Persist fan-out.** Update `ingest-pdf.ts` persist step + event emission. Tests: pipeline integration tests.
4. **Documentation update.** `docs/architecture/ingest-pipeline.md` (or equivalent) updated to reflect section-as-note. Comments at new callsites with cost annotations per CLAUDE.md.

After phase 4, the `MAX_BODY_CHARS` cap in `flashcard-gen.ts` becomes vestigial. **Removing it is a follow-up cleanup PR**, not part of this one — it touches a different handler with its own test surface and risks bundling unrelated changes.

## Rebuttal-proofing (per CLAUDE.md §"Rebutting council findings")

Pre-emptively addressing common raw-critique hallucinations:

- **"Missing RLS on `chunks` table"** — there is no `chunks` table. Sections live in the existing `notes` table with the existing `notes_select` / `notes_insert` / `notes_update` policies. `supabase/migrations/20260417000002_rls_policies.sql:49-74`. **Cite the migration line range in the PR description.**
- **"Missing cohort isolation"** — `parent_note_id` cohort match is enforced by `check_section_note_cohort_integrity` trigger (sketched above). Cited test: pgTAP suite + TS pipeline test in `ingest-pdf.test.ts`.
- **"Missing prompt-injection wrapping"** — the simplify + flashcard-gen prompts already wrap untrusted content. No new LLM callsite is added by chunking itself. Cited test: `packages/prompts/src/index.test.ts:8-10`.
- **"Missing rate limit on ingest triggers"** — Tier A (5/user/hour) already exists and gates the ingest entry point. Cited file: `packages/lib/ratelimit/src/index.ts:53-84` + `docs/security/rate-limiter-audit.md` row 1.
- **"Missing token budget"** — Tier B already covers it; section-level granularity doesn't change the total. Cited file: `packages/lib/ratelimit/src/index.ts:86-141`.
- **"PII in logs"** — followed `flashcard-gen.ts` structured-log pattern; new test in `ingest-pdf.test.ts` asserts no body content in error logs.
- **"Backwards-incompat for existing notes rows"** — new columns are nullable, no backfill required, existing reads return `null` for `parent_note_id` / `section_path`. No code path treats null specially as an error.

## Open questions for council

1. Should the parent note's `body_md` be the original full document body (as it is today, just retained), or replaced with a TOC-summary (e.g., generated by Haiku from section titles)? **Default in this plan: retain full body for now**, treat TOC-summary as a v1.1 enhancement. Argues for: zero behavior change for parent-only consumers (search, single-doc display). Argues against: doubles storage (full body in parent + sections in children). At 4-user scale, storage is not a constraint.
2. Should embeddings be computed for the parent note? **Default in this plan: only if body fits Voyage's 30k-char cap.** Argues for: sometimes you want to surface the whole-doc match. Argues against: section-level embeddings give finer retrieval; parent-level is redundant.
3. Cascading delete from parent → children: currently `on delete restrict`. **Default: keep restrict; the app deletes children explicitly in a transaction before the parent.** Argues against: a user-initiated "delete this document" would have to handle children one level up. Mitigation: add a `delete_note_with_sections(note_id)` Postgres function in a follow-up if/when the delete UI ships.

These are flagged for council to weigh in, NOT to block the plan. Defaults are conservative (retain existing behavior where possible); council is welcome to push back.

## Approval gate

Per CLAUDE.md §"What counts as approval": this plan is committed to `.harness/active_plan.md` on a feature branch. PR will trigger `.github/workflows/council.yml`. Implementation does NOT begin until:

1. ✅ Plan committed and tracked.
2. ⏳ Council `<!-- council-report -->` comment posted at-or-ahead-of the plan SHA.
3. ⏳ Human types `approved` / `ship it` / `proceed` after seeing the synthesis.

Last council: 2026-04-24T22:51:27+00:00 (PR #50 r4 PROCEED 9/10/6/10/10/9). Last commit: `e2b63d4` (session-end handoff). Branch for this plan: `claude/issue-39-semantic-chunking` (created on push).
