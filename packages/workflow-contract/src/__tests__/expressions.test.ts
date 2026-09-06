/**
 * TASK-864 §3.2 — the expression language, held to the CROSS-LANGUAGE fixture.
 *
 * `fixtures/expressions.fixture.json` is evaluated here (TypeScript) and by
 * `apps/harness/.../test_expressions_parity.py` (Python). The two evaluators are hand-written
 * mirrors; the fixture is the only thing that proves they agree, so every capability either
 * side supports has a case in it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPRESSION_CONTEXT_ROOTS,
  evaluateCondition,
  evaluateExpression,
  expressionProblems,
  expressionRootIdentifiers,
  parseExpression,
} from '../expressions';
import type { ExpressionValue } from '../expressions';

interface FixtureCase {
  name: string;
  expression: string;
  expected?: ExpressionValue;
  error?: true;
}
interface Fixture {
  context: { [key: string]: ExpressionValue };
  cases: FixtureCase[];
}

const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, 'fixtures/expressions.fixture.json'), 'utf8')) as Fixture;

describe('expressions — the cross-language parity fixture', () => {
  it('has at least one error case and one value case (the fixture is not vacuous)', () => {
    expect(FIXTURE.cases.some((c) => c.error === true)).toBe(true);
    expect(FIXTURE.cases.some((c) => c.error !== true)).toBe(true);
  });

  for (const fixtureCase of FIXTURE.cases) {
    it(`${fixtureCase.name}: ${fixtureCase.expression}`, () => {
      const result = evaluateExpression(fixtureCase.expression, FIXTURE.context);
      if (fixtureCase.error === true) {
        expect('error' in result, `expected an error, got ${JSON.stringify(result)}`).toBe(true);
      } else {
        expect(result).toEqual({ value: fixtureCase.expected });
      }
    });
  }
});

describe('expressionProblems / parseExpression', () => {
  it('accepts a well-formed expression', () => {
    expect(expressionProblems("trigger.department == 'cardiology'")).toEqual([]);
  });

  it('refuses an empty expression and a non-string', () => {
    expect(expressionProblems('')).toHaveLength(1);
    expect(expressionProblems(42)).toEqual(['expression must be a string']);
  });

  it('reports a parse failure as a problem, never a throw', () => {
    expect(expressionProblems('1 +')[0]).toContain('does not parse');
    expect('error' in parseExpression('(')).toBe(true);
  });
});

describe('evaluateCondition', () => {
  it('is taken only on the boolean true', () => {
    expect(evaluateCondition('1 == 1', {})).toEqual({ taken: true });
    expect(evaluateCondition('1 == 2', {})).toEqual({ taken: false });
  });

  it('a non-boolean result is NOT taken and names the type', () => {
    const result = evaluateCondition("'yes'", {});
    expect(result.taken).toBe(false);
    expect(result.error).toContain('boolean');
  });

  it('an evaluation error is NOT taken (an error never routes a branch)', () => {
    expect(evaluateCondition('vars.missing == 1', { vars: {} }).taken).toBe(false);
  });
});

describe('expressionRootIdentifiers — what the Studio autocompletes and publish checks', () => {
  it('lists every root identifier, sorted and deduplicated', () => {
    expect(expressionRootIdentifiers('nodes.a.text.contains(vars.needle) && trigger.age > vars.min')).toEqual(['nodes', 'trigger', 'vars']);
  });

  it('the three declared roots are exactly trigger / vars / nodes', () => {
    expect([...EXPRESSION_CONTEXT_ROOTS].sort()).toEqual(['nodes', 'trigger', 'vars']);
  });

  it('a literal-only expression has no roots', () => {
    expect(expressionRootIdentifiers('1 + 2')).toEqual([]);
  });
});

describe('determinism and totality', () => {
  it('evaluates the same expression to the same value every time', () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i += 1) results.add(JSON.stringify(evaluateExpression('size(trigger.flags) * 2', FIXTURE.context)));
    expect(results.size).toBe(1);
  });

  it('never throws on garbage', () => {
    for (const source of ['', ')', '{', '[1,', 'a.', '1 ? 2', "'unterminated", '\0']) {
      expect(() => evaluateExpression(source, {})).not.toThrow();
      expect('error' in evaluateExpression(source, {})).toBe(true);
    }
  });
});
