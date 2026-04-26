-- Rollback for 20260426000001_notes_section_hierarchy.sql.
--
-- ROLLBACK PREREQUISITE: no production rows may have parent_note_id IS NOT
-- NULL when this is run, otherwise the column drop will lose data without
-- warning. In practice this means the rollback is safe only before the
-- new chunker has produced any sectioned ingests. After that point a
-- different rollback strategy is needed (flatten sections back into
-- parent body, drop new columns) and that's a separate manual operation.

-- Pre-flight enforcement of the prerequisite documented above. Postgres-
-- expert review polish #11: header text alone is not a control. This
-- DO block fails loud if the operator runs the rollback after sectioned
-- ingests have shipped, surfacing the data-loss risk before DROP COLUMN
-- silently truncates parent_note_id values.
do $$
declare
  orphan_count int;
begin
  if to_regclass('public.notes') is null then
    return; -- table doesn't exist; nothing to guard.
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notes'
      and column_name = 'parent_note_id'
  ) then
    return; -- column already dropped; rollback is a no-op for the column.
  end if;
  execute 'select count(*) from public.notes where parent_note_id is not null'
    into orphan_count;
  if orphan_count > 0 then
    raise exception 'rollback prerequisite violated: % rows have parent_note_id set; DROP COLUMN would silently lose parent linkage. Flatten sections back into parent body manually before re-running this rollback.',
      orphan_count;
  end if;
end $$;

drop function if exists public.insert_note_with_sections(jsonb, jsonb);

drop trigger if exists notes_section_cohort_integrity on public.notes;
drop function if exists public.check_section_note_cohort_integrity();

drop index if exists notes_parent_note_id_idx;

alter table public.notes
  drop constraint if exists notes_no_self_parent,
  drop column if exists section_path,
  drop column if exists parent_note_id;
