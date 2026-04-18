-- notes_by_similarity(query_embedding, tier_scope, match_count)
-- Called by getContext() in /packages/db. Filters by tier + cohort RLS and
-- returns top-k notes by pgvector cosine distance.
--
-- security invoker so the caller's RLS applies (no cross-cohort leak even
-- if the function itself is granted broadly).

create or replace function public.notes_by_similarity(
  query_embedding vector(1024),
  tier_scope tier_enum[],
  match_count int default 5
)
returns setof public.notes
language sql stable security invoker as $$
  select n.*
  from public.notes n
  where n.tier = any(tier_scope)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.notes_by_similarity(vector, tier_enum[], int) to authenticated;
grant execute on function public.notes_by_similarity(vector, tier_enum[], int) to service_role;
