-- atomic_null_reserved_tokens(job_id) — returns the PRE-update value of
-- ingestion_jobs.reserved_tokens and sets it to NULL atomically.
--
-- Required by the function-level onFailure hook to make the token refund
-- idempotent: the DB update is the claim; only a caller that reads a
-- non-null return value refunds Upstash. A retried hook reads NULL and
-- no-ops.
--
-- Implementation: SELECT ... FOR UPDATE in the same transaction captures
-- the pre-update value, then the UPDATE sets it to NULL. Supabase js's
-- .update().select() returns the POST-update row, so we need this SQL
-- helper to read the previous value. Both statements live in a single
-- function-call transaction in Postgres, so the read+write is atomic
-- under concurrent access.

create or replace function public.atomic_null_reserved_tokens(_job_id uuid)
returns table (reserved_tokens_before int)
language plpgsql security invoker as $$
declare
  prev int;
begin
  -- Lock the row and capture the pre-update value.
  select reserved_tokens
    into prev
    from public.ingestion_jobs
    where id = _job_id
    for update;

  -- Null it out in the same transaction.
  update public.ingestion_jobs
    set reserved_tokens = null
    where id = _job_id;

  reserved_tokens_before := prev;
  return next;
end;
$$;

grant execute on function public.atomic_null_reserved_tokens(uuid) to service_role;
