/**
 * TASK-1036 §10.1 — the ONE picker source: four groups in a fixed order, ancestors only, typed,
 * PHI-classed, ranked by fit when the target type is known.
 */
import { describe, expect, it } from 'vitest';
import { bindingSourcePaths, type BindingSourceGroup } from '../binding-source-paths';
import type { WorkflowGraph } from '../graph-model';

const AGENTS = {
  asr: { task: 'SPEECH_TO_TEXT' as const },
  gen: { task: 'TEXT_GENERATION' as const },
  finalize: {
    task: 'TEXT_GENERATION' as const,
    outputSchema: { type: 'object', properties: { case_note: { type: 'string', description: 'The note.' } } },
  },
};

const CONTEXT_DEFINITION = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'encounter',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      fields: { type: 'object', properties: { age: { type: 'integer', description: 'Age in years.' } } },
    },
    { key: 'transcript', primitive: 'TEXT', phiClass: 'PHI' },
  ],
};

function graph(sources: string[] = ['consultation']): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api', ...sources] } },
      { id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'asr' }, label: 'Transcribe' } },
      { id: 'n_finalize', type: 'core.agent', config: { agentRef: { slug: 'finalize' }, label: 'Finalize note' } },
      { id: 'n_side', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
      { id: 'n_vars', type: 'core.variable', config: { variables: [{ key: 'tone', schema: { type: 'string' } }] } },
      { id: 'n_target', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
      { id: 'n_output', type: 'core.output', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_asr', toPort: 'after' },
      { id: 'e2', from: 'n_asr', fromPort: 'transcript', to: 'n_finalize', toPort: 'in' },
      { id: 'e3', from: 'n_finalize', fromPort: 'out', to: 'n_target', toPort: 'in' },
      { id: 'e4', from: 'n_trigger', fromPort: 'next', to: 'n_side', toPort: 'after' },
      { id: 'e5', from: 'n_side', fromPort: 'out', to: 'n_output', toPort: 'in' },
      { id: 'e6', from: 'n_target', fromPort: 'out', to: 'n_output', toPort: 'in' },
    ],
  };
}

function group(groups: readonly BindingSourceGroup[], key: BindingSourceGroup['key']): BindingSourceGroup {
  const found = groups.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no group ${key}`);
  return found;
}

describe('bindingSourcePaths', () => {
  const groups = bindingSourcePaths(graph(), 'n_target', { contextSchema: CONTEXT_DEFINITION, agentOutputs: AGENTS });

  it('returns the four groups in the fixed order', () => {
    expect(groups.map((entry) => entry.key)).toEqual(['steps', 'context', 'consultation', 'run']);
    expect(groups.map((entry) => entry.label)).toEqual(['Earlier steps', 'Context', 'Consultation', 'Run & variables']);
  });

  it('Earlier steps offers ANCESTORS only, in execution order, by label with the raw id path beside it', () => {
    const steps = group(groups, 'steps');
    const raws = steps.items.map((item) => item.raw);
    expect(raws).toContain('nodes.n_asr.outputs.transcript');
    expect(raws).toContain('nodes.n_finalize.outputs.text');
    expect(raws).toContain('nodes.n_finalize.outputs.data');
    expect(raws).toContain('nodes.n_finalize.outputs.data.case_note');
    expect(raws.some((raw) => raw.startsWith('nodes.n_side.'))).toBe(false);
    expect(raws.some((raw) => raw.startsWith('nodes.n_target.'))).toBe(false);
    expect(raws.some((raw) => raw.startsWith('nodes.n_output.'))).toBe(false);
    expect(raws.indexOf('nodes.n_asr.outputs.transcript')).toBeLessThan(raws.indexOf('nodes.n_finalize.outputs.text'));

    const transcript = steps.items.find((item) => item.raw === 'nodes.n_asr.outputs.transcript');
    expect(transcript).toMatchObject({ path: 'Transcribe › transcript', type: 'text', phiClass: 'PHI' });
    expect(steps.items.find((item) => item.raw === 'nodes.n_finalize.outputs.data.case_note')).toMatchObject({
      path: 'Finalize note › data › case_note',
      type: 'text',
      description: 'The note.',
    });
  });

  it('a step with no label is shown by its id', () => {
    const later = bindingSourcePaths(graph(), 'n_output', { agentOutputs: AGENTS });
    expect(group(later, 'steps').items.find((item) => item.raw === 'nodes.n_side.outputs.text')?.path).toBe('n_side › text');
  });

  it('Context comes from the context schema, typed in the I/O vocabulary', () => {
    const context = group(groups, 'context');
    expect(context.items.map((item) => item.raw)).toEqual(['context.encounter', 'context.encounter.age', 'context.transcript']);
    expect(context.items.find((item) => item.raw === 'context.encounter.age')).toMatchObject({
      type: 'number',
      phiClass: 'PHI',
      description: 'Age in years.',
    });
  });

  it('Consultation offers the platform read schema', () => {
    const consultation = group(groups, 'consultation');
    expect(consultation.items.find((item) => item.raw === 'consultation.patient.age')).toMatchObject({ type: 'number', phiClass: 'PHI' });
    expect(consultation.items.every((item) => item.disabledReason === undefined)).toBe(true);
  });

  it('Consultation stays visible but disabled, with the reason, when the workflow is not consultation-bound', () => {
    const consultation = group(bindingSourcePaths(graph([]), 'n_target', { agentOutputs: AGENTS }), 'consultation');
    expect(consultation.items.length).toBeGreaterThan(0);
    expect(consultation.items.every((item) => item.disabledReason !== undefined && item.fit === 'blocked')).toBe(true);
  });

  it('Run & variables offers only the variables an ANCESTOR `core.variable` step declares, then the run fields', () => {
    // `n_vars` is not wired upstream of `n_target`, so its `tone` is not available there.
    expect(group(groups, 'run').items.some((item) => item.raw === 'vars.tone')).toBe(false);
    const wired = graph();
    wired.edges.push({ id: 'e7', from: 'n_trigger', fromPort: 'next', to: 'n_vars', toPort: 'after' });
    wired.edges.push({ id: 'e8', from: 'n_vars', fromPort: 'next', to: 'n_target', toPort: 'after' });
    const run = group(bindingSourcePaths(wired, 'n_target', { contextSchema: CONTEXT_DEFINITION, agentOutputs: AGENTS }), 'run');
    expect(run.items.map((item) => item.raw)).toEqual([
      'vars.tone',
      'run.id',
      'run.tenantId',
      'run.workflowSlug',
      'run.workflowVersion',
      'run.startedAt',
      'run.now',
    ]);
    expect(run.items[0]).toMatchObject({ type: 'text', phiClass: null });
  });

  it('an empty group says why', () => {
    const first = bindingSourcePaths(graph(), 'n_trigger', {});
    expect(group(first, 'steps')).toMatchObject({ items: [], emptyReason: 'Nothing runs before this step yet.' });
    expect(group(first, 'context')).toMatchObject({ items: [], emptyReason: 'No context schema is bound to this workflow.' });
  });

  it('with a target type, items are ranked match > convert > blocked, the first steps match is the best match, and blocked items say why', () => {
    const ranked = bindingSourcePaths(graph(), 'n_target', { contextSchema: CONTEXT_DEFINITION, agentOutputs: AGENTS, targetType: 'text' });
    const steps = group(ranked, 'steps').items;
    const fits = steps.map((item) => item.fit);
    expect(fits).toEqual(
      [...fits].sort((a, b) => ['match', 'convert', 'blocked'].indexOf(a ?? '') - ['match', 'convert', 'blocked'].indexOf(b ?? '')),
    );
    expect(steps.filter((item) => item.bestMatch === true)).toHaveLength(1);
    expect(steps[0]?.bestMatch).toBe(true);
    const converted = steps.find((item) => item.fit === 'convert');
    expect(converted?.convertNote).toBe('Formatted as text');
    const audioPicker = bindingSourcePaths(graph(), 'n_target', { agentOutputs: AGENTS, targetType: 'audio' });
    const blocked = group(audioPicker, 'steps').items.find((item) => item.raw === 'nodes.n_asr.outputs.transcript');
    expect(blocked).toMatchObject({ fit: 'blocked', disabledReason: "Can't use text here" });
  });

  it('is total: an unknown node yields four groups and no throw', () => {
    expect(bindingSourcePaths(graph(), 'n_nope', {}).map((entry) => entry.key)).toEqual(['steps', 'context', 'consultation', 'run']);
  });
});
