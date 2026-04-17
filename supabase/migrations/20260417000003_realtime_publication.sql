-- LLMwiki_StudyGroup v0 — Realtime publication allow-list.
-- Only ingestion_jobs is exposed via Realtime in v0. Adding a table here is
-- a security-review event (see Realtime exposure map in README). The pgTAP
-- lockfile test in /supabase/tests/publications.sql asserts the published
-- set equals this allow-list exactly.

-- supabase_realtime publication is created by Supabase automatically.
-- We drop-and-recreate idempotently so this migration can re-run locally.
do $$
begin
  if exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    -- Remove everything first; re-add only our allow-list.
    execute 'drop publication supabase_realtime';
  end if;

  create publication supabase_realtime for table public.ingestion_jobs;
end $$;
