-- LLMwiki_StudyGroup v0 — RLS policies.
-- Every table has RLS enabled. Every verb has an explicit policy.
-- Storage objects in the 'ingest' bucket are keyed to ingestion_jobs.owner_id.
-- pgTAP coverage lives in /supabase/tests/rls.sql.

-- Helper: is this user a member of the cohort? ---------------------------
create or replace function public.is_cohort_member(cohort uuid)
returns boolean language sql stable security invoker as $$
  select exists (
    select 1
    from public.cohort_members cm
    where cm.cohort_id = cohort
      and cm.user_id = auth.uid()
  );
$$;

-- cohorts ----------------------------------------------------------------
alter table public.cohorts enable row level security;

create policy cohorts_select on public.cohorts
  for select to authenticated
  using (public.is_cohort_member(id));

-- Writes deny for authenticated; service role bypasses RLS (used by the
-- seed migration + future admin RPCs).
create policy cohorts_no_writes on public.cohorts
  for all to authenticated
  using (false) with check (false);

-- cohort_members ---------------------------------------------------------
alter table public.cohort_members enable row level security;

create policy cohort_members_select on public.cohort_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.cohort_members self
      where self.cohort_id = cohort_members.cohort_id
        and self.user_id = auth.uid()
        and self.role = 'admin'
    )
  );

create policy cohort_members_no_writes on public.cohort_members
  for all to authenticated
  using (false) with check (false);

-- notes ------------------------------------------------------------------
alter table public.notes enable row level security;

create policy notes_select on public.notes
  for select to authenticated
  using (public.is_cohort_member(cohort_id));

create policy notes_insert on public.notes
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.is_cohort_member(cohort_id)
  );

create policy notes_update on public.notes
  for update to authenticated
  using (
    author_id = auth.uid()
    and public.is_cohort_member(cohort_id)
  )
  with check (
    author_id = auth.uid()
    and public.is_cohort_member(cohort_id)
  );

create policy notes_no_delete on public.notes
  for delete to authenticated
  using (false);

-- concept_links ----------------------------------------------------------
alter table public.concept_links enable row level security;

create policy concept_links_select on public.concept_links
  for select to authenticated
  using (public.is_cohort_member(cohort_id));

-- Writes deny; linker runs as service role + trigger guards cohort integrity.
create policy concept_links_no_writes on public.concept_links
  for all to authenticated
  using (false) with check (false);

-- ingestion_jobs ---------------------------------------------------------
alter table public.ingestion_jobs enable row level security;

create policy ingestion_jobs_select on public.ingestion_jobs
  for select to authenticated
  using (public.is_cohort_member(cohort_id));

create policy ingestion_jobs_insert on public.ingestion_jobs
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and public.is_cohort_member(cohort_id)
  );

-- Critical (r1 security non-negotiable 3): UPDATE denied for authenticated.
-- Status transitions flow through the Inngest worker with the service role.
-- Never rely on service-role bypass alone as the control — this is the policy.
create policy ingestion_jobs_no_update on public.ingestion_jobs
  for update to authenticated
  using (false) with check (false);

create policy ingestion_jobs_no_delete on public.ingestion_jobs
  for delete to authenticated
  using (false);

-- srs_cards + review_history (user-owned, no cohort-wide read) -----------
alter table public.srs_cards enable row level security;

create policy srs_cards_own on public.srs_cards
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter table public.review_history enable row level security;

create policy review_history_own on public.review_history
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- note_views (user-owned; write-on-view via server action) ---------------
alter table public.note_views enable row level security;

create policy note_views_own on public.note_views
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ========================================================================
-- STORAGE RLS (r4 security must-do 1)
-- ------------------------------------------------------------------------
-- Bucket: 'ingest'. Object naming convention: 'ingest/<job_id>.pdf'.
-- IMPORTANT: this policy parses the object name via split_part. Changing the
-- naming convention WITHOUT updating this policy breaks cohort isolation for
-- uploads. The pgTAP case in /supabase/tests/rls.sql gates deploys by
-- asserting a divergent path fails access. A v1 improvement is to move
-- owner_id into storage.objects.metadata and match on that (see plan §3a).
-- ========================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('ingest', 'ingest', false, 26214400) -- 25 MiB hard cap
on conflict (id) do nothing;

-- Helper: extract the job id UUID prefix from an object name.
create or replace function public.ingest_object_job_id(object_name text)
returns uuid language sql immutable as $$
  select split_part(object_name, '.', 1)::uuid;
$$;

create policy ingest_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'ingest'
    and exists (
      select 1 from public.ingestion_jobs ij
      where ij.id = public.ingest_object_job_id(storage.objects.name)
        and ij.owner_id = auth.uid()
    )
  );

create policy ingest_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'ingest'
    and exists (
      select 1 from public.ingestion_jobs ij
      where ij.id = public.ingest_object_job_id(storage.objects.name)
        and ij.owner_id = auth.uid()
    )
  );

create policy ingest_objects_no_update on storage.objects
  for update to authenticated
  using (bucket_id <> 'ingest');

create policy ingest_objects_no_delete on storage.objects
  for delete to authenticated
  using (bucket_id <> 'ingest');
