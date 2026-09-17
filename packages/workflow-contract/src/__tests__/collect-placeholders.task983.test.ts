/**
 * TASK-983 R9 (lane J) — `collectPlaceholders` / `resolveTemplatePath` /
 * `requiredPromptVariables` / `unresolvedPromptVariables`.
 *
 * The defect these close: `POST /agents/{slug}/invocations` revealed the placeholders an
 * agent's instruction needs ONE PER CALL, because the renderer throws on the FIRST unresolved
 * one and nothing publishes the set. A developer could not build a correct body from the
 * published contract. Everything here is pure and lives beside the grammar it reads, so the
 * publish-time projection and the request-time diff can never disagree about what a template
 * asks for.
 */
import { describe, expect, it } from 'vitest';
import { collectPlaceholders, resolveTemplatePath } from '../template';
import { requiredPromptVariables, unresolvedPromptVariables } from '../prompt-composition';
import type { CompositeResolvedPrompt } from '../prompt-composition';

describe('collectPlaceholders', () => {
  it('returns every referenced path, sorted and de-duplicated', () => {
    const template = 'Hello {{ b.two }} and {{a_one}} and {{ b.two }} again.';
    expect(collectPlaceholders(template)).toEqual([
      { path: 'a_one', hasDefault: false },
      { path: 'b.two', hasDefault: false },
    ]);
  });

  it('marks a placeholder defaulted only when EVERY occurrence carries `default(...)`', () => {
    expect(collectPlaceholders('{{ x | default("-") }}')).toEqual([{ path: 'x', hasDefault: true }]);
    // One undefaulted occurrence makes the whole path required: that occurrence is the one
    // that throws, and a caller told "this is optional" would be told a lie.
    expect(collectPlaceholders('{{ x | default("-") }} {{ x }}')).toEqual([{ path: 'x', hasDefault: false }]);
  });

  it('walks a composed instruction fragment by fragment and merges the result', () => {
    const fragments = ['base {{trigger.context.language}}', 'revisit {{trigger.context.visit_type}}', 'again {{trigger.context.language}}'];
    expect(collectPlaceholders(fragments).map((reference) => reference.path)).toEqual([
      'trigger.context.language',
      'trigger.context.visit_type',
    ]);
  });

  it('ignores escapes, single braces and malformed placeholders, and tolerates empty input', () => {
    expect(collectPlaceholders('{{{{literal}} {single} {{ 9bad }}')).toEqual([]);
    expect(collectPlaceholders([])).toEqual([]);
    expect(collectPlaceholders(['', null, undefined, 'x {{a}}'])).toEqual([{ path: 'a', hasDefault: false }]);
  });

  it('keeps nested paths whole (an index is not a namespace)', () => {
    expect(collectPlaceholders('{{a.b.c}} {{list.0}}').map((reference) => reference.path)).toEqual(['a.b.c']);
  });
});

describe('resolveTemplatePath', () => {
  it('is the traversal the renderer uses: own properties, plain objects, `null` is missing', () => {
    const scope = { a: { b: 'x' }, n: null, list: ['q'] };
    expect(resolveTemplatePath(scope, 'a.b')).toBe('x');
    expect(resolveTemplatePath(scope, 'a.missing')).toBeUndefined();
    expect(resolveTemplatePath(scope, 'n')).toBeUndefined();
    expect(resolveTemplatePath(scope, 'list.0')).toBeUndefined();
    expect(resolveTemplatePath(scope, 'toString')).toBeUndefined();
  });
});

const composite: CompositeResolvedPrompt = {
  source: 'composite',
  content: 'base {{trigger.context.language}}',
  join: '\n\n',
  fragments: [
    { key: 'base', source: 'inline', content: 'base {{trigger.context.language}}', when: null },
    { key: 'revisit', source: 'inline', content: 'prior {{trigger.context.formatted_previous_visits}}', when: 'context.visit_type == "revisit"' },
    { key: 'defaulted', source: 'inline', content: '{{ trigger.context.safe_age | default("unknown") }}', when: null },
  ],
};

describe('requiredPromptVariables', () => {
  it('reads a single-body prompt', () => {
    expect(requiredPromptVariables({ source: 'inline', content: 'a {{x}} b {{ y | default("-") }}' })).toEqual(['x']);
  });

  it('reads EVERY fragment of a composite, conditional ones included', () => {
    expect(requiredPromptVariables(composite)).toEqual(['trigger.context.formatted_previous_visits', 'trigger.context.language']);
  });

  it('is empty for an agent with no instruction', () => {
    expect(requiredPromptVariables(null)).toEqual([]);
  });
});

describe('unresolvedPromptVariables', () => {
  it('names every placeholder the scope does not supply, in one answer', () => {
    expect(unresolvedPromptVariables({ source: 'inline', content: '{{a}} {{b.c}} {{d}}' }, { b: {} })).toEqual(['a', 'b.c', 'd']);
  });

  it('is selection-aware: a fragment this call excludes asks for nothing', () => {
    const scope = { trigger: { context: { language: 'en' } }, context: { visit_type: 'new' } };
    expect(unresolvedPromptVariables(composite, scope)).toEqual([]);
  });

  it('includes an excluded fragment`s variables once its condition holds', () => {
    const scope = { trigger: { context: { language: 'en' } }, context: { visit_type: 'revisit' } };
    expect(unresolvedPromptVariables(composite, scope)).toEqual(['trigger.context.formatted_previous_visits']);
  });

  it('returns nothing when every fragment is excluded — that is `PromptCompositionEmpty`, not a missing variable', () => {
    const allConditional: CompositeResolvedPrompt = {
      source: 'composite',
      content: '',
      join: '\n\n',
      fragments: [{ key: 'only', source: 'inline', content: '{{x}}', when: 'context.visit_type == "revisit"' }],
    };
    expect(unresolvedPromptVariables(allConditional, { context: { visit_type: 'new' } })).toEqual([]);
  });
});
