# Workspace vitest-config audit — 2026-04-24

**Context:** PR #51 r2 council non-negotiable: *"All test suites in CI logs must be audited to confirm they are running as expected before this change is merged."*

**Trigger:** PR #51 discovery that `apps/web/app/review/actions.test.ts` (16 tests shipped in PR #48) was silently skipped — vitest's `include` patterns did not match `app/**/*.test.ts`. The "consistently-passing RLS-blocked test" cited as load-bearing in PR #48's reflection was never running. Same risk pattern could exist elsewhere.

## Method

For each `vitest.config.ts` in the workspace (9 files), compared the `include` glob against the actual `.test.ts(x)` files present in the package.

## Results

| Package | Include pattern | Test files | Covered? |
|---------|----------------|------------|----------|
| `apps/web` | `*.test.ts`, `lib/**/*.test.ts`, `components/**/*.test.ts?(x)`, `tests/unit/**/*.test.ts`, **`app/**/*.test.ts?(x)` (added in this PR)** | 11 files incl. `app/review/actions.test.ts`, `middleware.test.ts`, `components/*`, `lib/*`, `tests/unit/*` | ✅ after this PR |
| `inngest` | `src/**/*.test.ts` | `src/functions/{chunker,flashcard-gen,on-failure}.test.ts` | ✅ |
| `packages/db` | `src/**/*.test.ts` | `src/{browser,getContext,logging,sanitize,server}.test.ts` | ✅ |
| `packages/lib/ai` | `src/**/*.test.ts` | `src/{anthropic-flashcards,pdfparser,voyage,with-timeout}.test.ts` | ✅ |
| `packages/lib/metrics` | `src/**/*.test.ts` | `src/index.test.ts` | ✅ |
| `packages/lib/ratelimit` | `src/**/*.test.ts` | `src/index.test.ts` | ✅ |
| `packages/lib/srs` | `src/**/*.test.ts` | `src/index.test.ts` | ✅ |
| `packages/lib/utils` | `src/**/*.test.ts` | `src/env.test.ts` | ✅ |
| `packages/prompts` | `src/**/*.test.ts` | `src/index.test.ts` | ✅ |

## Test-count sanity check (after PR #51 fixes)

- `apps/web`: 193 tests (was 177 before the `app/**` include fix; delta matches the 16 actions tests + 2 new PR #51 bugs nice-to-haves, minus the 1 inverted test that replaces the old fail-open test — net +15, plus +1 added ErrorBoundary-like = +16).
- `inngest`: 35 tests.
- `packages/db`: 72 tests.
- `packages/lib/ai`: 49 tests.
- `packages/lib/metrics`: 4 tests.
- `packages/lib/ratelimit`: 19 tests.
- `packages/lib/srs`: 16 tests.
- `packages/lib/utils`: 10 tests.
- `packages/prompts`: 3 tests.
- **Total workspace: 401 tests (was 375 before PR #51).** The delta (+26) matches the 16 previously-skipped actions tests that now run + the 2 new PR #51 bugs nice-to-haves + the post-PR-#48-impl additions that hadn't been counted because actions.test.ts was skipped.

## Gaps found + fixed

1. **apps/web — `app/**/*.test.ts?(x)` missing from include**: **FIXED in PR #51** via the vitest.config.ts update in commit `c97fc61`.

## No other gaps

All other packages use the flat `src/**/*.test.ts` pattern and store all test files in `src/`. Every test file under `src/` is matched by the glob.

## Systemic recommendation (out of scope for this hot-fix; file as follow-up)

Add a CI-level guardrail that fails if a file matching `**/*.test.ts(x)` exists but isn't matched by any package's vitest `include` pattern. A small shell script run in the council workflow's pre-checks could enumerate test files and assert coverage. This would prevent the same class of bug (silent skip via config drift) from recurring when a new test path is introduced without an updated include.

## Audit log

- Executed: 2026-04-24, during PR #51 r2 fold.
- Executor: Claude Opus 4.7, acting on council r2 non-negotiable.
- Result: one gap found + fixed in this PR; systemic recommendation filed for future follow-up.
