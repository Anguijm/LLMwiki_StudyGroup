-- Down-migration for PR #48 schema changes. Council r1 arch fold.
-- Run in reverse order of the up migrations:
--   1. Drop the function (20260424000002).
--   2. Drop the unique index + column (20260424000001).
--
-- IMPORTANT: this file is NOT auto-applied by supabase migrate up. It is
-- preserved as an operator-runnable script for emergency rollback. Apply
-- via `supabase db reset` against a staging snapshot or psql against the
-- project's connection string.

drop function if exists public.fn_review_card(
  uuid, smallint, jsonb, timestamptz, jsonb, text
);

drop index if exists public.review_history_idempotency_unique;

alter table public.review_history
  drop column if exists idempotency_key;
