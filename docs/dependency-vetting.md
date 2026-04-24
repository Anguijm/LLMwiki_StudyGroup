# Dependency vetting log

Record of vetting checks for each new server-side runtime dependency introduced to the repo. Council PR #50 r2 security persona non-negotiable: *"Retroactively document the supply-chain security vetting for `ts-fsrs@5.0.0`."*

New server-side deps with access to env / service-role keys require a vetting entry here BEFORE merge. Client-only deps (browser bundle only) do not require an entry but are encouraged to have one.

## Vetting checklist

For each new dep, record:

- [ ] Package name + exact pinned version (no `^` / `~`).
- [ ] Maintainer / publisher identity and plausibility check.
- [ ] Weekly download count (rough order of magnitude).
- [ ] Age of project + recency of last release.
- [ ] Known CVEs / security advisories (via `npm audit` or `pnpm audit --production`).
- [ ] Transitive-dep surface (is this a leaf package or does it pull a large tree?).
- [ ] License compatibility (MIT / ISC / Apache-2.0 preferred; any GPL / AGPL / proprietary flagged for explicit approval).
- [ ] Why this dep over in-house impl / alternatives (one-sentence justification).

## Entries

### `ts-fsrs@5.0.0` — added in PR #48 (2026-04-24)

**Added retroactively per PR #50 r2 council non-negotiable. Future deps require the entry before merge, not after.**

- **Exact version:** `5.0.0` (pinned — no `^` / `~`). Pinning enforced by the `// VERSION-PINNED: Bumps require security council review.` comment at `packages/lib/srs/src/index.ts:8`.
- **Maintainer:** `open-spaced-repetition` org (GitHub: https://github.com/open-spaced-repetition). Publisher of the canonical FSRS spec + reference implementations in multiple languages. Plausibility: high — the FSRS algorithm was peer-reviewed and published; this is the official TypeScript port maintained by the spec authors.
- **Weekly downloads:** order of 10k/week (npm registry; subject to change).
- **Age / recency:** first release late 2023; v5.0.0 is the FSRS-5 algorithm (breaking change from v4 — algorithm, not just API). Regular releases.
- **Known CVEs:** none at time of adding (run `pnpm audit --prod --filter @llmwiki/lib-srs` to re-check periodically).
- **Transitive-dep surface:** **narrow** — `ts-fsrs` is a pure-TypeScript algorithmic library with no runtime dependencies (verified via the wrapper package's `pnpm list --depth=0`). Zero transitive deps = zero additional supply-chain surface.
- **License:** MIT.
- **Justification:** FSRS-5's math (stability decay, retrievability, difficulty drift) is well-published but non-trivial; using the canonical port lowers the bug-risk substantially vs. an in-house impl. Pinning + wrapper package (`@llmwiki/lib-srs`) localize the trust boundary to one file. Council PR #48 r2 architecture persona endorsed this explicitly: *"correctly isolates the new external dependency (`ts-fsrs`) within a dedicated package (`@llmwiki/lib-srs`), respecting the provider abstraction principle."*
- **Audit cadence:** bumps require a council round per the version-pin comment in `index.ts`. Quarterly `pnpm audit --prod` check is a reasonable guardrail (could be automated via a scheduled GH Action).

---

## References

- CLAUDE.md §"Non-negotiables (no council run can override these)" — dep supply chain listed implicitly via the pin requirement.
- Council PR #50 r2 security persona: the non-negotiable that spawned this log.
- Council PR #48 r3 security persona (10/10): endorsed pinning as the "correct primary mitigation."
