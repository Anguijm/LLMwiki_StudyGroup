-- Atomic review: idempotent insert of review_history + optimistic-concurrency
-- update of srs_cards. RLS-scoped via security invoker.
--
-- Council r1 bugs + security non-negotiables (PR #48):
--   - Idempotency: insert review_history FIRST with on conflict (user_id,
--     idempotency_key) do nothing. Replays short-circuit to a no-op success
--     without touching srs_cards.
--   - Optimistic concurrency: update srs_cards with WHERE
--     fsrs_state = p_prev_state. Raises 40001 on collision so the server
--     action returns errorKind: 'concurrent_update'.
--   - security invoker: caller's auth.uid() flows through to RLS checks
--     on srs_cards_own + review_history_own (per-user isolation).

create or replace function public.fn_review_card(
  p_card_id uuid,
  p_rating smallint,
  p_next_state jsonb,
  p_due_at timestamptz,
  p_prev_state jsonb,
  p_idempotency_key text
) returns void
language plpgsql
security invoker
as $$
declare
  v_user_id uuid;
  v_inserted_id uuid;
  v_updated_count int;
begin
  -- Validate rating range (defense in depth — server action also checks).
  if p_rating not in (1, 2, 3, 4) then
    raise exception 'invalid rating: %', p_rating using errcode = '22023';
  end if;

  -- Read user_id from the card row, scoped by RLS. If the row is invisible
  -- (RLS blocks: not the user's card) OR doesn't exist, this returns null.
  -- Fail loud with insufficient_privilege so the server action returns
  -- card_not_found rather than producing partial state.
  select user_id into v_user_id
    from public.srs_cards
    where id = p_card_id;
  if v_user_id is null then
    raise exception 'card not found or not accessible: %', p_card_id
      using errcode = '42501';
  end if;

  -- Idempotency check: insert review_history FIRST. If the
  -- (user_id, idempotency_key) pair already exists, this is a retry —
  -- ON CONFLICT DO NOTHING returns no row, and we short-circuit to a
  -- successful no-op (the original write already advanced the card state).
  insert into public.review_history (
    card_id, user_id, rating, prev_state, next_state, idempotency_key
  )
  values (
    p_card_id, v_user_id, p_rating, p_prev_state, p_next_state, p_idempotency_key
  )
  on conflict (user_id, idempotency_key) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    -- Replay: the original review already happened. No state mutation
    -- needed; return success so the client's retry treats this as success.
    return;
  end if;

  -- Optimistic concurrency: update card state ONLY if fsrs_state matches
  -- what the client computed `next_state` from. If a concurrent
  -- submitReview already advanced the state, this UPDATE matches 0 rows
  -- and we raise serialization_failure so the server action can return
  -- concurrent_update.
  update public.srs_cards
    set fsrs_state = p_next_state,
        due_at = p_due_at
    where id = p_card_id
      and fsrs_state = p_prev_state;

  get diagnostics v_updated_count = row_count;
  if v_updated_count = 0 then
    raise exception 'concurrent update on card %', p_card_id
      using errcode = '40001';
  end if;
end;
$$;

comment on function public.fn_review_card(
  uuid, smallint, jsonb, timestamptz, jsonb, text
) is
  'Atomic review: idempotent insert of review_history + optimistic-concurrency update of srs_cards. RLS-scoped via security invoker. Council r1 (PR #48) folded idempotency + optimistic concurrency.';

revoke all on function public.fn_review_card(
  uuid, smallint, jsonb, timestamptz, jsonb, text
) from public;

grant execute on function public.fn_review_card(
  uuid, smallint, jsonb, timestamptz, jsonb, text
) to authenticated;
