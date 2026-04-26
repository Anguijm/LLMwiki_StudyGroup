-- Single-statement migration: GRANT EXECUTE for atomic_null_reserved_tokens.
--
-- Split out from 20260417000004_atomic_null_reserved_tokens.sql per
-- postgres-expert review on PR #54 + try-split test for issue #7. If
-- this single-statement file applies cleanly while the original
-- multi-statement file did not, the supabase CLI's statement splitter
-- is the root cause and the same split pattern should be applied to
-- the other CREATE FUNCTION + GRANT migrations (files 5, 24-2, 26-1).

grant execute on function public.atomic_null_reserved_tokens(uuid) to service_role;
