-- Council r1 bugs non-negotiable on PR #48: idempotency key for retry-safe
-- reviews. A client retry after a network drop must NOT double-apply the
-- rating (which would advance fsrs_state twice + create a duplicate
-- review_history row).
--
-- Backfill: existing rows (none in v0 — table is empty pre-PR-#48) get a
-- generated UUID via uuid_generate_v4() so the not-null constraint holds
-- even on re-runs against a populated test DB. The unique
-- (user_id, idempotency_key) index is the dedup key.

alter table public.review_history
  add column idempotency_key text;

update public.review_history
  set idempotency_key = uuid_generate_v4()::text
  where idempotency_key is null;

alter table public.review_history
  alter column idempotency_key set not null;

create unique index review_history_idempotency_unique
  on public.review_history (user_id, idempotency_key);

comment on column public.review_history.idempotency_key is
  'Client-generated UUIDv4 per rating click. Retries with the same key are no-ops via the (user_id, idempotency_key) unique index. Council r1 bugs non-negotiable on PR #48.';
