-- pgTAP test for #39 phase 1: notes section hierarchy.
-- Covers check_section_note_cohort_integrity trigger (INSERT + UPDATE)
-- and insert_note_with_sections RPC (success + atomic rollback).
--
-- Council r1 + r2 folds verified here:
--   - Trigger blocks UPDATE re-parenting (security must-do #2).
--   - RPC rolls back parent on child failure (security must-do #1).
--   - section_path persists as jsonb (encoding/escape resolution).
--
-- Per CLAUDE.md §"Rebutting council findings" rule #2: db-tests is
-- continue-on-error (#7) so this file is corroborating, NOT the
-- load-bearing security proof — that lives in TS tests in phase 3.
-- Written so when #7 is fixed the suite is ready to load-bear.

begin;
select plan(12);

-- ===== Fixtures =========================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice-39@test.local', '', now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob-39@test.local', '', now(), now())
on conflict (id) do nothing;

insert into public.cohorts (id, name) values
  ('11111111-1111-1111-1111-111111111139', 'Cohort A (#39)'),
  ('22222222-2222-2222-2222-222222222239', 'Cohort B (#39)')
on conflict (id) do nothing;

insert into public.cohort_members (cohort_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111139', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', 'member'),
  ('22222222-2222-2222-2222-222222222239', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', 'member')
on conflict do nothing;

-- Two parent notes (one per cohort) used by trigger and RPC tests.
insert into public.notes (id, slug, title, body_md, tier, author_id, cohort_id)
values
  ('cccccccc-cccc-cccc-cccc-ccccccccca39', 'parent-a-39', 'Parent A', 'doc body', 'active',
   'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '11111111-1111-1111-1111-111111111139'),
  ('cccccccc-cccc-cccc-cccc-cccccccccb39', 'parent-b-39', 'Parent B', 'doc body', 'active',
   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', '22222222-2222-2222-2222-222222222239')
on conflict (id) do nothing;

-- ===== 1) Trigger blocks INSERT with mismatched cohort ==================
select throws_ok(
  $$insert into public.notes (id, slug, title, body_md, tier, author_id, cohort_id, parent_note_id, section_path)
    values ('dddddddd-dddd-dddd-dddd-dddddddd0001', 'bad-section-1', 'Bad Section', 'x', 'active',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39',
            '22222222-2222-2222-2222-222222222239',  -- cohort B
            'cccccccc-cccc-cccc-cccc-ccccccccca39',  -- parent in cohort A
            '["Bad"]'::jsonb)$$,
  'P0001',
  null,
  'INSERT with section_cohort != parent_cohort raises section_note_cohort_mismatch'
);

-- ===== 2) Trigger blocks INSERT with self-parent ========================
select throws_ok(
  $$insert into public.notes (id, slug, title, body_md, tier, author_id, cohort_id, parent_note_id, section_path)
    values ('dddddddd-dddd-dddd-dddd-dddddddd0002', 'self-parent-39', 'Self', 'x', 'active',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
            '11111111-1111-1111-1111-111111111139',
            'dddddddd-dddd-dddd-dddd-dddddddd0002',  -- self
            '["Self"]'::jsonb)$$,
  'P0001',
  null,
  'INSERT with parent_note_id = id raises section_note_self_parent'
);

-- ===== 3) Trigger allows valid section INSERT (matching cohort) =========
select lives_ok(
  $$insert into public.notes (id, slug, title, body_md, tier, author_id, cohort_id, parent_note_id, section_path)
    values ('dddddddd-dddd-dddd-dddd-dddddddd0003', 'good-section-3', 'Good 3', 'x', 'active',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
            '11111111-1111-1111-1111-111111111139',
            'cccccccc-cccc-cccc-cccc-ccccccccca39',
            '["Chapter 1", "1.1"]'::jsonb)$$,
  'INSERT with matching cohort + valid parent succeeds'
);

-- ===== 4) Trigger allows root note (parent_note_id null) ================
select lives_ok(
  $$insert into public.notes (id, slug, title, body_md, tier, author_id, cohort_id)
    values ('dddddddd-dddd-dddd-dddd-dddddddd0004', 'root-doc-39', 'Root 4', 'x', 'active',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
            '11111111-1111-1111-1111-111111111139')$$,
  'INSERT with parent_note_id null succeeds (root document)'
);

-- ===== 5) Trigger blocks UPDATE re-parenting to different cohort ========
-- Council r1 security must-do #2: re-parenting attack.
-- Use the section inserted in test 3 (currently parented to cohort A).
-- Attempt to re-parent it to cohort B's parent.
select throws_ok(
  $$update public.notes
    set parent_note_id = 'cccccccc-cccc-cccc-cccc-cccccccccb39'  -- parent B
    where id = 'dddddddd-dddd-dddd-dddd-dddddddd0003'$$,
  'P0001',
  null,
  'UPDATE re-parenting section to cohort-B parent raises section_note_cohort_mismatch'
);

-- ===== 6) Trigger allows UPDATE within same cohort ======================
-- Add a second parent in cohort A to re-parent against.
insert into public.notes (id, slug, title, body_md, tier, author_id, cohort_id)
values ('cccccccc-cccc-cccc-cccc-ccccccccca40', 'parent-a-40', 'Parent A2', 'doc', 'active',
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '11111111-1111-1111-1111-111111111139')
on conflict (id) do nothing;

select lives_ok(
  $$update public.notes
    set parent_note_id = 'cccccccc-cccc-cccc-cccc-ccccccccca40'
    where id = 'dddddddd-dddd-dddd-dddd-dddddddd0003'$$,
  'UPDATE re-parenting section within same cohort succeeds'
);

-- ===== 7) RPC inserts parent + sections atomically =====================
select is(
  (select (insert_note_with_sections(
    jsonb_build_object(
      'id', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee007',
      'slug', 'rpc-parent-7',
      'title', 'RPC Parent 7',
      'body_md', 'doc body',
      'tier', 'active',
      'author_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
      'cohort_id', '11111111-1111-1111-1111-111111111139'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'id', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee0a7',
        'slug', 'rpc-sec-a-7',
        'title', 'Section A',
        'body_md', 'sec a body',
        'tier', 'active',
        'author_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
        'cohort_id', '11111111-1111-1111-1111-111111111139',
        'section_path', jsonb_build_array('Section A')
      ),
      jsonb_build_object(
        'id', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee0b7',
        'slug', 'rpc-sec-b-7',
        'title', 'Section B',
        'body_md', 'sec b body',
        'tier', 'active',
        'author_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
        'cohort_id', '11111111-1111-1111-1111-111111111139',
        'section_path', jsonb_build_array('Section B')
      )
    )
  )).parent_id),
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeee007'::uuid,
  'RPC returns the parent_id from the input payload'
);

-- ===== 8) After successful RPC: 1 parent + 2 children visible ==========
select is(
  (select count(*)::int from public.notes
    where id in (
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeee007',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeee0a7',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeee0b7')),
  3,
  'RPC persisted parent + 2 sections (3 rows total)'
);

-- ===== 9) Children have parent_note_id set to RPC's parent =============
select is(
  (select count(*)::int from public.notes
    where parent_note_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee007'),
  2,
  'Both children carry parent_note_id pointing at the inserted parent'
);

-- ===== 10) section_path persists as jsonb array ========================
select is(
  (select section_path from public.notes
    where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeee0a7'),
  '["Section A"]'::jsonb,
  'section_path persists as jsonb array (no separator escaping needed)'
);

-- ===== 11) RPC rolls back parent on child failure (atomicity) ==========
-- A child with mismatched cohort_id triggers section_note_cohort_mismatch
-- inside the loop; the entire transaction must roll back, leaving the
-- parent NOT persisted. Council r1 security must-do #1.
select throws_ok(
  $$select insert_note_with_sections(
      jsonb_build_object(
        'id', 'ffffffff-ffff-ffff-ffff-fffffffff011',
        'slug', 'rpc-orphan-11',
        'title', 'Would-be Orphan',
        'body_md', 'doc body',
        'tier', 'active',
        'author_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39',
        'cohort_id', '11111111-1111-1111-1111-111111111139'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'id', 'ffffffff-ffff-ffff-ffff-fffffffff0a1',
          'slug', 'rpc-bad-child-11',
          'title', 'Bad Child',
          'body_md', 'x',
          'tier', 'active',
          'author_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39',
          'cohort_id', '22222222-2222-2222-2222-222222222239',  -- WRONG cohort
          'section_path', jsonb_build_array('Bad')
        )
      )
    )$$,
  'P0001',
  null,
  'RPC raises when child has cross-cohort cohort_id (atomicity setup)'
);

-- ===== 12) Parent from rolled-back call is NOT persisted ===============
select is(
  (select count(*)::int from public.notes
    where id = 'ffffffff-ffff-ffff-ffff-fffffffff011'),
  0,
  'Atomicity: failed RPC left no orphaned parent row'
);

select * from finish();
rollback;
