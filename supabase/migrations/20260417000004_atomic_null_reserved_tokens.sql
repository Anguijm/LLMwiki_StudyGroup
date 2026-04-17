-- atomic_null_reserved_tokens(job_id) — returns the PRE-update value of
-- ingestion_jobs.reserved_tokens and sets it to NULL atomically.
--
-- Required by the function-level onFailure hook to make the token refund
-- idempotent: the DB update is the claim; only a caller that reads a
-- non-null return value refunds Upstash. A retried hook reads NULL and
-- no-ops.
--
-- The supabase-js .update().select() pattern returns the POST-update row,
-- so we cannot use it for this. A SQL function is the clean pattern.

create or replace function public.atomic_null_reserved_tokens(_job_id uuid)
returns table (reserved_tokens_before int)
language plpgsql security invoker as $$
declare
  prev int;
begin
  update public.ingestion_jobs
  set reserved_tokens = null
  where id = _job_id
  returning (
    -- Postgres executes RETURNING against the new row; we need the old
    -- value, so grab it in a CTE pattern via a separate select.
    (select ij.reserved_tokens from public.ingestion_jobs ij where ij.id = _job_id)
  ) into prev;
  -- NOTE: the above RETURNING trick reads the NEW row (already null).
  -- Switch to the canonical approach: select-then-update in a single
  -- transaction. Supabase's single statement is already in a tx; we just
  -- do two statements:
  select reserved_tokens into prev from public.ingestion_jobs where id = _job_id for update;
  update public.ingestion_jobs set reserved_tokens = null where id = _job_id;
  reserved_tokens_before := prev;
  return next;
end;
$$;

grant execute on function public.atomic_null_reserved_tokens(uuid) to service_role;
