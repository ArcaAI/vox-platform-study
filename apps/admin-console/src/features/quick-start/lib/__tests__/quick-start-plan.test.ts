import { describe, expect, it, vi } from 'vitest';
import { registryChecksum, schemaVariablePaths, validate, workflowNodeClassLookup } from '@arcaai/workflow-contract';
import { SCHEMA_PRESETS, quickStartGraph, runQuickStart, type QuickStartApi, type QuickStartInput, type QuickStartStepState } from '../quick-start-plan';

const SCHEMA_ID = '0190a1b2-0000-7000-8000-000000000001';

function api(overrides: Partial<QuickStartApi> = {}): QuickStartApi {
  return {
    createContextSchema: vi.fn(async () => ({ id: SCHEMA_ID })),
    publishContextSchema: vi.fn(async () => ({ id: SCHEMA_ID, pinnedVersionNumber: 1 })),
    createAgent: vi.fn(async () => ({ id: 'agent-1', slug: 'visit-notes' })),
    publishAgent: vi.fn(async () => ({ id: 'agent-1', slug: 'visit-notes' })),
    createWorkflowDefinition: vi.fn(async () => ({ id: 'wf-1', slug: 'visit-notes-flow' })),
    publishWorkflowDefinition: vi.fn(async () => ({ id: 'wf-1', slug: 'visit-notes-flow' })),
    createWorkflowAssignment: vi.fn(async () => ({ id: 'as-1' })),
    ...overrides,
  };
}

const INPUT: QuickStartInput = {
  schema: { mode: 'preset', presetKey: SCHEMA_PRESETS[0]!.key, name: 'Visit context' },
  agent: { name: 'Visit notes', slug: 'visit-notes', modelId: 'model-1', instruction: { systemPrompt: 'Summarise {{context.transcript}}' } },
  workflow: { name: 'Visit notes flow', slug: 'visit-notes-flow' },
  assignment: { scope: 'DEPARTMENT', departmentId: 'dept-1' },
};

describe('quick-start plan', () => {
  it('ships presets whose definitions yield prompt paths', () => {
    expect(SCHEMA_PRESETS.length).toBeGreaterThan(0);
    for (const preset of SCHEMA_PRESETS) expect(schemaVariablePaths(preset.definition, 'context').length).toBeGreaterThan(0);
  });

  it('builds a trigger → agent → output graph the contract validates without errors', () => {
    const graph = quickStartGraph({ contextSchemaId: SCHEMA_ID, agentSlug: 'visit-notes' });
    const report = validate(graph, { paletteKey: 'core', registry: workflowNodeClassLookup }, { ruleSetVersion: 1, registryChecksum: registryChecksum() });
    expect(report.findings.filter((finding) => finding.severity === 'ERROR')).toEqual([]);
    expect(graph.nodes.find((node) => node.type === 'core.agent')?.config).toEqual({ agentRef: { slug: 'visit-notes' } });
  });

  it('runs schema → agent → workflow → assignment in order, wiring each id into the next', async () => {
    const calls = api();
    const states: Record<string, QuickStartStepState> = {};
    const result = await runQuickStart(INPUT, calls, (step, state) => {
      states[step] = state;
    });
    expect(result.ok).toBe(true);
    expect(calls.publishContextSchema).toHaveBeenCalledWith(SCHEMA_ID, expect.objectContaining({ definition: SCHEMA_PRESETS[0]!.definition }));
    expect(calls.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'visit-notes', task: 'TEXT_GENERATION', modelId: 'model-1', contextSchemaId: SCHEMA_ID, instruction: { systemPrompt: 'Summarise {{context.transcript}}' } }),
    );
    expect(calls.publishAgent).toHaveBeenCalledWith('agent-1', { activate: true });
    expect(calls.createWorkflowDefinition).toHaveBeenCalledWith(expect.objectContaining({ slug: 'visit-notes-flow', paletteKey: 'core' }));
    expect(calls.publishWorkflowDefinition).toHaveBeenCalledWith('wf-1', { activate: true });
    expect(calls.createWorkflowAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'DEPARTMENT', scopeId: 'dept-1', paletteKey: 'core', workflowDefinitionSlug: 'visit-notes-flow' }),
    );
    expect(Object.values(states).every((state) => state.status === 'done')).toBe(true);
    expect(states.agent?.href).toBe('/agents?slug=visit-notes');
    expect(states.workflow?.href).toBe('/workflow-studio/wf-1');
  });

  it('skips creation for an existing schema', async () => {
    const calls = api();
    await runQuickStart({ ...INPUT, schema: { mode: 'existing', schemaId: SCHEMA_ID } }, calls, () => undefined);
    expect(calls.createContextSchema).not.toHaveBeenCalled();
    expect(calls.createAgent).toHaveBeenCalledWith(expect.objectContaining({ contextSchemaId: SCHEMA_ID }));
  });

  it('stops at the first failing step and names it', async () => {
    const calls = api({ publishAgent: vi.fn(async () => Promise.reject(new Error('TEMPLATE_NOT_APPROVED'))) });
    const states: Record<string, QuickStartStepState> = {};
    const result = await runQuickStart(INPUT, calls, (step, state) => {
      states[step] = state;
    });
    expect(result.ok).toBe(false);
    expect(states.agent).toEqual(expect.objectContaining({ status: 'error', message: 'TEMPLATE_NOT_APPROVED' }));
    expect(states.workflow).toBeUndefined();
    expect(calls.createWorkflowDefinition).not.toHaveBeenCalled();
  });
});
