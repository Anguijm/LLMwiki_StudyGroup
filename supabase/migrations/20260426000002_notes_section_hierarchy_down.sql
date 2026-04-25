-- Rollback for 20260426000001_notes_section_hierarchy.sql.
--
-- ROLLBACK PREREQUISITE: no production rows may have parent_note_id IS NOT
-- NULL when this is run, otherwise the column drop will lose data without
-- warning. In practice this means the rollback is safe only before the
-- new chunker has produced any sectioned ingests. After that point a
-- different rollback strategy is needed (flatten sections back into
-- parent body, drop new columns) and that's a separate manual operation.

drop function if exists public.insert_note_with_sections(jsonb, jsonb);

drop trigger if exists notes_section_cohort_integrity on public.notes;
drop function if exists public.check_section_note_cohort_integrity();

drop index if exists notes_parent_note_id_idx;

alter table public.notes
  drop column if exists section_path,
  drop column if exists parent_note_id;
