-- LLMwiki_StudyGroup v0 — seed data.
-- Creates a single cohort every new signup joins by default. v1 replaces
-- this with an admin RPC + invite UI; for v0 the deploy is private and this
-- seam is intentional.

insert into public.cohorts (id, name)
values ('00000000-0000-0000-0000-000000000001', 'Default Cohort')
on conflict (id) do nothing;
