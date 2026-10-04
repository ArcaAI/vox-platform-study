import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AgentCompiledConfig, AgentCompiledPromptFragment, AgentPromptVariableDeclaration } from '../agent.js';

type ResolvedPrompt = NonNullable<AgentCompiledConfig['resolvedPrompt']>;
type TemplatePrompt = Extract<ResolvedPrompt, { source: 'template' }>;
type CompositePrompt = Extract<ResolvedPrompt, { source: 'composite' }>;

/**
 * TASK-1039 — `AgentCompiledConfig.resolvedPrompt` publishes the prompt's variable DECLARATIONS
 * (name, type, required, default), frozen at publish beside the content. A client builds an input
 * form from them instead of discovering a required variable one 400 at a time. ADDITIVE-OPTIONAL:
 * an artifact frozen before the field existed carries none.
 */
describe('AgentCompiledConfig.resolvedPrompt — variable declarations', () => {
  const declarations: AgentPromptVariableDeclaration[] = [
    { name: 'age', type: 'number', required: true },
    { name: 'ward', type: 'string', required: false, default: 'unknown', description: 'Where the patient is', source: { kind: 'context', path: 'patient.ward' } },
  ];

  it('a template-bound prompt carries them', () => {
    const prompt: TemplatePrompt = { source: 'template', promptTemplateId: 'p-1', promptVersionNumber: 2, content: 'Age {{age}}', variables: declarations };

    expect(prompt.variables?.map((v) => v.name)).toEqual(['age', 'ward']);
    expectTypeOf<TemplatePrompt['variables']>().toEqualTypeOf<AgentPromptVariableDeclaration[] | undefined>();
  });

  it('a composite fragment carries them (the composite as a whole does not repeat them)', () => {
    const fragment: AgentCompiledPromptFragment = { key: 'base', source: 'template', content: 'x', when: null, variables: declarations };
    const prompt: CompositePrompt = { source: 'composite', content: 'x', join: '\n\n', fragments: [fragment] };

    expect(prompt.fragments[0]?.variables).toHaveLength(2);
    expectTypeOf<AgentCompiledPromptFragment['variables']>().toEqualTypeOf<AgentPromptVariableDeclaration[] | undefined>();
  });

  it('is absent on an artifact frozen before the field existed', () => {
    const old: TemplatePrompt = { source: 'template', promptTemplateId: 'p-1', promptVersionNumber: 1, content: 'x' };
    expect(old.variables).toBeUndefined();
  });

  it('declares the value shapes a prompt variable may take', () => {
    expectTypeOf<AgentPromptVariableDeclaration['type']>().toEqualTypeOf<'string' | 'number' | 'boolean' | 'date' | 'json'>();
  });
});
