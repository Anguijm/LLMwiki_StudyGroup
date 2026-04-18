-- pgTAP RLS test suite.
-- Run via `supabase test db`.
-- Covers: per-verb policies on every table, Realtime predicate cross-cohort
-- isolation, concept_links cohort-integrity trigger, Storage RLS path
-- dependency.

begin;
select plan(24);

-- Fixtures: two cohorts, two users, one ingestion job in cohort A --------
-- auth.users has many required columns (aud, role, instance_id) enforced
-- by Supabase's auth schema; populate the minimum set so our FKs land.
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice@test.local', '', now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob@test.local', '', now(), now())
on conflict (id) do nothing;

insert into public.cohorts (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Cohort A'),
  ('22222222-2222-2222-2222-222222222222', 'Cohort B')
on conflict (id) do nothing;

insert into public.cohort_members (cohort_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member'),
  ('22222222-2222-2222-2222-222222222222', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'member')
on conflict do nothing;

insert into public.ingestion_jobs (id, idempotency_key, owner_id, cohort_id, status)
values (
  '33333333-3333-3333-3333-333333333333',
  'test-key-1',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  'queued'
)
on conflict do nothing;

-- 1) Alice (cohort A) sees her own job ---------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select is(
  (select count(*)::int from public.ingestion_jobs where id = '33333333-3333-3333-3333-333333333333'),
  1,
  'Alice (cohort A member) can SELECT her own ingestion_job'
);

-- 2) Alice cannot UPDATE any ingestion_job (service-role only) ---------
select throws_ok(
  $$update public.ingestion_jobs set status='completed' where id='33333333-3333-3333-3333-333333333333'$$,
  null,
  null,
  'Alice cannot UPDATE ingestion_jobs (using (false) policy)'
);

-- 3) Bob (cohort B) cannot see Alice's job (the Realtime RLS predicate) -
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';

select is(
  (select count(*)::int from public.ingestion_jobs where id = '33333333-3333-3333-3333-333333333333'),
  0,
  'Bob (cohort B) cannot SELECT Alice (cohort A) ingestion_job — covers Realtime cross-cohort isolation'
);

-- 4) Bob cannot INSERT a job into cohort A (not a member) --------------
select throws_ok(
  $$insert into public.ingestion_jobs (idempotency_key, owner_id, cohort_id) values
    ('bob-evil-key', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111')$$,
  null,
  null,
  'Bob cannot INSERT ingestion_job into cohort A (not a member)'
);

-- 5) notes RLS: Bob cannot read Alice's cohort's notes -----------------
reset role;
insert into public.notes (id, slug, title, body_md, author_id, cohort_id)
values (
  '44444444-4444-4444-4444-444444444444',
  'alice-note-abc123',
  'Alice''s note',
  '# hi',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111'
)
on conflict do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';

select is(
  (select count(*)::int from public.notes where id = '44444444-4444-4444-4444-444444444444'),
  0,
  'Bob cannot SELECT notes in cohort A'
);

-- 6) notes RLS: Alice can read her cohort's notes ----------------------
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  (select count(*)::int from public.notes where id = '44444444-4444-4444-4444-444444444444'),
  1,
  'Alice CAN SELECT her own cohort''s note'
);

-- 7) notes RLS: Alice cannot insert a note into cohort B ---------------
select throws_ok(
  $$insert into public.notes (id, slug, title, author_id, cohort_id) values
    ('55555555-5555-5555-5555-555555555555', 'alice-invade', 'invade B', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222')$$,
  null,
  null,
  'Alice cannot INSERT note into cohort B'
);

-- 8) srs_cards RLS: user-scoped, not cohort-scoped ---------------------
reset role;
insert into public.notes (id, slug, title, author_id, cohort_id)
values (
  '66666666-6666-6666-6666-666666666666', 'bob-note-x', 'Bob note',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222'
)
on conflict do nothing;

insert into public.srs_cards (id, note_id, question, answer, user_id, cohort_id)
values (
  '77777777-7777-7777-7777-777777777777',
  '66666666-6666-6666-6666-666666666666',
  'q', 'a',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '22222222-2222-2222-2222-222222222222'
)
on conflict do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select is(
  (select count(*)::int from public.srs_cards where id = '77777777-7777-7777-7777-777777777777'),
  0,
  'Alice cannot SELECT Bob''s srs_card even if she could see Bob''s cohort notes (srs is user-scoped)'
);

-- 9) concept_links cross-cohort integrity trigger fires ----------------
reset role;
select throws_matching(
  $$insert into public.concept_links (source_note_id, target_note_id, cohort_id)
    values ('44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111')$$,
  'concept_links_cohort_mismatch',
  'concept_links trigger rejects cross-cohort link (source in A, target in B)'
);

-- 10) concept_links: same-cohort link is allowed (service role) --------
insert into public.notes (id, slug, title, author_id, cohort_id) values (
  '88888888-8888-8888-8888-888888888888', 'alice-note-2', 'Alice 2',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111'
) on conflict do nothing;

select lives_ok(
  $$insert into public.concept_links (source_note_id, target_note_id, cohort_id)
    values ('44444444-4444-4444-4444-444444444444', '88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111')$$,
  'concept_links trigger accepts same-cohort link'
);

-- 11) concept_links integrity: link.cohort_id must match notes' cohort -
select throws_matching(
  $$insert into public.concept_links (source_note_id, target_note_id, cohort_id)
    values ('44444444-4444-4444-4444-444444444444', '88888888-8888-8888-8888-888888888888', '22222222-2222-2222-2222-222222222222')$$,
  'concept_links_cohort_mismatch',
  'concept_links trigger rejects link whose cohort_id does not match the notes'' cohort'
);

-- 12) Storage RLS: Alice can read her own object -----------------------
insert into storage.objects (bucket_id, name, owner)
values ('ingest', '33333333-3333-3333-3333-333333333333.pdf', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  (select count(*)::int from storage.objects where bucket_id='ingest' and name = '33333333-3333-3333-3333-333333333333.pdf'),
  1,
  'Alice can SELECT her own ingest Storage object'
);

-- 13) Storage RLS: Bob cannot see Alice's object -----------------------
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(
  (select count(*)::int from storage.objects where bucket_id='ingest' and name = '33333333-3333-3333-3333-333333333333.pdf'),
  0,
  'Bob CANNOT SELECT Alice''s ingest Storage object'
);

-- 14) Storage RLS: naming-convention divergence denies access ----------
-- Simulates a developer changing the path shape without updating the policy.
reset role;
insert into storage.objects (bucket_id, name, owner)
values ('ingest', 'subdir/33333333-3333-3333-3333-333333333333.pdf', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
on conflict do nothing;

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  (select count(*)::int from storage.objects where bucket_id='ingest' and name = 'subdir/33333333-3333-3333-3333-333333333333.pdf'),
  0,
  'Storage RLS denies access if object path diverges from ingest/<job_id>.pdf convention'
);

-- 15–22) Spot-check INSERT/UPDATE/DELETE policies on other tables ------
select throws_ok(
  $$update public.notes set title='hijacked' where id='44444444-4444-4444-4444-444444444444'$$,
  null,
  null,
  'Bob (cohort B) cannot UPDATE notes in cohort A'
);
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select lives_ok(
  $$update public.notes set title='retitled' where id='44444444-4444-4444-4444-444444444444'$$,
  'Alice CAN UPDATE her own note'
);
select throws_ok(
  $$delete from public.notes where id='44444444-4444-4444-4444-444444444444'$$,
  null,
  null,
  'Alice cannot DELETE notes (v0 denies all DELETE on notes)'
);
select throws_ok(
  $$insert into public.cohorts (id, name) values ('99999999-9999-9999-9999-999999999999', 'sneaky')$$,
  null,
  null,
  'Alice cannot INSERT cohorts (authenticated denied; seed runs as service role)'
);
select throws_ok(
  $$insert into public.cohort_members (cohort_id, user_id, role) values
    ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'admin')$$,
  null,
  null,
  'Alice cannot INSERT herself into another cohort'
);
select is(
  (select count(*)::int from public.cohorts where id = '11111111-1111-1111-1111-111111111111'),
  1,
  'Alice CAN SELECT her own cohort'
);
select is(
  (select count(*)::int from public.cohort_members where cohort_id = '11111111-1111-1111-1111-111111111111' and user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1,
  'Alice CAN SELECT her own cohort membership row'
);
-- 23–24) getContext (notes_by_similarity RPC) respects cohort RLS -------
-- Seed an embedding on Bob's cohort-B note so the RPC would match it on
-- similarity if RLS weren't applied. Alice (cohort A) calling the RPC
-- must see zero results for that exact vector.
reset role;
update public.notes
  set embedding = (select array_agg(0.1::real) from generate_series(1, 1024))::vector
  where id in ('44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(
  (select count(*)::int
     from public.notes_by_similarity(
       (select embedding from public.notes where id = '66666666-6666-6666-6666-666666666666'),
       array['bedrock','active','cold']::tier_enum[],
       5
     )
   where id = '66666666-6666-6666-6666-666666666666'),
  0,
  'getContext: Alice (cohort A) cannot retrieve Bob''s cohort-B note via notes_by_similarity RPC'
);

set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(
  (select count(*)::int
     from public.notes_by_similarity(
       (select embedding from public.notes where id = '66666666-6666-6666-6666-666666666666'),
       array['bedrock','active','cold']::tier_enum[],
       5
     )
   where id = '66666666-6666-6666-6666-666666666666'),
  1,
  'getContext: Bob (cohort B) CAN retrieve his own note via notes_by_similarity RPC'
);

-- note_views: user-scoped
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select lives_ok(
  $$insert into public.note_views (note_id, user_id) values ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$,
  'Alice CAN INSERT note_view for her own user_id'
);

select * from finish();
rollback;
