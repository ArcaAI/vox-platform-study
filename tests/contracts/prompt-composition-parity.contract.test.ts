/**
 * TASK-947 §4.1 — prompt COMPOSITION cross-language parity (TypeScript half).
 *
 * `composePrompt` (`@arcaai/workflow-contract`) selects, renders and joins the fragments of a
 * composite instruction for the invocation route, the draft bench and the realtime `core.agent`
 * lane; `harness.temporal.interpreter.prompt_composition.compose_prompt` does the same for the
 * durable lane. Both read THIS fixture — the Python half is
 * `apps/harness/src/harness/tests/unit/temporal/interpreter/test_prompt_composition_parity.py` —
 * so a fragment that is selected on one lane and excluded on the other is a failing test, not
 * a production surprise. The suite also asserts the fixture is NOT VACUOUS.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The repo root has no `@arcaai/workflow-contract` dependency (a workspace package, not a root
// one), so the contract is imported from SOURCE by path — the same shape
// `prompt-template-parity.contract.test.ts` uses for exactly this reason.
const CONTRACT_SRC = path.resolve(__dirname, '../../packages/workflow-contract/src/prompt-composition.ts');
/* eslint-disable @typescript-eslint/no-explicit-any */
const contract: any = await import(/* @vite-ignore */ CONTRACT_SRC);
const { PromptCompositionEmptyError, composePrompt } = contract;

interface ExpectedComposition {
  prompt: string | null;
  selected: string[];
  excluded: Array<{ key: string; reason: 'condition_false' | 'condition_error' }>;
}

interface CompositionCase {
  name: string;
  resolvedPrompt: unknown;
  scope: Record<string, unknown>;
  expected?: ExpectedComposition;
  error?: 'PromptCompositionEmpty';
}

const fixture = JSON.parse(readFileSync(path.join(__dirname, 'prompt-composition.fixture.json'), 'utf-8')) as { cases: CompositionCase[] };

/** The names both loaders must carry — §4.1's minimum case list, by name. */
const REQUIRED_CASE_NAMES = [
  'null-prompt',
  'single-template-unchanged',
  'inline-unchanged',
  'base-only',
  'condition-true',
  'condition-false',
  'condition-error-excluded',
  'has-guard',
  'order-preserved',
  'per-fragment-render-no-cross-boundary',
  'inline-and-template-mixed',
  'bound-name-is-string',
  'input-root',
  'join-missing-defaults',
  'empty-raises',
] as const;

describe('prompt-composition fixture — not vacuous', () => {
  it('carries every case §4.1 names, both an exclusion of each reason, and an error case', () => {
    const names = fixture.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of REQUIRED_CASE_NAMES) expect(names).toContain(required);
    const reasons = new Set(fixture.cases.flatMap((entry) => entry.expected?.excluded.map((exclusion) => exclusion.reason) ?? []));
    expect(reasons).toEqual(new Set(['condition_false', 'condition_error']));
    expect(fixture.cases.filter((entry) => typeof entry.error === 'string').length).toBeGreaterThanOrEqual(1);
  });

  it('declares exactly one of `expected` / `error` per case', () => {
    for (const entry of fixture.cases) {
      expect((entry.expected ? 1 : 0) + (typeof entry.error === 'string' ? 1 : 0), `case ${entry.name} declares neither or both`).toBe(1);
    }
  });
});

describe('composePrompt over the shared fixture', () => {
  it.each(fixture.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    // The scope is cloned per case: a renderer that mutated it would leak into the next case.
    const scope = JSON.parse(JSON.stringify(entry.scope)) as Record<string, unknown>;
    if (entry.expected) {
      const result = composePrompt(entry.resolvedPrompt, scope, { templateRef: `fixture:${entry.name}` });
      expect(result.prompt).toBe(entry.expected.prompt);
      expect(result.selected).toEqual(entry.expected.selected);
      expect(result.excluded.map(({ key, reason }: { key: string; reason: string }) => ({ key, reason }))).toEqual(entry.expected.excluded);
      return;
    }
    expect(() => composePrompt(entry.resolvedPrompt, scope, { templateRef: `fixture:${entry.name}` })).toThrow(PromptCompositionEmptyError);
  });
});
