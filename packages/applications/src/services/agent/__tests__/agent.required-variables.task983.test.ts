/**
 * TASK-983 R9 (lane J) — `requiredVariables`: what an invocation MUST send, PUBLISHED.
 *
 * The defect: `GET /api/v1/agents/{slug}` served `{ slug, name, task, versionNumber,
 * isTenantDefault, inputSchema, outputSchema }` and nothing about the placeholders the agent's
 * composed instruction reads. `general-medicine-summarization` references NINE
 * `trigger.context.*` paths; the gateway revealed them one 400 at a time, so no developer could
 * assemble a correct body from the contract. Three things are pinned here:
 *
 *  1. the computation itself — defaults excluded, the agent's OWN bound variables excluded, a
 *     `{ path }` binding contributing the path it reads (that binding is resolved on EVERY
 *     render, referenced or not, so it is a hard requirement of the call);
 *  2. the mapper PROJECTS `compiledConfig.requiredVariables` — publish computes, the read does
 *     not render;
 *  3. a LEGACY row published before this ticket carries no such key and still answers
 *     correctly, recomputed from the frozen `resolvedPrompt`. Absence means "not computed",
 *     never "nothing required".
 */
import { describe, expect, it } from 'vitest';
import { AgentTask, ResourceStatusType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentDtoMapper } from '../agent.dto.mapper';
import { agentRequiredVariables, promptVariableSlot } from '../agent-required-variables';

const TENANT = '50000000-0000-0000-0000-000000000000';

const NINE = [
  'trigger.context.chief_complaint',
  'trigger.context.current_department',
  'trigger.context.formatted_previous_visits',
  'trigger.context.formatted_vitals',
  'trigger.context.language',
  'trigger.context.safe_age',
  'trigger.context.safe_dob',
  'trigger.context.safe_gender',
  'trigger.context.visit_type',
];

const compositeResolvedPrompt = {
  source: 'composite' as const,
  join: '\n\n',
  content: '',
  fragments: [
    {
      key: 'base',
      source: 'inline' as const,
      when: null,
      content:
        'Language {{trigger.context.language}}. Patient {{trigger.context.safe_age}} {{trigger.context.safe_gender}} ' +
        'born {{trigger.context.safe_dob}}. Complaint {{trigger.context.chief_complaint}} in ' +
        '{{trigger.context.current_department}}. Vitals {{trigger.context.formatted_vitals}}. Visit {{trigger.context.visit_type}}.',
    },
    {
      key: 'revisit',
      source: 'inline' as const,
      when: 'context.visit_type == "revisit"',
      content: 'Prior visits: {{trigger.context.formatted_previous_visits}}',
    },
  ],
};

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    tenantId: TENANT,
    slug: 'general-medicine-summarization',
    name: 'General medicine summarization',
    description: null,
    task: AgentTask.TEXT_GENERATION,
    versionNumber: 3,
    status: WorkflowDefinitionStatus.PUBLISHED,
    isActive: true,
    modelId: 'model-llm',
    instruction: null,
    parameters: null,
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    resourceStatus: ResourceStatusType.ENABLED,
    tags: [],
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: new Date(),
    ...overrides,
  } as never;
}

describe('agentRequiredVariables', () => {
  it('lists every undefaulted placeholder of every fragment, sorted and de-duplicated', () => {
    expect(agentRequiredVariables(null, compositeResolvedPrompt)).toEqual(NINE);
  });

  it('drops a placeholder the agent`s own bound variables supply', () => {
    const instruction = { variables: { tone: { value: 'concise' }, ward: '3' } };
    const prompt = { source: 'inline' as const, content: '{{tone}} {{ward}} {{variables.tone}} {{input.text}}' };
    expect(agentRequiredVariables(instruction, prompt)).toEqual(['input.text']);
  });

  it('reports the PATH a `{ path }` binding reads — that binding resolves on every render, referenced or not', () => {
    const instruction = { variables: { age: { path: 'trigger.context.safe_age' } } };
    expect(agentRequiredVariables(instruction, { source: 'inline' as const, content: 'Patient is {{age}}.' })).toEqual([
      'trigger.context.safe_age',
    ]);
    // …and even when the prompt never mentions the bound name.
    expect(agentRequiredVariables(instruction, { source: 'inline' as const, content: 'no placeholders' })).toEqual([
      'trigger.context.safe_age',
    ]);
  });

  it('drops a defaulted placeholder and answers `[]` for an agent with no instruction', () => {
    expect(agentRequiredVariables(null, { source: 'inline' as const, content: '{{ x | default("-") }}' })).toEqual([]);
    expect(agentRequiredVariables(null, null)).toEqual([]);
  });
});

describe('promptVariableSlot — which request key satisfies a path', () => {
  it('maps every root the invocation plane can actually be handed', () => {
    expect(promptVariableSlot('trigger.context.language', [])).toBe('context');
    expect(promptVariableSlot('context.visit_type', [])).toBe('context');
    expect(promptVariableSlot('input.text', [])).toBe('input');
    expect(promptVariableSlot('tone', [])).toBe('variables');
    expect(promptVariableSlot('variables.tone', [])).toBe('variables');
    expect(promptVariableSlot('patient.name', ['patient'])).toBe('variables');
  });

  it('answers `null` for a root no invocation can supply — a workflow-only namespace', () => {
    expect(promptVariableSlot('vars.total', [])).toBeNull();
    expect(promptVariableSlot('nodes.n1.output', [])).toBeNull();
  });
});

describe('AgentDtoMapper.toSummary', () => {
  it('PROJECTS the list publish froze — the read never re-renders', () => {
    const summary = AgentDtoMapper.toSummary(
      agentRow({ compiledConfig: { resolvedPrompt: compositeResolvedPrompt, instruction: null, requiredVariables: ['already.frozen'] } }),
      true,
    );
    expect(summary.requiredVariables).toEqual(['already.frozen']);
  });

  it('recomputes for a LEGACY row published before this ticket (no `requiredVariables` key)', () => {
    const summary = AgentDtoMapper.toSummary(
      agentRow({ compiledConfig: { resolvedPrompt: compositeResolvedPrompt, instruction: null } }),
      true,
    );
    expect(summary.requiredVariables).toEqual(NINE);
  });

  it('answers `[]` for an agent whose instruction asks for nothing, and for an unpublished row', () => {
    expect(AgentDtoMapper.toSummary(agentRow({ compiledConfig: { resolvedPrompt: { source: 'inline', content: 'hi' } } }), false).requiredVariables).toEqual(
      [],
    );
    expect(AgentDtoMapper.toSummary(agentRow(), false).requiredVariables).toEqual([]);
  });

  it('emits the whole business-plane contract an integrator reads', () => {
    const summary = AgentDtoMapper.toSummary(
      agentRow({
        description: 'Summarises a general-medicine consultation into a SOAP note.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        outputSchema: { type: 'object', properties: { case_note: { type: 'string' } }, required: ['case_note'] },
        compiledConfig: { resolvedPrompt: compositeResolvedPrompt, instruction: null, requiredVariables: NINE },
      }),
      true,
    );
    expect(summary).toEqual({
      slug: 'general-medicine-summarization',
      name: 'General medicine summarization',
      description: 'Summarises a general-medicine consultation into a SOAP note.',
      task: 'TEXT_GENERATION',
      versionNumber: 3,
      isTenantDefault: true,
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      outputSchema: { type: 'object', properties: { case_note: { type: 'string' } }, required: ['case_note'] },
      requiredVariables: NINE,
    });
  });
});
