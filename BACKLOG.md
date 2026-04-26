# Backlog

Living priority tracker. Re-rank as priorities shift. Each item: one line, link to GitHub issue if one exists.

## Now (this week's actionable work)

- **#7 db-tests blocking gate** — investigation done in PR #54; dedicated PR has a short path (workarounds documented). Highest-leverage v1 polish item. → [issue #7](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/7) (see comment for diagnosis).
- **Remove `MAX_BODY_CHARS = 500_000` stopgap** in `inngest/src/functions/flashcard-gen.ts:37` — vestigial after #39 sectioning. One-line code change + test fixture update.

## Next (queued, scoped)

- **#52 CI guardrail full impl** — replace the ad-hoc EXPECTED allowlist (added in PR #54) with an auto-generated manifest from `vitest list`. → [issue #52](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/52).
- **Anthropic prompt caching on `simplify` + `flashcard-gen`** — 1h TTL; ~50% input-token cost reduction on repeat ingest. Council r3/r5 deferred nice-to-have.
- **#47 server-side pagination on `/review`** — current UI loads all due cards. → [issue #47](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/47).
- **#44 Zod runtime validation on `/review` srs_cards select** — partially addressed; deck-card shape remains. → [issue #44](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/44).
- **#46 PR title hygiene automation** — pre-merge check for conventional-commit prefix. → [issue #46](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/46).
- **#45 council reflection-PR vs feature-PR diff distinction** — the persona prompts currently treat both the same. → [issue #45](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/45).

## Someday (daydreams, architectural ideas)

- **`delete_note_with_sections(note_id)` Postgres function** — when a delete-note UI ships. PR #54 plan §"Open questions" #3.
- **Parent-note TOC summary instead of joined body** — PR #54 plan §"Open questions" #1; doubles storage but produces cleaner search hits on the parent.
- **Parent-note embedding when oversized** — currently skipped if simplified body > 30k chars; alternative is to summarize-then-embed. PR #54 plan §"Open questions" #2.
- **Voyage embedding batching** — batch N section embeddings into one API call. Cost optimization; PR #54 §Embedding strategy TBD.
- **Sections-per-doc monitoring metric** — early warning if chunking heuristic regresses. Council r5 nice-to-have.
- **Multi-modal section types** (images, tables, code blocks as their own note types) — out of scope for #39, would extend section-as-note.
- **Cross-document section linking** — gap-analysis territory ("Chapter 4 of textbook A aligns with Lecture 7 of course B").
- **User-editable section boundaries** — UI feature.
- **#41 sanitize-at-write vs sanitize-at-render eval** — for LLM-generated columns. → [issue #41](https://github.com/Anguijm/LLMwiki_StudyGroup/issues/41).

## Open issues (mirror of `gh issue list`)

- **#52** CI guardrail: assert every `*.test.ts(x)` is matched by a vitest include — partial mitigation in PR #54.
- **#47** Server-side pagination on `/review` for power-users — PR #43 r4 follow-up.
- **#46** Automate PR title hygiene check pre-merge — PR #43 r3 follow-up.
- **#45** Council prompt should distinguish reflection-PR vs feature-PR diffs — PR #43 hallucination chain.
- **#44** Zod runtime row validation on `/review srs_cards` select — PR #43 r2 follow-up.
- **#41** security: evaluate sanitize-at-write vs sanitize-at-render for LLM-generated columns.
- **#36** diagnostic: log sanitized upstream error details on `server_error` fallthrough in `/auth/callback`.
- **#34** observability: replace `console.error` on alert paths with a structured logger (Pino).
- **#33** tooling: lint rule / shared type enforcing the `{ alert: true, tier }` structured-alert contract.
- **#32** test: strengthen cookie rollback assertion — verify `Set-Cookie` headers in the response.
- **#20** E2E: Playwright smoke test asserting CSP nonce on `/auth` scripts.
- **#19** Auth: 5 council r4 nice-to-haves (timeout, edge-case tests, serial RL).
- **#18** Council: add framework / Next.js specialist persona — priority-high label.
- **#15** CSP: harden `style-src` by removing `'unsafe-inline'`.
- **#14** CSP: add violation reporting endpoint (`report-to` / `report-uri`).
- **#12** Remove `/diag` + harden `error.tsx` / `global-error.tsx` after blank-page bug is fixed.
- **#7** v1: make db-tests (pgTAP) a blocking CI gate — investigation done in PR #54.
- **#6** v1: migrate Storage RLS from object-name parsing to `object.metadata`.

## In flight (branches not yet merged)

- `claude/session-end-2026-04-26` (this PR) — session-end handoff, council-required.
