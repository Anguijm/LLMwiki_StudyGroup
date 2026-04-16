# Model upgrade audit

Run through every layer below whenever you swap a model (Claude tier, Gemini version, Voyage embedding model, AssemblyAI transcription model, or OpenRouter fallback). Skipping a layer is how regressions ship.

Adapted from the yolo-projects 5-layer model-swap checklist, tailored for the Next.js + Supabase + Claude + Voyage + AssemblyAI + Gemini-council stack.

## 1. Config

- [ ] Model ID updated in the single source of truth (e.g., `lib/ai/config.ts`, env var, or constants module).
- [ ] No stray references to the old model ID anywhere in the repo. Grep for the old ID before committing.
- [ ] Env var names (if used) documented in `.env.example` and `README.md`.
- [ ] Default fallback model still valid (OpenRouter fallback shouldn't point at a retired ID).

## 2. Callsites

- [ ] Every callsite that used the old model is either migrated or explicitly opted into staying on the old model (with a comment).
- [ ] SDK parameters still valid: max_tokens, temperature, system prompt shape, tool_use format, streaming options.
- [ ] Anthropic prompt caching block structure still correct (cache_control on system + tools, not user turns, unless intentional).
- [ ] Gemini: `genai.GenerativeModel(...)` calls use the new model ID; `.harness/scripts/council.py` default updated if applicable.

## 3. Prompts

- [ ] System prompts still produce the expected shape of output. Newer models can be stricter about instruction-following or more verbose.
- [ ] Tool-use schemas still match the model's tool definition format (minor field renames happen between Claude versions).
- [ ] Output JSON schemas still validate against real outputs — run a sample through your Zod/Pydantic schema before merging.
- [ ] Edge-case prompts (very long docs, non-English content, math/code-heavy) still produce usable output.

## 4. Tests

- [ ] Regression prompts exist for every major use (summarization, tagging, extraction, discussion prompt gen, council angle review).
- [ ] Run the regression set against the new model; diff outputs against a baseline checked into the repo.
- [ ] Unit tests still pass — no implicit dependency on old model's token-count or output length.
- [ ] Manual smoke test: ingest one real PDF, one real YouTube video transcript, one real set of lecture notes. Check downstream outputs.

## 5. Costs

- [ ] New model's price-per-token documented in the callsite comment.
- [ ] Per-user per-month estimate updated in `CLAUDE.md` "Cost posture" section if the model change is user-facing.
- [ ] Rate limits adjusted if the new model has different TPM/RPM ceilings.
- [ ] Prompt caching cost impact reviewed: did the cache structure stay intact? Cache hit rate shouldn't drop to 0% on the swap.
- [ ] Cron / Inngest job cost ceilings re-validated — a "cheaper" model that's 10x slower can still blow budget via retries.

## Post-swap smoke test

1. Run the Gemini council on a representative PR (or `git diff`) with the old model, save the output to `.harness/memory/pre-swap-council.md`.
2. Swap the model.
3. Run the council again on the same diff; save to `.harness/memory/post-swap-council.md`.
4. Diff the two. Confirm scores and non-negotiables are consistent in direction (±1 per angle is fine; swings of 3+ are a red flag).
5. Spot-check one full Claude callsite in production-like conditions (dev env with real corpus).

## Rollback plan

Every model swap commit must describe how to revert:

- The single config change to revert.
- Any prompt changes that must be reverted alongside.
- Whether re-embedding is needed (embedding model swaps: always yes).
- Whether the council persona files need updating (usually no, but major Gemini version jumps may change default output format).

## Never

- Mix embedding models on the same pgvector index. If swapping embeddings, it's a full reindex, not a gradual migration. Plan for it.
- Swap model *and* change prompt in the same PR. Split them so regressions can be attributed.
- Swap to a preview / experimental model ID on a production path. Preview models can be deprecated with 30 days' notice.
