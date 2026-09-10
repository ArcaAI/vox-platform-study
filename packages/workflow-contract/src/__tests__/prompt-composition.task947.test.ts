/**
 * TASK-947 §4.1 — `composePrompt`: select the fragments whose `when` holds over the ONE render
 * scope, render each through the one grammar, join. The cross-language fixture
 * (`tests/contracts/prompt-composition.fixture.json`) pins the observable outputs; this suite
 * pins what the fixture cannot — the error identities, the `templateRef` naming inside a
 * fragment, the static projection, and the publish-time root check.
 */
import { describe, expect, it } from 'vitest';
import { PromptTemplateSyntaxError, PromptVariableUnresolvedError } from '../template';
import {
  AGENT_CONDITION_ROOTS,
  PROMPT_COMPOSITION_JOIN,
  PromptCompositionEmptyError,
  composePrompt,
  conditionRootProblems,
  staticProjection,
  type CompositeResolvedPrompt,
} from '../prompt-composition';

const scope = { context: { visit_type: 'revisit', patient_age: 12 }, vars: { tone: 'concise' }, language: 'en', variables: { language: 'en' } };

const composite = (fragments: CompositeResolvedPrompt['fragments'], join?: string): CompositeResolvedPrompt => ({
  source: 'composite',
  content: staticProjection(fragments),
  join: join ?? PROMPT_COMPOSITION_JOIN,
  fragments,
});

describe('composePrompt — the two pre-947 shapes are untouched', () => {
  it('null ⇒ no prompt, nothing selected, nothing excluded', () => {
    expect(composePrompt(null, scope)).toEqual({ prompt: null, selected: [], excluded: [] });
    expect(composePrompt(undefined, scope)).toEqual({ prompt: null, selected: [], excluded: [] });
  });

  it('template / inline ⇒ the rendered content, with empty selection bookkeeping', () => {
    expect(composePrompt({ source: 'inline', content: 'Be {{vars.tone}}.' }, scope)).toEqual({ prompt: 'Be concise.', selected: [], excluded: [] });
    expect(composePrompt({ source: 'template', promptTemplateId: 't', promptVersionNumber: 1, content: '{{language}}' }, scope).prompt).toBe('en');
  });

  it('an unresolved variable in a single-template prompt raises exactly as `renderTemplate` does, naming the templateRef', () => {
    expect(() => composePrompt({ source: 'inline', content: '{{missing}}' }, scope, { templateRef: 'agent:x' })).toThrow(
      PromptVariableUnresolvedError,
    );
    try {
      composePrompt({ source: 'inline', content: '{{missing}}' }, scope, { templateRef: 'agent:x' });
    } catch (error) {
      expect((error as PromptVariableUnresolvedError).templateRef).toBe('agent:x');
    }
  });
});

describe('composePrompt — composite', () => {
  it('renders each SELECTED fragment separately and joins with the artifact`s join', () => {
    const result = composePrompt(
      composite(
        [
          { key: 'base', source: 'inline', content: 'Base {{vars.tone}}.', when: null },
          { key: 'revisit', source: 'inline', content: 'Revisit.', when: "context.visit_type == 'revisit'" },
        ],
        ' | ',
      ),
      scope,
    );
    expect(result).toEqual({ prompt: 'Base concise. | Revisit.', selected: ['base', 'revisit'], excluded: [] });
  });

  it('a fragment whose condition is false or cannot evaluate is EXCLUDED and named, never fatal (OD-5)', () => {
    const result = composePrompt(
      composite([
        { key: 'base', source: 'inline', content: 'B', when: null },
        { key: 'adult', source: 'inline', content: 'A', when: 'context.patient_age >= 18' },
        { key: 'broken', source: 'inline', content: 'X', when: "context.missing == 'x'" },
      ]),
      scope,
    );
    expect(result.prompt).toBe('B');
    expect(result.selected).toEqual(['base']);
    expect(result.excluded.map((entry) => [entry.key, entry.reason])).toEqual([
      ['adult', 'condition_false'],
      ['broken', 'condition_error'],
    ]);
    expect(result.excluded[1]?.detail).toMatch(/missing/);
  });

  it('an unresolved variable INSIDE a fragment names the fragment: `<templateRef>#<key>`', () => {
    const prompt = composite([
      { key: 'base', source: 'inline', content: 'B', when: null },
      { key: 'peds', source: 'inline', content: '{{nope}}', when: 'context.patient_age < 18' },
    ]);
    try {
      composePrompt(prompt, scope, { templateRef: 'agent:kids' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PromptVariableUnresolvedError);
      expect((error as PromptVariableUnresolvedError).templateRef).toBe('agent:kids#peds');
      expect((error as PromptVariableUnresolvedError).path).toBe('nope');
    }
  });

  it('a syntax error inside a fragment is a PromptTemplateSyntaxError — publish should have caught it, the runtime still refuses', () => {
    const prompt = composite([{ key: 'base', source: 'inline', content: '{{ unterminated', when: null }]);
    expect(() => composePrompt(prompt, scope)).toThrow(PromptTemplateSyntaxError);
  });

  it('zero selected fragments raises PromptCompositionEmptyError, naming the templateRef', () => {
    const prompt = composite([{ key: 'only', source: 'inline', content: 'X', when: 'context.patient_age > 99' }]);
    expect(() => composePrompt(prompt, scope, { templateRef: 'agent:x' })).toThrow(PromptCompositionEmptyError);
    try {
      composePrompt(prompt, scope, { templateRef: 'agent:x' });
    } catch (error) {
      expect((error as PromptCompositionEmptyError).name).toBe('PromptCompositionEmpty');
      expect((error as PromptCompositionEmptyError).templateRef).toBe('agent:x');
    }
  });

  it('a composite artifact with no `join` uses the fixed default', () => {
    const { join: _drop, ...noJoin } = composite([
      { key: 'a', source: 'inline', content: 'A', when: null },
      { key: 'b', source: 'inline', content: 'B', when: null },
    ]);
    expect(composePrompt(noJoin as unknown as CompositeResolvedPrompt, scope).prompt).toBe(`A${PROMPT_COMPOSITION_JOIN}B`);
    expect(PROMPT_COMPOSITION_JOIN).toBe('\n\n');
  });

  it('does not mutate the scope it evaluates against', () => {
    const frozen = JSON.parse(JSON.stringify(scope)) as typeof scope;
    composePrompt(composite([{ key: 'a', source: 'inline', content: '{{language}}', when: 'has(context.visit_type)' }]), frozen);
    expect(frozen).toEqual(scope);
  });
});

describe('staticProjection — what an older reader sees (OD-3)', () => {
  it('joins the UNCONDITIONAL fragments` raw content, in order, and nothing else', () => {
    expect(
      staticProjection([
        { key: 'a', source: 'inline', content: 'A', when: 'x' },
        { key: 'b', source: 'inline', content: 'B {{v}}', when: null },
        { key: 'c', source: 'template', promptTemplateId: 't', promptVersionNumber: 1, content: 'C', when: null },
      ]),
    ).toBe('B {{v}}\n\nC');
    expect(staticProjection([])).toBe('');
  });
});

describe('conditionRootProblems — the publish-time root check (OD-4)', () => {
  it('declares the six roots a `when` may read', () => {
    expect([...AGENT_CONDITION_ROOTS]).toEqual(['context', 'trigger', 'input', 'vars', 'nodes', 'variables']);
  });

  it('accepts the roots, the bound names, and a `has()` over a root', () => {
    expect(conditionRootProblems("has(context.visit_type) && context.visit_type == 'revisit'", [])).toEqual([]);
    expect(conditionRootProblems("language == 'en' && input.text != ''", ['language'])).toEqual([]);
  });

  it('names an identifier that is neither a root nor a bound name', () => {
    const problems = conditionRootProblems("department == 'ent' && vars.x", ['language']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/department/);
    expect(problems[0]).toMatch(/context|bound/);
  });

  it('answers nothing for an expression that does not parse — syntax is a separate finding', () => {
    expect(conditionRootProblems('context.visit_type ==', [])).toEqual([]);
  });
});
