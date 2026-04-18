// Eval runner. Loads every *.eval.ts in this folder and runs its cases.
// Each case produces ok | expected-fail | unexpected-fail | unexpected-ok.
//
// Executed via `pnpm --filter @llmwiki/prompts run eval`. Exits non-zero on
// any unexpected outcome. CI (commit 9) wires this into the pnpm test
// aggregate.

import simplifierSuite from './simplifier.eval';
import type { EvalSuite, EvalCase } from './types';

const ALL_SUITES: EvalSuite[] = [simplifierSuite];

type Outcome = 'ok' | 'expected-fail' | 'unexpected-fail' | 'unexpected-ok';

interface Result {
  suite: string;
  case: string;
  outcome: Outcome;
  error?: string;
}

function runCase(caseName: string, c: EvalCase): Result {
  const output = c.fixtureOutput ?? '';
  try {
    c.check(output);
    return {
      suite: '',
      case: caseName,
      outcome: c.expectFailure ? 'unexpected-ok' : 'ok',
    };
  } catch (err) {
    return {
      suite: '',
      case: caseName,
      outcome: c.expectFailure ? 'expected-fail' : 'unexpected-fail',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const results: Result[] = [];
for (const suite of ALL_SUITES) {
  for (const c of suite.cases) {
    const r = runCase(c.name, c);
    r.suite = suite.name;
    results.push(r);
  }
}

let bad = 0;
for (const r of results) {
  const tag =
    r.outcome === 'ok'
      ? 'OK  '
      : r.outcome === 'expected-fail'
        ? 'X   '
        : r.outcome === 'unexpected-fail'
          ? 'FAIL'
          : 'MISS';
  console.warn(`[eval] ${tag} ${r.suite} :: ${r.case}${r.error ? ' — ' + r.error : ''}`);
  if (r.outcome === 'unexpected-fail' || r.outcome === 'unexpected-ok') bad++;
}

console.warn(`[eval] ${results.length - bad}/${results.length} expected, ${bad} unexpected`);
if (bad > 0) process.exit(1);
