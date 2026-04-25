-- #39 semantic chunking — section-as-note schema (phase 1).
-- Plan reference: .harness/active_plan.md (council r2 PROCEED, PR #54).
--
-- Adds parent_note_id + section_path to public.notes so a single ingested
-- document fans out into N section-notes under one parent. Existing
-- per-cohort RLS on notes covers sections without modification.
--
-- Council r1 folds:
--   - section_path is jsonb (not text) so '/' in heading text doesn't need
--     escaping — caller stores ["Chapter 4", "4.3 Pyruvate Oxidation"].
--   - Cohort-integrity trigger fires on INSERT *and* UPDATE so a section
--     cannot be re-parented to a parent in a different cohort.
--   - insert_note_with_sections RPC packages parent + N children in a
--     single transaction so partial failure rolls back everything; this
--     is what makes the source_ingestion_id idempotency check sound.

-- ----- columns -----------------------------------------------------------

alter table public.notes
  add column if not exists parent_note_id uuid references public.notes(id) on delete restrict,
  add column if not exists section_path jsonb;

-- Declarative belt-and-suspenders against self-parenting (council r3
-- §4 explicit suggestion). The trigger below also catches this, but a
-- CHECK constraint runs even if the trigger is dropped or disabled,
-- and surfaces the violation with a clearer error class.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'notes_no_self_parent'
  ) then
    alter table public.notes
      add constraint notes_no_self_parent
      check (parent_note_id is null or parent_note_id <> id);
  end if;
end $$;

-- Partial index for sibling-section lookup (parent → ordered children).
create index if not exists notes_parent_note_id_idx
  on public.notes (parent_note_id)
  where parent_note_id is not null;

-- KNOWN LIMITATION (filed as follow-up): multi-row cycles (A→B→A) are
-- not detected by the CHECK constraint or the trigger below. The risk
-- is low in practice — no app surface re-parents existing notes; the
-- ingest pipeline only inserts fresh hierarchies via the atomic RPC.
-- A recursive-CTE cycle check on every UPDATE would add nontrivial
-- write-path cost; deferring until a real abuse surface emerges.

-- ----- cohort-integrity trigger -----------------------------------------

-- Mirrors check_concept_link_cohort_integrity. RLS guards reads;
-- this trigger guards writes against service-role / buggy internal callers
-- that could otherwise create a section in a different cohort than its
-- parent. Fires on INSERT and UPDATE.
--
-- Three branches:
--   (a) Section-side: NEW.parent_note_id is set → its cohort_id MUST
--       match the parent's. Closes the cross-cohort INSERT and the
--       re-parenting UPDATE attacks (council r1 security must-do #2).
--   (b) Parent-side mutation: NEW row has children AND its cohort_id
--       changed → block, otherwise the children are orphaned in a
--       different cohort. Folded from council r3 [bugs] async/race.
--   (c) Self-parent: caught here in addition to the CHECK constraint
--       above for defense-in-depth on UPDATE.
create or replace function public.check_section_note_cohort_integrity()
returns trigger language plpgsql as $$
declare
  parent_cohort uuid;
  v_orphan_count int;
begin
  -- (b) Parent-side mutation guard. On UPDATE only — INSERT cannot
  -- have prior children. If this row already has children AND its
  -- cohort_id is changing, refuse: the children's cohort_id would no
  -- longer match (and the section-side trigger doesn't fire on them
  -- because we're updating the parent, not the children).
  if tg_op = 'UPDATE' and old.cohort_id <> new.cohort_id then
    select count(*) into v_orphan_count
      from public.notes
      where parent_note_id = new.id;
    if v_orphan_count > 0 then
      raise exception 'section_note_parent_cohort_mutation: id=%, child_count=%, old_cohort=%, new_cohort=%',
        new.id, v_orphan_count, old.cohort_id, new.cohort_id;
    end if;
  end if;

  -- Root documents (no parent) skip the section-side checks.
  if new.parent_note_id is null then
    return new;
  end if;

  -- (c) Self-parent (also enforced by notes_no_self_parent CHECK).
  if new.parent_note_id = new.id then
    raise exception 'section_note_self_parent: id=%', new.id;
  end if;

  -- (a) Section-side check.
  select cohort_id into parent_cohort
    from public.notes
    where id = new.parent_note_id;

  if parent_cohort is null then
    raise exception 'section_note references missing parent: %', new.parent_note_id;
  end if;

  if parent_cohort <> new.cohort_id then
    -- High-signal greppable error for the log drain.
    raise exception 'section_note_cohort_mismatch: parent_cohort=%, section_cohort=%, parent_id=%',
      parent_cohort, new.cohort_id, new.parent_note_id;
  end if;

  return new;
end;
$$;

drop trigger if exists notes_section_cohort_integrity on public.notes;
create trigger notes_section_cohort_integrity
  before insert or update on public.notes
  for each row execute function public.check_section_note_cohort_integrity();

-- ----- atomic parent + sections RPC --------------------------------------

-- Packages a single notes row (the document parent) and N section rows
-- into one transaction. If any child insert fails, the parent insert
-- rolls back too — there is no orphaned-parent state. This atomicity is
-- what makes the source_ingestion_id idempotency check at the call site
-- sound: a successful parent commit implies all children committed.
--
-- SECURITY DEFINER is used because supabase-js / PostgREST has no
-- explicit-transaction primitive: the only way to package multi-statement
-- atomicity in a single network roundtrip is a server-side function. It
-- is NOT used for permission elevation — the function is granted only to
-- service_role, which already has full table access. The cohort-integrity
-- trigger fires per row inside the function and is the load-bearing
-- defense against cross-cohort writes (council r2 security #1).
--
-- Payload contract (caller responsibility):
--   parent jsonb — fields: id, slug, title, body_md, tier, author_id,
--     cohort_id, embedding (jsonb array or null), source_ingestion_id.
--     parent_note_id and section_path MUST be absent / null.
--   sections jsonb — array, each element with: id, slug, title, body_md,
--     tier, author_id, cohort_id, embedding, section_path (jsonb array).
--     parent_note_id is set by this function to the inserted parent id;
--     callers MUST NOT set it.
--   All ids are app-generated UUIDs (matches existing notes pattern;
--   the table has no default for id).
create or replace function public.insert_note_with_sections(
  parent jsonb,
  sections jsonb
)
returns table (parent_id uuid, section_ids uuid[])
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_parent_id uuid;
  v_section_ids uuid[] := array[]::uuid[];
  v_section_id uuid;
  s jsonb;
begin
  if parent is null then
    raise exception 'insert_note_with_sections: parent payload is null';
  end if;

  -- Insert parent (parent_note_id + section_path explicitly null).
  insert into public.notes (
    id, slug, title, body_md, tier,
    author_id, cohort_id, embedding, source_ingestion_id,
    parent_note_id, section_path
  ) values (
    (parent->>'id')::uuid,
    parent->>'slug',
    parent->>'title',
    coalesce(parent->>'body_md', ''),
    coalesce((parent->>'tier')::tier_enum, 'active'),
    (parent->>'author_id')::uuid,
    (parent->>'cohort_id')::uuid,
    case when jsonb_typeof(parent->'embedding') = 'array'
         then ((parent->'embedding')::text)::vector
         else null end,
    nullif(parent->>'source_ingestion_id', '')::uuid,
    null,
    null
  )
  returning id into v_parent_id;

  -- Insert children. parent_note_id is set from v_parent_id (caller
  -- cannot inject a different value). section_path comes from payload.
  if sections is not null and jsonb_typeof(sections) = 'array' then
    for s in select * from jsonb_array_elements(sections) loop
      insert into public.notes (
        id, slug, title, body_md, tier,
        author_id, cohort_id, embedding, source_ingestion_id,
        parent_note_id, section_path
      ) values (
        (s->>'id')::uuid,
        s->>'slug',
        s->>'title',
        coalesce(s->>'body_md', ''),
        coalesce((s->>'tier')::tier_enum, 'active'),
        (s->>'author_id')::uuid,
        (s->>'cohort_id')::uuid,
        case when jsonb_typeof(s->'embedding') = 'array'
             then ((s->'embedding')::text)::vector
             else null end,
        null,                          -- children do not carry source_ingestion_id
        v_parent_id,
        s->'section_path'
      )
      returning id into v_section_id;
      v_section_ids := array_append(v_section_ids, v_section_id);
    end loop;
  end if;

  return query select v_parent_id, v_section_ids;
end;
$$;

comment on function public.insert_note_with_sections(jsonb, jsonb) is
  'Atomic insert of one parent notes row and N children. Used by the ingest pipeline to fan out a PDF into per-section notes in one transaction — partial failure rolls back the parent too. Cohort-integrity trigger enforces section.cohort_id = parent.cohort_id per row. SECURITY DEFINER is used solely to package multi-statement atomicity through PostgREST; permissions are restricted to service_role.';

revoke all on function public.insert_note_with_sections(jsonb, jsonb) from public;
grant execute on function public.insert_note_with_sections(jsonb, jsonb) to service_role;
