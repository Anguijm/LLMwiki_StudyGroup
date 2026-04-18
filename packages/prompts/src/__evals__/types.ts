// Shared eval types. Every eval file exports a default object matching this
// contract; the runner iterates all of them and reports pass/fail.

export interface EvalCase {
  name: string;
  input: string;
  /**
   * Called with the LLM-produced output. Throws to fail. Return void to pass.
   * For v0 we do not actually call the LLM in `pnpm eval` (no API key in CI
   * guaranteed); instead evals exercise the *prompt construction* and output
   * *shape checks*. See simplifier.eval.ts for a concrete example.
   */
  check: (output: string) => void;
  /**
   * Optional override: a fake output to test the shape checker itself, e.g.
   * 'adversarial' fixtures that MUST fail. If provided, the runner uses this
   * instead of an LLM response.
   */
  fixtureOutput?: string;
  /** If true, the check is expected to throw — an assertion of "this fails". */
  expectFailure?: boolean;
}

export interface EvalSuite {
  name: string;
  cases: EvalCase[];
}
