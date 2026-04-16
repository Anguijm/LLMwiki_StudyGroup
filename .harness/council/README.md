# Council

Each `*.md` file in this directory (other than this README and `lead-architect.md`) defines a reviewer persona. The Gemini runner (`../scripts/council.py`) dispatches them in parallel and then runs the Lead Architect synthesis.

## Active angles

| File | Role | Scope |
|------|------|-------|
| `security.md` | Security Reviewer | RLS, auth, secrets, prompt injection, XSS, rate limits, PII, supply chain |
| `architecture.md` | Architecture Reviewer | App Router boundaries, data model, migrations, Inngest idempotency, RAG pipeline, provider abstraction |
| `product.md` | Product Reviewer | Cohort value, scope, mobile, SRS/wiki loop, anti-scope |
| `bugs.md` | Bug Hunter | Nulls, races, retries, boundaries, encoding, cleanup, silent failures |
| `cost.md` | Cost Reviewer | Claude routing, caching, embeddings, transcription, per-user ceiling |
| `accessibility.md` | Accessibility Reviewer | Keyboard, screen reader, WCAG AA, motion, i18n, touch targets |
| `lead-architect.md` | Resolver (synthesizes the above into one plan) |

## Adding a new angle

1. Create `<angle>.md` in this directory following the persona shape in any existing file:
   - One-sentence role statement ("You are a <Role>...").
   - Scope list.
   - Review checklist (numbered questions).
   - Output format (fenced block).
   - Scoring rubric (1–10).
   - Non-negotiables (veto power).
2. The runner auto-picks it up — no code change.
3. Smoke-test by running `python3 ../scripts/council.py --plan .harness/active_plan.md` and confirm the new angle appears in `.harness/last_council.md`.
4. Append the entry to the table above in this README.

## Removing an angle

Delete the file. The runner skips it on the next invocation.

## Disabling an angle temporarily

Rename to `<angle>.md.disabled`. The runner only loads files ending in `.md`.

## Cost cap

The runner enforces 15 Gemini calls per run (hard). Adding a new angle eats one of those slots. If you're near the cap, remove a weaker angle before adding a new one.

## Style invariants for new personas

- No emojis.
- Opening line: `You are a <Role> examining a development plan for LLMwiki_StudyGroup...`
- Always include non-negotiables that grant veto power (so the Lead Architect knows when to reject).
- Keep the checklist actionable — questions, not lectures.
- Output format must be machine-parseable (fenced block with `Score:` on its own line so the log can extract it).
