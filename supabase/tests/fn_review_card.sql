-- pgTAP test for fn_review_card (PR #48). Corroborating, NOT load-bearing
-- per the new CLAUDE.md §"Rebutting council findings" rule (#7 makes
-- db-tests `continue-on-error`). The consistently-passing failure-mode
-- proofs live in apps/web/app/review/actions.test.ts.
--
-- This file documents the function's contract at the database level so
-- that when #7 is fixed, the suite is ready to load-bear.

begin;
select plan(8);

-- ===== Fixtures =========================================================

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'alice-fsrs@test.local', '', now(), now()),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'bob-fsrs@test.local', '', now(), now())
on conflict (id) do nothing;

insert into public.cohorts (id, name) values
  ('11111111-1111-1111-1111-1111111111f1', 'Cohort FSRS')
on conflict (id) do nothing;

insert into public.cohort_members (cohort_id, user_id, role) values
  ('11111111-1111-1111-1111-1111111111f1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'member'),
  ('11111111-1111-1111-1111-1111111111f1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'member')
on conflict do nothing;

-- One note shared between the two users (per-cohort), one card owned by Alice.
insert into public.notes (id, cohort_id, slug, title, body_md, tier)
values ('cccccccc-cccc-cccc-cccc-cccccccccc01', '11111111-1111-1111-1111-1111111111f1', 'fsrs-test-note', 'Note', '...', 'active')
on conflict (id) do nothing;

insert into public.srs_cards (id, note_id, question, answer, fsrs_state, user_id, cohort_id)
values ('dddddddd-dddd-dddd-dddd-dddddddddd01', 'cccccccc-cccc-cccc-cccc-cccccccccc01', 'q', 'a', '{}'::jsonb, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-1111111111f1')
on conflict (id) do nothing;

-- ===== Test 1: function exists with the expected signature ==============
select has_function(
  'public', 'fn_review_card',
  array['uuid','smallint','jsonb','timestamptz','jsonb','text'],
  'fn_review_card exists with the (card_id, rating, next_state, due_at, prev_state, idempotency_key) signature'
);

-- ===== Test 2: function uses security invoker (NOT definer) =============
select is(
  (select prosecdef from pg_proc where proname = 'fn_review_card' limit 1),
  false,
  'fn_review_card uses security invoker (auth.uid() flows through to RLS)'
);

-- ===== Test 3: invalid rating raises 22023 ==============================
prepare invalid_rating as
  select fn_review_card(
    'dddddddd-dddd-dddd-dddd-dddddddddd01'::uuid,
    99::smallint,
    '{"due":"2026-04-25T00:00:00Z","stability":1,"difficulty":1,"elapsed_days":0,"scheduled_days":0,"reps":1,"lapses":0,"state":1}'::jsonb,
    now(),
    '{}'::jsonb,
    'idempotency-key-1'
  );
select throws_ok(
  'invalid_rating',
  '22023',
  'invalid rating: 99',
  'rating outside 1..4 raises invalid_parameter_value'
);

-- ===== Test 4: idempotency replay is a no-op success =====================
-- Set the JWT claim so RLS allows the operation as Alice.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1","role":"authenticated"}';

select fn_review_card(
  'dddddddd-dddd-dddd-dddd-dddddddddd01'::uuid,
  3::smallint,
  '{"due":"2026-04-25T00:00:00Z","stability":1,"difficulty":1,"elapsed_days":0,"scheduled_days":0,"reps":1,"lapses":0,"state":1}'::jsonb,
  '2026-04-25T00:00:00Z'::timestamptz,
  '{}'::jsonb,
  'idempotency-key-2'
);

-- Snapshot rows for replay comparison.
select is(
  (select count(*)::int from public.review_history where idempotency_key = 'idempotency-key-2'),
  1,
  'first call inserts one review_history row'
);

-- Replay with same idempotency_key.
select fn_review_card(
  'dddddddd-dddd-dddd-dddd-dddddddddd01'::uuid,
  3::smallint,
  '{"due":"2026-04-25T00:00:00Z","stability":2,"difficulty":2,"elapsed_days":1,"scheduled_days":1,"reps":2,"lapses":0,"state":2}'::jsonb,
  '2026-04-26T00:00:00Z'::timestamptz,
  '{"due":"2026-04-25T00:00:00Z","stability":1,"difficulty":1,"elapsed_days":0,"scheduled_days":0,"reps":1,"lapses":0,"state":1}'::jsonb,
  'idempotency-key-2'
);

select is(
  (select count(*)::int from public.review_history where idempotency_key = 'idempotency-key-2'),
  1,
  'replay with same idempotency_key does NOT insert a duplicate row'
);

-- The card's fsrs_state must be unchanged from the first call (not the
-- second's "different prev_state" attempt — replay shorts before the UPDATE).
select is(
  (select (fsrs_state->>'reps')::int from public.srs_cards where id = 'dddddddd-dddd-dddd-dddd-dddddddddd01'),
  1,
  'replay does NOT advance srs_cards.fsrs_state'
);

-- ===== Test 5: optimistic concurrency raises 40001 on stale prev_state ==
prepare stale_prev as
  select fn_review_card(
    'dddddddd-dddd-dddd-dddd-dddddddddd01'::uuid,
    3::smallint,
    '{"due":"2026-04-27T00:00:00Z","stability":3,"difficulty":3,"elapsed_days":0,"scheduled_days":0,"reps":99,"lapses":0,"state":2}'::jsonb,
    '2026-04-27T00:00:00Z'::timestamptz,
    '{"stale":"prev"}'::jsonb,  -- does NOT match the card's current fsrs_state
    'idempotency-key-3'
  );
select throws_ok(
  'stale_prev',
  '40001',
  'concurrent update on card dddddddd-dddd-dddd-dddd-dddddddddd01',
  'mismatched p_prev_state raises serialization_failure (40001)'
);

-- ===== Test 6: cross-user RLS — Bob cannot review Alice's card ==========
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1","role":"authenticated"}';

prepare cross_user as
  select fn_review_card(
    'dddddddd-dddd-dddd-dddd-dddddddddd01'::uuid,
    3::smallint,
    '{}'::jsonb,
    now(),
    '{}'::jsonb,
    'idempotency-key-4'
  );
select throws_ok(
  'cross_user',
  '42501',
  'card not found or not accessible: dddddddd-dddd-dddd-dddd-dddddddddd01',
  'Bob cannot review Alice''s card — RLS blocks the select, function raises 42501'
);

select * from finish();
rollback;
