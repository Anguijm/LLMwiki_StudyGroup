# Contributing to LLMwiki_StudyGroup

Thank you for your interest in contributing! This document outlines how to contribute code, report issues, and propose features.

## Code of Conduct

Be respectful, inclusive, and constructive in all interactions. We're building a tool for learning—let's model good learning behavior.

---

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork:**
   ```bash
   git clone https://github.com/your-username/LLMwiki_StudyGroup.git
   cd LLMwiki_StudyGroup
   ```
3. **Create a feature branch:**
   ```bash
   git checkout -b feat/your-feature-name
   ```
4. **Install dependencies:**
   ```bash
   npm install
   ```
5. **Set up environment variables:**
   ```bash
   cp .env.example .env.local
   # Fill in your API keys
   ```
6. **Start the dev server:**
   ```bash
   npm run dev
   ```

---

## Development Workflow

### Branching Strategy
- `main` = production-ready, always deployable
- Feature branches: `feat/description`, `fix/bug-name`, `docs/update-name`, `refactor/topic`
- Keep branches focused on a single concern

### Commit Messages
Follow **conventional commits**:
```
feat: add spaced repetition calculator
fix: resolve pgvector query timeout
docs: update database schema
refactor: consolidate embedding logic
test: add E2E tests for ingestion pipeline
chore: upgrade Next.js to v15
```

Use clear, present-tense descriptions. Reference issues when applicable: `fix: resolve #42`.

### Code Style

**Linting & Formatting:**
```bash
npm run lint      # ESLint
npm run format    # Prettier
```

We use:
- **ESLint** for code quality
- **Prettier** for consistent formatting
- **TypeScript** for type safety (required)

Before pushing, run:
```bash
npm run lint:fix
npm run format
```

### Testing

Write tests for:
- New API endpoints
- Utility functions (embeddings, SRS calculations)
- Component logic (especially forms, real-time sync)

Run tests:
```bash
npm run test
npm run test:watch  # During development
```

Test file naming: `__tests__/module.test.ts` or `module.test.tsx` co-located with source.

---

## Database Migrations

Changes to schema must be versioned:

1. **Create a migration file:**
   ```bash
   supabase migration new add_discussion_prompts_table
   ```
2. **Write SQL in `/supabase/migrations/{timestamp}_description.sql`**
3. **Test locally:**
   ```bash
   supabase migration up
   ```
4. **Commit the migration file** along with your code changes

Migrations are applied automatically on deploy via GitHub CI/CD.

---

## Working with Inngest Functions

New async jobs go in `/inngest/`:

```typescript
// inngest/your-feature.ts
import { inngest } from "@/lib/inngest";

export const yourFeatureJob = inngest.createFunction(
  { id: "your-feature-job", retries: 3 },
  { event: "your/event" },
  async ({ event, step }) => {
    // Your async work here
  }
);
```

Register in `/inngest/index.ts`:
```typescript
export const functions = [yourFeatureJob];
```

Test locally by triggering events manually via Inngest dashboard.

---

## Creating Components

- Use **React Functional Components** with hooks
- Prefer **TypeScript** for all `.tsx` files
- Use **Tailwind CSS** for styling (no CSS-in-JS)
- Keep components focused and reusable

Example:
```typescript
// components/ReviewCard.tsx
import { FC } from "react";

interface ReviewCardProps {
  question: string;
  onReview: (rating: 1 | 2 | 3 | 4) => void;
}

const ReviewCard: FC<ReviewCardProps> = ({ question, onReview }) => {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-lg font-semibold">{question}</p>
      {/* Rating buttons */}
    </div>
  );
};

export default ReviewCard;
```

---

## API Route Guidelines

- Use Next.js 15 App Router with `app/api/` structure
- Keep routes thin; delegate logic to `/lib/` utilities
- Validate input with `zod` or similar
- Return JSON; include error codes and messages

Example:
```typescript
// app/api/notes/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createNote } from "@/lib/db";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const note = await createNote(body);
    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 400 }
    );
  }
}
```

---

## Documentation

- **Update README.md** if you add new dependencies or major features
- **Add JSDoc comments** to public functions/exports
- **Document Inngest jobs** with event payloads
- **Add migration descriptions** in commit messages

Example JSDoc:
```typescript
/**
 * Compute FSRS stability and difficulty updates based on user review.
 * @param currentStability - Current card stability (0-indefinite)
 * @param currentDifficulty - Current difficulty (0-1)
 * @param rating - User rating (1-4: Again, Hard, Good, Easy)
 * @returns { stability, difficulty } updated values
 */
export function updateFSRS(
  currentStability: number,
  currentDifficulty: number,
  rating: 1 | 2 | 3 | 4
): { stability: number; difficulty: number } {
  // ...
}
```

---

## Submitting a Pull Request

1. **Push your branch** to your fork
2. **Open a PR** on GitHub with:
   - Clear title (use conventional commit format)
   - Description of changes and why
   - Screenshots/video for UI changes
   - Reference related issues (`Fixes #123`)
3. **Respond to review feedback**
4. **Ensure CI passes** (linting, tests, build)
5. **Squash & merge** once approved

PR Template:
```markdown
## What
Brief description of the change.

## Why
Problem it solves or feature it enables.

## How
Technical approach or key decisions.

## Testing
How did you test this? Include steps to reproduce.

## Screenshots/Videos (if UI)
Paste media here.

## Checklist
- [ ] Tests added/updated
- [ ] Docs updated
- [ ] No breaking changes (or documented)
- [ ] Conventional commit message
```

---

## Reporting Issues

1. **Check existing issues** first to avoid duplicates
2. **Use the issue template:**
   - **Describe the bug** clearly with steps to reproduce
   - **Expected vs. actual behavior**
   - **Environment:** OS, Node version, browser
   - **Logs/screenshots** if applicable
   - **Minimal reproduction** (code snippet or repo link)

3. **Labels help categorize:**
   - `bug` — something broken
   - `enhancement` — new feature idea
   - `docs` — documentation improvement
   - `good first issue` — beginner-friendly
   - `help wanted` — need community input

---

## Feature Requests

1. **Open an issue** with title `feat: your feature idea`
2. **Describe the use case** and why it matters
3. **Propose an approach** (not required, but helpful)
4. **Discuss with maintainers** before implementing

---

## Performance & Cost Considerations

As this is designed for tight budgets, be mindful:

- **API calls:** Every API call has a cost (Claude, embeddings, transcription). Batch where possible.
- **Vector queries:** Semantic search is powerful but expensive. Consider filtering/pagination.
- **Token usage:** Haiku is ~75% cheaper than Opus; use it for bulk summarization.
- **Database:** Row-level security (RLS) is essential for multi-cohort isolation; no shortcuts.

---

## Merging & Deployment

Maintainers merge PRs. Once merged to `main`:
- **GitHub Actions** runs tests, linting, build checks
- **Vercel** auto-deploys frontend on commit
- **Supabase migrations** auto-apply
- **Inngest** syncs function definitions

No manual deployment needed.

---

## Questions?

- **GitHub Discussions:** For design questions or brainstorming
- **Issues:** For bug reports and feature requests
- **Discord:** (link TBD) for real-time chat

---

**Thank you for contributing to LLMwiki_StudyGroup!** 🎓
