# LLMwiki_StudyGroup

An AI-augmented wiki for collaborative learning. Designed for small technical study groups (3–4 users), this system ingests diverse media—PDFs, videos, code, lecture notes—automatically structures knowledge using Claude, builds a semantic knowledge graph, and drives mastery through adaptive spaced repetition and AI-synthesized group discussion prompts.

**Perfect for:** Bachelor's-level coursework in technical disciplines (mechanical engineering, physics, CS, etc.) where depth and retention matter, and where a cohort wants to learn together without vendor lock-in.

---

## What It Does

### Ingestion
- **Multi-modal input:** PDFs, Word docs, Markdown, plain text, images, and YouTube videos
- **Layout-aware PDF parsing** via Reducto or LlamaParse (critical for equations and diagrams)
- **Automated transcription** of videos using AssemblyAI (handles technical vocabulary better than Whisper)
- **Frame extraction** from videos for visual concept capture
- **Image analysis** with Claude's vision capabilities

### Knowledge Structuring & Linking
- **Automated summarization** using Claude (Haiku for speed, Opus for complex reasoning)
- **Semantic embedding** with Voyage-3 or OpenAI's `text-embedding-3-large`
- **Automatic Wiki-style linking** ([[Concept]]) to related notes in your corpus
- **Knowledge graph visualization** with React Flow or Cytoscape
- **Three-tier memory:** Bedrock (always active), Active/Warm (current semester), Cold (archived, searchable)

### Learning Science
- **Spaced Repetition System (SRS)** using FSRS (superior to SM-2 for scheduling)
- **Adaptive mastery tracking** per concept
- **On-demand review packets** for specific exams
- **Practice quiz generation** from your note corpus
- **Web push & mobile notifications** for scheduled reviews

### Collaboration
- **Real-time presence & live editing** via Supabase Realtime
- **Invite-only access** for your study group (4-user cohorts)
- **Automatic gap analysis:** Weekly jobs identify contradictions, missing concepts, and weak points
- **AI-generated discussion prompts** routed to Discord/Slack webhooks
- **Unified wiki graph** even as each user ingests independently

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Frontend** | Next.js (App Router) | Type-safe, server components, API routes, Vercel-native |
| **Hosting (Frontend)** | Vercel | Instant deployments, edge functions, zero config |
| **Backend** | Next.js API Routes | Thin gateway; all heavy work offloaded |
| **Async Orchestration** | Inngest | Queues, retries, cron, concurrency without managing servers |
| **Database** | Supabase (Postgres) | pgvector for embeddings, RLS for cohort access, Auth included |
| **Vector Store** | pgvector | Collocated in Postgres, no separate vector DB |
| **LLM API** | Anthropic Claude | Opus 4.6 (reasoning), Haiku 4.5 (volume work) |
| **LLM Fallback** | OpenRouter | Provider diversity, fallback resilience |
| **Video Ingestion** | yt-dlp + AssemblyAI | Transcription, layout preservation |
| **PDF Parsing** | Reducto or LlamaParse | Layout-aware, equation-preserving |
| **Embeddings** | Voyage-3 or text-embedding-3-large | State-of-the-art retrieval quality |
| **Auth** | Supabase Auth | Magic links, SAML-ready, JWT-based |
| **Realtime Sync** | Supabase Realtime | Presence, live-editing, subscriptions |

---

## Quick Start

### Prerequisites

- **Node.js 20.11+** (engines pins `>=20.11.0 <21` in `package.json`).
- **pnpm 9.12+** (monorepo uses pnpm workspaces; `npm install` will not work).
- **Git**.
- **Accounts (all free-tier eligible for v0):**
  Supabase, Vercel, Inngest, Upstash, Anthropic, Voyage, and **one** of
  LlamaParse or Reducto. LlamaParse has the lightest signup (~2 min at
  llamaindex.ai).

### 1. Clone & install

```bash
git clone https://github.com/Anguijm/LLMwiki_StudyGroup.git
cd LLMwiki_StudyGroup
pnpm install
```

### 2. Local env setup

```bash
cp .env.example .env.local
# Fill in the keys per the "Deploy runbook" section below.
```

`.env.local` is git-ignored. Only v0 keys live in `.env.example`; v1+
keys (AssemblyAI, Discord webhook, web-push VAPID) get added in the PR
that wires each feature up, alongside its rate-limit + safety controls.

### 3. Local dev

```bash
pnpm dev                    # Next.js at http://localhost:3000
pnpm --filter @llmwiki/inngest exec inngest-cli dev   # (optional) local Inngest dev server
```

### 4. Verify locally before pushing

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter web test:a11y   # Playwright a11y suite
```

All four must pass. CI re-runs them on every push.

### 5. Deploy

See the **Deploy runbook** section — every step is explicit, account-by-account.

---

## Project Structure

```
LLMwiki_StudyGroup/
├── app/                           # Next.js App Router
│   ├── api/
│   │   ├── ingest/               # Multipart upload endpoint
│   │   ├── notes/                # CRUD operations
│   │   ├── search/               # Semantic search
│   │   ├── reviews/              # SRS card generation
│   │   ├── graph/                # Knowledge graph data
│   │   └── webhooks/
│   │       ├── discord/          # Receive discussion prompts
│   │       └── inngest/          # Inngest event sink
│   ├── (auth)/                   # Auth layout (Supabase magic links)
│   ├── (dashboard)/
│   │   ├── layout.tsx
│   │   ├── page.tsx              # Main wiki view
│   │   ├── notes/                # Note detail + edit
│   │   ├── review/               # SRS session
│   │   └── graph/                # Knowledge graph visualization
│   └── page.tsx                  # Landing / login
├── components/
│   ├── Editor.tsx                # Markdown editor w/ real-time sync
│   ├── NoteCard.tsx
│   ├── KnowledgeGraph.tsx        # React Flow wrapper
│   ├── ReviewSession.tsx         # SRS UI
│   └── ...
├── lib/
│   ├── db.ts                     # Supabase client + typed queries
│   ├── claude.ts                 # Wrapper for Opus/Haiku
│   ├── embeddings.ts             # Voyage or OpenAI embeddings
│   ├── inngest.ts                # Inngest client + event definitions
│   ├── srs.ts                    # FSRS algorithm implementation
│   └── auth.ts
├── inngest/                      # Inngest function definitions
│   ├── ingest.ts                 # Multi-modal ingestion pipeline
│   ├── generate-links.ts         # Auto-link generation
│   ├── gap-analysis.ts           # Weekly gap analysis + prompt generation
│   ├── scheduled-review.ts       # SRS card scheduling
│   └── ...
├── public/                       # Static assets
├── supabase/
│   ├── migrations/               # SQL migration files
│   └── config.toml
├── .env.local                    # (git-ignored) Local secrets
├── .env.example                  # Template for new developers
├── next.config.ts
├── tsconfig.json
├── package.json
├── tailwind.config.ts            # Styling
└── README.md
```

---

## Key Features Explained

### Multi-Modal Ingestion
Users upload files via the web UI. The ingestion pipeline:
1. Receives the file via Next.js API route
2. Enqueues an Inngest job (async, durable)
3. Parses the file (PDF → Reducto, video → yt-dlp + AssemblyAI, etc.)
4. Summarizes with Claude (Haiku for individual chunks, Opus for final summary)
5. Generates embeddings with Voyage-3
6. Stores the Markdown in Supabase Storage
7. Inserts metadata into Postgres
8. Triggers automatic linking

### Knowledge Graph & Semantic Linking
- Each note is embedded using `text-embedding-3-large` or Voyage-3
- On ingest, the backend queries similar notes in pgvector
- Inserts Wiki-style links (`[[Thermodynamic Equilibrium]]`) into the summary
- A derived `concept_links` table maps concept → concept with relationship strength
- Frontend renders the graph using React Flow or Cytoscape

### Three-Tier Memory
Notes have a `tier` column: `BEDROCK | ACTIVE | COLD`.
- **BEDROCK**: Physics constants, ME fundamentals (always injected into LLM context)
- **ACTIVE**: Current semester syllabus (auto-injected in retrieval)
- **COLD**: Previous semesters (explicit search only, saves tokens)

### Spaced Repetition (FSRS)
- FSRS algorithm tracks stability and difficulty per card per user
- Inngest cron job runs daily, generates due cards
- Web push notifications (via Expo or standard Web Push API) notify users
- Users review cards via `/review` interface
- Ratings (Again, Hard, Good, Easy) update stability for next scheduling

### Gap Analysis & Discussion Synthesis
Weekly Inngest job:
1. Map-reduce summarize all ACTIVE + BEDROCK notes using Haiku (token-efficient)
2. Claude Opus analyzes the corpus for contradictions, missing prerequisites, weak concepts
3. Generates 3–5 thought-provoking discussion prompts
4. Posts prompts to Discord/Slack via webhooks (channel per study group)
5. Stores prompts in DB for reference

---

## Deploy runbook

Everything below is a literal checklist for getting v0 from zero to a live
deploy. Work through top-to-bottom once; subsequent deploys are just
`git push`.

### A. Account + key checklist

| service | required for v0? | keys you'll collect | where |
|---|---|---|---|
| Supabase | yes | project URL, anon key, service-role key, project ref | dashboard → Project Settings → API |
| Vercel | yes | (no keys; just the project) | vercel.com/new |
| Anthropic | yes | `ANTHROPIC_API_KEY` | console.anthropic.com |
| Voyage | yes | `VOYAGE_API_KEY` | voyageai.com |
| **One** of LlamaParse or Reducto | yes | `LLAMAPARSE_API_KEY` *or* `REDUCTO_API_KEY`, plus set `PDF_PARSER` accordingly | llamaindex.ai (recommended) or reducto.ai |
| Upstash | yes | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | upstash.com → create Redis DB |
| Inngest | yes | `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` | **auto-populated by the Inngest Vercel marketplace integration — no CLI needed** |

### B. Supabase: project → live

1. Create a new Supabase project; pick a region near your users.
2. Dashboard → **Project Settings → API**: copy the project URL, anon key,
   and service-role key. Also note the project ref (the `<xyz>` in
   `<xyz>.supabase.co`).
3. Locally, link + push the schema:
   ```bash
   supabase link --project-ref <xyz>
   supabase db push
   ```
   *(Replaces the incorrect `npx supabase migration up` from earlier docs.)*
4. Dashboard → **Storage**: confirm the `ingest` bucket exists. It's created
   by migration `20260417000002_rls_policies.sql`. If missing, the migration
   failed — re-run `supabase db push` or check migration logs.
5. Dashboard → **Authentication → URL Configuration** — **security
   surface, verify with screenshots on every auth-touching PR (council
   non-negotiable)**:
   - **Site URL** → your production URL (e.g. `https://<app>.vercel.app`).
   - **Redirect URLs** → ONLY these two entries. No wildcards beyond the
     preview-URL pattern. A misconfigured allowlist lets an attacker
     redirect a valid PKCE code to a host they control:
     - `https://<app>.vercel.app/auth/callback`
     - `https://<app>-*.vercel.app/auth/callback` (Vercel preview deploys)
   - Confirm this matches `APP_BASE_URL` in Vercel env vars (§C.3). The
     server-side `/api/auth/magic-link` route already hard-requires
     `APP_BASE_URL` and rejects Host-header spoofing; the Supabase
     allowlist is the second line of defense.
6. Dashboard → **Authentication → Email Templates** — **PKCE flow
   requires explicit template edits; Supabase defaults ship the
   implicit-flow URL form**:
   - Open the **Confirm signup** template AND the **Magic Link**
     template. Both must exist and both must be edited — users who
     have never signed in hit the "Confirm signup" template, returning
     users hit "Magic Link".
   - In the confirmation link, the URL MUST be:
     ```
     {{ .SiteURL }}/auth/callback?code={{ .TokenHash }}
     ```
     The default templates use `#access_token=` (implicit flow); that
     form bypasses our server-side `/auth/callback` handler and leaves
     the session unpersisted. Verify by clicking **Preview** in each
     template and confirming the URL includes `/auth/callback?code=`.
   - Screenshot both templates plus the URL Configuration section and
     attach to the auth-surface PR before merge.

### C. Vercel: project + settings + env vars

1. Import the GitHub repo at vercel.com/new.
2. **Settings → General → Build and Deployment** — critical for this
   monorepo layout. Without these, the build runs but Vercel can't find
   the Next.js output and the deploy fails with "No Output Directory
   named 'public' found":
   - **Root Directory** → `apps/web`
     (The Next.js project lives in this subdirectory, not at the repo root.)
   - **"Include files outside of the Root Directory"** → **ON**
     (Required so the build in `apps/web` can still see `packages/*`,
     `inngest/`, `pnpm-workspace.yaml`, and the root `pnpm-lock.yaml`.)
   - **Framework Preset** → **Next.js**
     (Auto-sets Build Command, Output Directory `.next`, Install
     Command. Must be set explicitly — monorepo auto-detection can
     leave this as "Other", which breaks output-directory discovery.)
3. **Settings → Environment Variables**: add every key below, with values
   from step A. Select **Production, Preview, and Development** for each.

   | key | needed at build time? | notes |
   |---|---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | **yes** (NEXT_PUBLIC_) | default |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **yes** (NEXT_PUBLIC_) | default |
   | `SUPABASE_SERVICE_ROLE_KEY` | runtime only | server-only; never expose to client |
   | `SUPABASE_PROJECT_REF` | runtime only | |
   | `ANTHROPIC_API_KEY` | runtime only | |
   | `VOYAGE_API_KEY` | runtime only | |
   | `PDF_PARSER` | runtime only | `llamaparse` or `reducto` |
   | `LLAMAPARSE_API_KEY` *(if chosen)* | runtime only | set exactly one parser key |
   | `REDUCTO_API_KEY` *(if chosen)* | runtime only | set exactly one parser key |
   | `UPSTASH_REDIS_REST_URL` | runtime only | |
   | `UPSTASH_REDIS_REST_TOKEN` | runtime only | |
   | `INNGEST_EVENT_KEY` | runtime only | auto-populated by step D |
   | `INNGEST_SIGNING_KEY` | runtime only | auto-populated by step D |
   | `APP_BASE_URL` | runtime only | your production URL |

   `NEXT_PUBLIC_*` keys are build-time by convention (Vercel inlines them
   into client bundles); nothing to toggle explicitly.

4. **Recommended developer workflow:** after provisioning Vercel env vars,
   sync them locally with `vercel env pull .env.local` before running
   `pnpm dev`. Prevents "works on my machine but breaks in preview" drift.

### D. Inngest: via Vercel marketplace integration (no CLI required)

The Inngest CLI (`inngest-cli dev`) is **local-dev only**. Production runs
don't need it — the Vercel integration handles app registration end-to-end.

1. Go to [vercel.com/integrations/inngest](https://vercel.com/integrations/inngest) → Install → pick your project.
2. The integration auto-populates `INNGEST_EVENT_KEY` and
   `INNGEST_SIGNING_KEY` in Vercel's env-var store across all three environments.
3. On the next Vercel deploy, Vercel notifies Inngest; Inngest polls the
   `/api/inngest` endpoint and auto-registers the app.
4. **Verify**: Inngest dashboard → **Apps** → `llmwiki-studygroup` should
   appear (the `id` from `inngest/src/client.ts`), with four registered
   functions: `ingestPdf`, `ingestWatchdog`, `noteCreatedLink`, `noteCreatedFlashcards`.

### E. Upstash

1. upstash.com → **Create Database** → Regional → pick a region close to
   your Vercel deploy region.
2. Copy the REST URL + REST token into Vercel env vars.

### F. First deploy + smoke test

1. Merge a PR to `main`. Vercel auto-deploys.
2. Watch the Vercel build log. Expected: **"✓ Generating static pages (8/8)"**
   and a green "Ready" status.
3. Visit `https://<app>.vercel.app/auth` → enter email → check inbox for
   the Supabase magic link → click → should land on `/` (dashboard).
4. Upload a small (<5 MB) test PDF via the "Upload PDF" button.
5. Watch the **Recent ingestion jobs** table. Expected transitions:
   `queued` → `running` → `completed` (seconds to a minute for a 1-page PDF).
6. Click the resulting note; confirm the simplified body renders.
7. If stuck in `queued` > 30s: Inngest dashboard → **Apps → Functions** →
   look for the failing run. Most common root cause: the Inngest Vercel
   integration didn't auto-register. Trigger a redeploy on Vercel and it
   registers.

### G. Secret placement reference

Each platform has its own env-var store. **Secrets do NOT propagate across
platforms** — setting `ANTHROPIC_API_KEY` in GitHub Actions does not put it
in Vercel.

| store | holds | used by |
|---|---|---|
| Vercel env vars | every v0 runtime key + `NEXT_PUBLIC_*` build keys | Vercel builds + serverless runtime |
| GitHub Actions secrets | `GEMINI_API_KEY` for council, others as needed by CI | `.github/workflows/*.yml` |
| GitHub Codespaces secrets | developer's local mirror of `.env.example` | Codespaces dev containers |
| `.env.local` | same as Codespaces but on a developer laptop | `pnpm dev` |

### Cost posture (v0)

| service | monthly cost (4-user cohort) |
|---|---|
| Supabase (free → Pro at launch) | $0 → $25 |
| Vercel Hobby (Pro if previews needed) | $0 → $20 |
| Upstash free tier (10k cmds/day) | $0 |
| Inngest free tier (50k steps/mo) | $0 |
| Claude Haiku + Opus (rare) | $2–5 |
| Voyage-3 embeddings | <$1 |
| LlamaParse / Reducto free tiers | $0 |
| **Total v0** | **$2–50/mo**, scaling to $75–110/mo at v1 with AssemblyAI + Pro tiers |

### Rollback

- **Web**: `vercel rollback` in the Vercel dashboard.
- **Schema**: `supabase db reset` + re-run migrations from the last
  known-good commit.
- **Caveat**: the `db reset` flow is v0-only. Once real cohort data lives
  in the DB, every migration must ship with a reversible `down.sql` — v1
  tracks this as the first plan-item.

---

## Database Schema (Key Tables)

```sql
-- Users (managed by Supabase Auth)
-- profiles (user metadata, tier preference, etc.)

-- Cohorts
CREATE TABLE cohorts (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  created_by UUID REFERENCES auth.users(id)
);

-- Cohort membership
CREATE TABLE cohort_members (
  id UUID PRIMARY KEY,
  cohort_id UUID REFERENCES cohorts(id),
  user_id UUID REFERENCES auth.users(id),
  role TEXT DEFAULT 'member' -- 'member' or 'admin'
);

-- Notes
CREATE TABLE notes (
  id UUID PRIMARY KEY,
  cohort_id UUID REFERENCES cohorts(id),
  user_id UUID REFERENCES auth.users(id),
  title TEXT NOT NULL,
  content TEXT, -- Markdown
  summary TEXT, -- AI-generated
  tier TEXT DEFAULT 'ACTIVE', -- BEDROCK | ACTIVE | COLD
  source_type TEXT, -- pdf | video | text | image | etc.
  embedding vector(1536), -- pgvector
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Semantic relationships
CREATE TABLE concept_links (
  id UUID PRIMARY KEY,
  source_note_id UUID REFERENCES notes(id),
  target_note_id UUID REFERENCES notes(id),
  relationship_strength FLOAT, -- 0.0 to 1.0
  created_at TIMESTAMP DEFAULT now()
);

-- SRS cards
CREATE TABLE srs_cards (
  id UUID PRIMARY KEY,
  note_id UUID REFERENCES notes(id),
  user_id UUID REFERENCES auth.users(id),
  question TEXT,
  answer TEXT,
  stability FLOAT DEFAULT 0,
  difficulty FLOAT DEFAULT 0.5,
  due_date TIMESTAMP,
  review_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);

-- SRS reviews
CREATE TABLE srs_reviews (
  id UUID PRIMARY KEY,
  card_id UUID REFERENCES srs_cards(id),
  user_id UUID REFERENCES auth.users(id),
  rating INT, -- 1=Again, 2=Hard, 3=Good, 4=Easy
  reviewed_at TIMESTAMP DEFAULT now()
);

-- Discussion prompts
CREATE TABLE discussion_prompts (
  id UUID PRIMARY KEY,
  cohort_id UUID REFERENCES cohorts(id),
  prompt TEXT,
  gap_type TEXT, -- 'contradiction' | 'missing_concept' | 'weak_area'
  related_notes UUID[],
  posted_to_discord BOOLEAN DEFAULT false,
  posted_to_slack BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now()
);
```

All RLS policies scoped to cohort membership.

---

## Development Workflow

1. **Branching:** Feature branches off `main`
2. **Migrations:** Changes to schema go in `/supabase/migrations/{timestamp}_description.sql`
3. **Inngest Functions:** New async jobs in `/inngest/*.ts`
4. **Components:** React components in `/components`
5. **Testing:** Jest + React Testing Library (tests in `__tests__/`)
6. **Commit:** Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)

---

## Contributing

Contributions welcome! Please:
1. Open an issue to discuss feature/fix
2. Branch off `main`
3. Follow the existing code style (ESLint config included)
4. Submit a PR with clear description

---

## Troubleshooting

**"pgvector extension not enabled"**
- In Supabase dashboard: Extensions → Search for `vector` → Enable

**"Inngest not triggering"**
- Check Inngest dashboard for event logs
- Verify `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` in `.env.local`
- Ensure your Inngest account is linked to the GitHub repo

**"Embeddings API returning 401"**
- Verify `VOYAGE_API_KEY` or `OPENAI_API_KEY` in `.env.local`
- Check API key expiration / quota in service dashboard

**"Video transcription taking too long"**
- AssemblyAI queues jobs; check the dashboard for status
- Consider enabling polling or switching to Deepgram for real-time streaming

---

## Roadmap

- [ ] Mobile app with Expo (for on-the-go review)
- [ ] Video highlight → timestamped flashcard generation
- [ ] Study group leaderboard (mastery ranking)
- [ ] Peer note-review workflow
- [ ] Export to Anki, Quizlet, etc.
- [ ] Integration with Canvas / learning management systems
- [ ] Multi-language support

---

## License

MIT — See `LICENSE` for details.

---

## Support & Contact

- **Issues:** Open a GitHub issue
- **Questions:** Start a discussion
- **Real-time chat:** Discord server (link TBD)

---

**Built for technical learners who value privacy, control, and effective study science.**

---

## v0 Vertical Slice — Deploy Runbook

Plan: `.harness/active_plan.md` (approved r8, PR #5, SHA `c1d4a5f`).

v0 ships **one** thing: upload a PDF → read the ingested, simplified note at `/note/[slug]`. Everything else is intentionally stubbed. See `## v0 Non-Goals` below.

### Prerequisites

- Node 20.11 (see `.nvmrc`). `pnpm 9.12.0`.
- Supabase account + a new project (Pro tier recommended; free works for the first week).
- Vercel account linked to this repo.
- Inngest account (free tier is fine for v0's step volume).
- Upstash Redis (REST). Free tier; one database.
- Anthropic API key. Voyage AI API key. Reducto API key (or LlamaParse — pick one with `PDF_PARSER`).

### One-time

```bash
pnpm install
cp .env.example .env.local
# Fill in every value in .env.local. The CI grep gate prevents v1+ secrets
# from leaking back into .env.example.

# Supabase
supabase link --project-ref <your-project-ref>
supabase db push            # applies migrations
psql "$DATABASE_URL" -f supabase/seed.sql

# Vercel
vercel link
vercel env pull .env.local   # merges local + Vercel-stored env

# Inngest — register the app at https://<your-vercel-deploy>/api/inngest
```

### Smoke test

1. Visit `/auth`, request a magic link, follow the link — you land on `/`.
2. Click "Upload PDF"; pick a small PDF.
3. Watch the "Recent ingestion jobs" row flip from Queued → Processing → Ready (usually < 60s).
4. Click the note title in "Your notes"; you should see the Haiku-simplified Markdown at `/note/[slug]`.

If the job goes Failed, check the pill color:

- **Amber (user-correctable)** → the PDF itself was the problem (no text content, too many pages, timed out). Try a different file.
- **Slate (system-transient)** → upstream API or rate-limit hiccup. Retry the same file; the partial unique index permits a fresh job for terminally-failed ones.

### v0 Non-Goals (not bugs; see plan)

- YouTube / image / DOCX / MD / TXT ingest.
- URL ingest (`ingestion_jobs.source_url` column is intentionally absent — SSRF vector removed).
- Concept-link writeback, flashcard generation, `/graph`, `/review` FSRS, `/exam`, `/cohort` invite UI.
- Weekly gap analysis, web-push.
- OAuth (magic link only).
- Full design polish (foundational a11y is in scope; visual polish isn't).

### Realtime Exposure Map

Only `public.ingestion_jobs` publishes changes via Supabase Realtime in v0. The `pgTAP` lockfile test (`supabase/tests/publications.sql`) fails CI if any other table gets added to the publication without a matching security review. Adding a table is a security-review event — open an issue first.

### Dependency Vetting

v0 `npm` dependencies (all MIT/Apache-2.0/MPL-2.0; no unaudited prereleases):

| package | purpose | license |
|---|---|---|
| `@supabase/supabase-js` · `@supabase/ssr` | DB + auth + storage + realtime | MIT |
| `@anthropic-ai/sdk` | Haiku simplify | MIT |
| `voyageai` | voyage-3 embed | MIT |
| `@upstash/ratelimit` · `@upstash/redis` | rate limits + token budget | MIT |
| `inngest` | step runner | Apache-2.0 |
| `zod` | external response schemas | MIT |
| `server-only` | build-time server/client boundary | MIT |
| `react-markdown` · `rehype-sanitize` | safe Markdown | MIT |
| `slugify` | unicode-safe slugs | MIT |
| `@axe-core/playwright` · `@playwright/test` | a11y checks | MPL-2.0 / Apache-2.0 |
| `vitest` | unit tests | MIT |

`pnpm audit --prod --audit-level=high` runs on every PR (see `.github/workflows/ci.yml`) and fails the build on any new high/critical advisory.

### Rollback

- **Web:** `vercel rollback`.
- **Schema:** `supabase db reset` + re-run migrations from the last known-good commit. **v0-only** — once real cohort data exists, every migration must ship with a reversible `down.sql`. First item on the v1 plan.
