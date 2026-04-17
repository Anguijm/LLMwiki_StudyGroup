-- LLMwiki_StudyGroup v0 — initial schema.
-- Plan reference: .harness/active_plan.md (approved r8, SHA c1d4a5f).
-- Every table has a cohort_id column for RLS; every FK uses ON DELETE RESTRICT
-- to avoid silent cascades. RLS policies land in 20260417000002_rls_policies.sql.

-- Required extensions ----------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "vector"; -- voyage-3 embeddings (1024 dims)
create extension if not exists "pgcrypto"; -- digest() for slug hashing fallbacks

-- Tier enum (notes live in one of three memory tiers) --------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'tier_enum') then
    create type tier_enum as enum ('bedrock', 'active', 'cold');
  end if;
end$$;

-- updated_at trigger helper ----------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Cohorts ----------------------------------------------------------------
create table if not exists public.cohorts (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.cohort_members (
  cohort_id uuid not null references public.cohorts(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (cohort_id, user_id)
);

-- Ingestion jobs ---------------------------------------------------------
-- NOTE: source_url column deliberately omitted in v0 per r2 security non-
-- negotiable 1. Re-added in v1 only with SSRF guards (private-IP block +
-- domain allowlist) and a full plan + council round.
create table if not exists public.ingestion_jobs (
  id uuid primary key default uuid_generate_v4(),
  idempotency_key text not null,
  kind text not null default 'pdf',
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed','cancelled')),
  owner_id uuid not null references auth.users(id) on delete restrict,
  cohort_id uuid not null references public.cohorts(id) on delete restrict,
  storage_path text,
  error jsonb,
  chunk_count int,
  -- reserved_tokens makes token_budget_reserve step idempotent on retry.
  -- onFailure hook atomically sets this to null and refunds Upstash (see r5
  -- security must-do 1 in active_plan.md).
  reserved_tokens int,
  started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency: (owner, key) unique; sha256(file_bytes) on the client side.
-- Partial index (r2-diff council bug fix): excludes terminally-failed jobs so
-- the "Retry" CTA on a system_transient failure can create a new job with the
-- same content-hash key. Without this, re-uploading the same file after a
-- failure would collide on the old row and silently "succeed" against the
-- failed job.
create unique index if not exists ingestion_jobs_owner_key_idx
  on public.ingestion_jobs(owner_id, idempotency_key)
  where status not in ('failed', 'cancelled');

create trigger ingestion_jobs_set_updated_at
  before update on public.ingestion_jobs
  for each row execute function public.set_updated_at();

-- Notes ------------------------------------------------------------------
create table if not exists public.notes (
  id uuid primary key, -- app-generated in the Inngest persist step (not default)
  slug text not null unique,
  title text not null,
  body_md text not null default '',
  tier tier_enum not null default 'active',
  author_id uuid not null references auth.users(id) on delete restrict,
  cohort_id uuid not null references public.cohorts(id) on delete restrict,
  embedding vector(1024),
  source_ingestion_id uuid unique references public.ingestion_jobs(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger notes_set_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- HNSW index for pgvector cosine similarity (voyage-3 uses cosine).
-- Requires pgvector >= 0.5.0 which Supabase ships in the default image.
create index if not exists notes_embedding_hnsw_idx
  on public.notes using hnsw (embedding vector_cosine_ops);

-- Concept links (not populated in v0; shipped for RLS + trigger coverage) -
create table if not exists public.concept_links (
  source_note_id uuid not null references public.notes(id) on delete restrict,
  target_note_id uuid not null references public.notes(id) on delete restrict,
  cohort_id uuid not null references public.cohorts(id) on delete restrict,
  strength real,
  created_at timestamptz not null default now(),
  primary key (source_note_id, target_note_id)
);

-- Cross-cohort integrity trigger (r4 security must-do 2).
-- RLS guards reads; this trigger guards writes against service-role / buggy
-- internal callers that could otherwise insert a link across cohorts.
create or replace function public.check_concept_link_cohort_integrity()
returns trigger language plpgsql as $$
declare
  src_cohort uuid;
  tgt_cohort uuid;
begin
  select cohort_id into src_cohort from public.notes where id = new.source_note_id;
  select cohort_id into tgt_cohort from public.notes where id = new.target_note_id;

  if src_cohort is null or tgt_cohort is null then
    raise exception 'concept_links references missing note(s): source=%, target=%',
      new.source_note_id, new.target_note_id;
  end if;

  if src_cohort <> tgt_cohort or src_cohort <> new.cohort_id then
    -- Emit a high-signal, structured error for the log drain. The message is
    -- designed to be greppable by monitoring.
    raise exception 'concept_links_cohort_mismatch: source_cohort=%, target_cohort=%, link_cohort=%',
      src_cohort, tgt_cohort, new.cohort_id;
  end if;

  return new;
end;
$$;

create constraint trigger concept_links_cohort_integrity
  after insert or update on public.concept_links
  deferrable initially immediate
  for each row execute function public.check_concept_link_cohort_integrity();

-- SRS cards (schema only in v0) ------------------------------------------
create table if not exists public.srs_cards (
  id uuid primary key default uuid_generate_v4(),
  note_id uuid not null references public.notes(id) on delete restrict,
  question text not null,
  answer text not null,
  fsrs_state jsonb not null default '{}'::jsonb,
  due_at timestamptz,
  user_id uuid not null references auth.users(id) on delete restrict,
  cohort_id uuid not null references public.cohorts(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.review_history (
  id uuid primary key default uuid_generate_v4(),
  card_id uuid not null references public.srs_cards(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  rating smallint not null,
  reviewed_at timestamptz not null default now(),
  prev_state jsonb,
  next_state jsonb
);

-- Notes view counter (powers the user-centric kill criterion) ------------
-- One row per (note, user, day) — upsert on view.
create table if not exists public.note_views (
  note_id uuid not null references public.notes(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  viewed_day date not null default (now() at time zone 'utc')::date,
  view_count int not null default 1,
  primary key (note_id, user_id, viewed_day)
);
