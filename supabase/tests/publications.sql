-- pgTAP "publication lockfile" test (r7 security nice-to-have).
-- Asserts that the Realtime publication publishes EXACTLY the allow-listed
-- set of tables. A developer who accidentally enables Realtime on `notes`,
-- `cohort_members`, etc. causes this test to fail in CI before the
-- migration can land on main.

begin;
select plan(2);

-- Allow-list in v0: public.ingestion_jobs only.
select is(
  (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'),
  1,
  'supabase_realtime publication contains exactly 1 table in v0'
);

select is(
  (select schemaname || '.' || tablename
     from pg_publication_tables
     where pubname = 'supabase_realtime'
     order by schemaname, tablename
     limit 1),
  'public.ingestion_jobs',
  'the 1 published table is public.ingestion_jobs'
);

select * from finish();
rollback;
