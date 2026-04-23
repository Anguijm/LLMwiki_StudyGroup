-- srs_cards: dedupe on (note_id, question) so Inngest retries + duplicate
-- events produce ON CONFLICT DO NOTHING rather than duplicate rows. Also
-- adds indexes useful for the forthcoming /review surface (issue #38).
--
-- Council r1 on PR #37 non-negotiable: database-level idempotency guarantee.
-- Applied on an empty v0 table; no data-loss risk.

alter table public.srs_cards
  add constraint srs_cards_note_question_unique unique (note_id, question);

create index if not exists srs_cards_note_id_idx
  on public.srs_cards (note_id);

-- Partial index: only due cards matter for /review's "what should the user
-- study right now?" query. Rows with null due_at (just-generated, never
-- reviewed) are picked up via a separate query on the same table.
create index if not exists srs_cards_user_due_idx
  on public.srs_cards (user_id, due_at)
  where due_at is not null;

-- Document provenance so a future /review UI dev knows to sanitize
-- question/answer before rendering. These columns are LLM-generated from
-- user-uploaded content (PDF body → Claude Haiku flashcard-gen/v1) and
-- must be treated as untrusted input at the render layer even though
-- they originate from the user's own upload — a crafted PDF could embed
-- HTML/JS that Claude passes through verbatim.
--
-- Council r1 security on PR #37 + issue #38 XSS non-negotiable.
comment on column public.srs_cards.question is
  'LLM-generated from user-uploaded content. MUST be sanitized before rendering.';
comment on column public.srs_cards.answer is
  'LLM-generated from user-uploaded content. MUST be sanitized before rendering.';
