# LLMwiki_StudyGroup — production scaffold (v0)

## Goal

Stand up a monorepo scaffold for the AI study wiki described in the kickoff
prompt, with ONE vertical slice fully working end-to-end before anything else
is built: a user can upload a PDF and, minutes later, read the ingested,
embedded, Haiku-simplified note at `/note/[slug]` on a deployed Vercel URL
backed by a real Supabase project.

**Everything past the vertical slice is v1+** and routes through a new plan
+ council run per CLAUDE.md. No graph UI, no FSRS review, no exam generator,
no weekly gap analysis, no YouTube/image/DOCX pipelines, no Discord push, no
cohort invite flow, no concept-link writeback in v0. Those are enumerated as
explicit non-goals below so the council can push back if it thinks any must
move into v0.

## Scope of v0 vertical slice

1. **Monorepo layout** (pnpm workspaces):
   ```
   /apps/web              Next.js 15 App Router (TS strict, Tailwind, shadcn/ui)
   /packages/db           Supabase client factories + typed schema + getContext()
   /packages/prompts      Versioned prompt files + shape evals (v0 ships: simplifier, ingest-pdf)
   /inngest               Inngest functions, step-scoped, idempotent
   /supabase              SQL migrations, seed, policies
   ```
   Root: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.env.example`,
   `.nvmrc`, `eslint`, `prettier`. README deploy steps for Vercel + Supabase +
   Inngest. Single lockfile at root.

2. **Supabase schema + migrations** (SQL files under `/supabase/migrations`):
   - `notes(id uuid pk, slug text unique, title text, body_md text, tier tier_enum, author_id uuid fk auth.users, embedding vector(1024), source_ingestion_id uuid fk ingestion_jobs, created_at timestamptz, updated_at timestamptz)`
     - `tier_enum = ('bedrock','active','cold')`; default `'active'`.
     - HNSW index on `embedding` (vector_cosine_ops).
     - `updated_at` trigger.
   - `concept_links(source_note_id uuid, target_note_id uuid, strength real, created_at)` — table shipped, not populated in v0.
   - `srs_cards(id uuid pk, note_id uuid fk, question text, answer text, fsrs_state jsonb, due_at timestamptz, user_id uuid fk, created_at)` — table shipped, not populated in v0.
   - `review_history(id uuid pk, card_id uuid fk, user_id uuid fk, rating smallint, reviewed_at timestamptz, prev_state jsonb, next_state jsonb)` — table shipped.
   - `ingestion_jobs(id uuid pk, kind text, status text, source_url text, storage_path text, owner_id uuid fk, cohort_id uuid fk, error jsonb, created_at, updated_at)`.
   - `cohort_members(cohort_id uuid, user_id uuid fk, role text, created_at, primary key (cohort_id, user_id))`.
   - `cohorts(id uuid pk, name text, created_at)`.
   - Every user-data table has a `cohort_id` column for RLS scoping.

3. **RLS policies (v0 enables on every table):**
   - `notes`: select allowed if `exists(select 1 from cohort_members cm where cm.cohort_id = notes.cohort_id and cm.user_id = auth.uid())`. Insert/update allowed only when `author_id = auth.uid()` AND the same cohort-membership check on the target `cohort_id`.
   - `srs_cards`, `review_history`: select+write only where `user_id = auth.uid()`.
   - `ingestion_jobs`: select where cohort member; insert where owner = auth.uid(); update only from service role (Inngest worker).
   - `concept_links`: select where both endpoints are in a cohort the caller belongs to.
   - `cohorts`, `cohort_members`: select where `user_id = auth.uid()`; write via admin-only RPC (stub in v0, not exposed in UI).
   - Service-role key **never** reaches the client. Server-only. Verified by the Supabase client factory in `/packages/db`.

4. **Ingest.pdf vertical slice (Inngest):**
   - `ingest.pdf.requested` → create `ingestion_jobs` row, upload to Supabase Storage bucket `ingest/<job_id>.pdf`.
   - Step 1 `parse`: call Reducto (feature-flagged to LlamaParse fallback), store structured JSON back to Storage.
   - Step 2 `chunk`: deterministic chunker (heading-aware, ~1.2k tokens each).
   - Step 3 `simplify`: Haiku 4.5 on each chunk via `/packages/prompts/simplifier@v1`; concatenate to `body_md`. Per-call cost noted at callsite.
   - Step 4 `embed`: Voyage-3 embedding on the full `body_md`.
   - Step 5 `persist`: insert `notes` row with tier=`active`, slug derived from title+short hash, cohort_id = author's default cohort.
   - Step 6 `post-ingest.enqueue`: emits two follow-up events (`note.created.link` and `note.created.flashcards`) that are **no-op stubs in v0** — they log and exit, so the wiring is proved but the cost is zero until v1.
   - Every step: `step.run` + idempotent by `ingestion_jobs.id`. Retries capped. Failures update `ingestion_jobs.status='failed'` with the error JSON; never silently swallow.
   - Rate limit: per-user 5 PDF ingests/hour at the API route, enforced via a Supabase row insert on a `rate_limit_events` table with a check constraint. (If council prefers Upstash, swap — I'm fine either way.)

5. **Frontend (v0):**
   - `/` — "Your notes" list (Supabase server component read), "Upload PDF" button, "Recent ingestion jobs" status table driven by a Realtime channel on `ingestion_jobs`.
   - `/note/[slug]` — server-rendered Markdown via `react-markdown` + `rehype-sanitize` (never `dangerouslySetInnerHTML` with raw ingested content), shows title, tier badge, author, created_at. "Backlinks" and "Graph neighborhood" are **placeholder empty states** in v0.
   - Auth: Supabase Auth (email magic link). One hardcoded seed cohort in migrations; new users join it on first login via a server-side upsert. Full invite UI deferred.
   - UI: Tailwind + shadcn/ui `button`, `card`, `input`, `toast` only. No design polish pass in v0.

6. **Prompts + evals (v0 subset):**
   - `/packages/prompts/simplifier/v1.md` — Haiku. Input: raw chunk text. Output: cleaned Markdown with preserved headings. Eval: non-empty, length ≥ 50% of input, no chain-of-thought leaked.
   - `/packages/prompts/ingest-pdf/v1.md` — orchestration-level instructions (used as the step.simplify system prompt wrapper).
   - Eval harness: plain TS in `/packages/prompts/__evals__` — input fixture → shape-check function → exit code. Runnable via `pnpm eval`.
   - Other prompt files (linker, flashcard-gen, gap-analysis, review-packet) ship as **empty v0 stubs with TODO headers** so the directory is discoverable but no production code imports them.

7. **`.env.example`** — every key needed for v0 AND v1+ listed with comments:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `SUPABASE_PROJECT_REF`
   - `ANTHROPIC_API_KEY`
   - `VOYAGE_API_KEY`
   - `REDUCTO_API_KEY`, `LLAMAPARSE_API_KEY` (one required, other optional)
   - `ASSEMBLYAI_API_KEY` (v1+)
   - `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`
   - `DISCORD_WEBHOOK_URL` (v1+)
   - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (v1+ web push)
   - `APP_BASE_URL`

8. **README deploy runbook**:
   - `pnpm install`, copy `.env.example`, `supabase link && supabase db push`, seed cohort, `vercel link && vercel env pull`, register Inngest app at the Vercel URL, click-through Upload PDF → see rendered note.
   - Explicit "this is v0 — N features are intentionally stubbed" section linking to this plan.

## Non-goals for v0 (all deferred to v1+)

- YouTube/image/DOCX/MD/TXT ingest pipelines.
- Concept-link writeback (`[[wiki links]]` proposer) — stub function exists, body is a no-op.
- Flashcard generation from notes — stub function exists, no-op.
- `/graph` React Flow view.
- `/review` FSRS session + FSRS state transitions.
- `/exam/[name]` Opus-powered packet generator.
- `/cohort` invite management UI.
- Weekly gap analysis Inngest cron.
- Daily SRS web-push rollup.
- Three-tier `getContext(query, tier_scope)` retrieval helper — signature stubbed in `/packages/db`, body throws `NotImplementedError` so callers fail loud. (Or: ship with a minimal impl that just filters `notes` by tier and runs pgvector cosine. Council: which?)
- Full design / a11y polish pass.

## Explicit tradeoffs + open questions for the council

- **Reducto vs LlamaParse as v0 default.** Kickoff says "Reducto (or LlamaParse)". Reducto has better layout fidelity; LlamaParse is cheaper and has a free tier that's fine for a 4-person cohort. My default: Reducto with a feature flag (`PDF_PARSER=reducto|llamaparse`) so we can swap without code change. Cost reviewer should confirm this fits the $75–110/mo cap.
- **Rate limiting in DB vs Upstash.** DB keeps the stack minimal (no new vendor); Upstash is the industry-default. Default to DB-backed for v0, Upstash if Bugs reviewer argues it.
- **`getContext` in v0 — stub vs minimal impl.** Stub is faster to ship and honest about scope. Minimal impl (pgvector cosine + tier filter) lets the note page surface "related notes" in v0 and gives the v1 linker a real function to import. Architecture reviewer should pick.
- **Auth: email magic link vs OAuth.** Magic link is simpler and works on phones (kickoff user is phone-first). OAuth adds a vendor. Default: magic link only.
- **Cohort seeding.** Kickoff mentions a 4-person cohort. v0 seeds ONE cohort and auto-joins every new signup to it (safe because deploy is still private). This is a seam, not a production invite system — flagged explicitly in README.
- **Storage bucket access.** `ingest` bucket is private; signed URLs only. Note-page attachments (none in v0) would get their own bucket later.
- **TypeScript strict + `any`.** Banned without a one-line justification comment. Supabase-generated types regenerated on every migration via `supabase gen types typescript`.
- **No backwards-compat scaffolding.** This is a greenfield scaffold; no deprecated shims, no feature flags for "old vs new" anything.

## Security surface v0 touches (for Security reviewer)

- New Supabase project, every table RLS-enabled from day one. Service-role key server-only.
- New Storage bucket `ingest` (private, signed-URL reads).
- Anthropic, Voyage, Reducto/LlamaParse API keys — server-only, read from env at request time, never logged.
- Inngest webhook endpoint signs payloads with `INNGEST_SIGNING_KEY`; reject unsigned requests.
- Markdown rendering path uses `rehype-sanitize`; ingested content never lands in `dangerouslySetInnerHTML`.
- Uploaded PDFs: size cap (25 MB), MIME sniff, extension check. Oversized/wrong-type uploads rejected before hitting Storage.
- No PII or keys in logs (Inngest step logs pass through a redactor helper in `/packages/db/logging.ts`).
- Rate limits: 5 PDF ingests/user/hour; 60 note reads/min/user (soft, Next middleware).
- Gitleaks config already in repo — add `.env.local` patterns if not present.

## Cost posture v0 (for Cost reviewer)

- Haiku 4.5 simplification: ~1.2k-token chunks, avg PDF = 20 chunks = ~24k tokens in + ~18k out per PDF. At Haiku prices this is <$0.05/PDF. At 4 users × 5 PDFs/wk = ~80 PDFs/mo = <$4/mo.
- Voyage-3 embedding: 1 call per note, <$0.01 each at this volume.
- Reducto: free tier likely covers 80 PDFs/mo; LlamaParse fallback is free up to 1000 pages/day.
- Supabase free tier covers 4-user dev cohort; upgrade to Pro ($25/mo) when we leave dev.
- Vercel Hobby is fine for v0; Pro ($20/mo) if we need preview envs per PR.
- Inngest free tier (50k steps/mo) covers v0 easily.
- **Total v0 recurring: $0–25/mo.** Well inside the $75–110/mo cap.

## Rollout

- Land in one PR on `claude/scaffold-ai-study-wiki-3mSDf`.
- Per CLAUDE.md "Before committing" gates: `pnpm lint`, `pnpm typecheck`, `pnpm test` (the eval harness counts), security checklist reviewed.
- After merge, I will deploy to Vercel + Supabase and record the working URL in the PR description, then stop and wait for the human to kick off v1 planning.

## Risks

- Reducto key not yet provisioned → v0 blocked on the human handing me a key, OR we default to LlamaParse and let the Reducto path be a code-reviewed-but-untested branch.
- Inngest requires a deployed URL to register — local dev uses the Inngest dev server, production wiring gets tested only after first Vercel deploy.
- Supabase vector HNSW index needs pgvector ≥ 0.5; confirm the Supabase project version before migration.
- Greenfield scaffold has the usual "works on my machine" risk until the deploy runbook is followed end to end on a second machine.
