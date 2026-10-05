/**
 * TASK-1036 §10.1 — the pure models behind the composer UI: the four-group picker, binding chips,
 * the Inputs panel rows, the no-code condition builder, the Merge preset, the settings dialog's
 * implications, and the W2 generation fields.
 */
import { describe, expect, it } from 'vitest';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { filterPickerGroups, formatSample, pickerGroups, samplesFromRunOutputs } from '../picker-model';
import { describeBinding, pathLabel, scopeOfPath } from '../binding-display';
import { inputRows, promptVariableBinding, promptVariableText } from '../inputs-model';
import { celPathOf, celToCondition, conditionToCel } from '../condition-builder';
import { MERGE_PRESET, PALETTE_PRESETS } from '../palette-presets';
import { connectionOptions, settingsDraftOf, toWorkflowSettings, withImpliedConnections } from '../settings-model';
import { generationFields, modelCapabilitiesOf } from '../generation-model';

const AGENTS: AgentIOResolver = { asr: { task: 'SPEECH_TO_TEXT' }, writer: { task: 'TEXT_GENERATION' }, tts: { task: 'TEXT_TO_SPEECH' } };

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}
const NODES = [
  node('t', 'core.trigger'),
  node('asr1', 'core.agent', { agentRef: { slug: 'asr' }, label: 'Transcribe' }),
  node('w', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Draft note' }),
  node('later', 'core.agent', { agentRef: { slug: 'writer' }, label: 'Later' }),
];
const EDGES: GraphStoreEdge[] = [
  { id: 'e1', source: 't', sourceHandle: 'next', target: 'asr1', targetHandle: 'after' },
  { id: 'e2', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
  { id: 'e3', source: 'w', sourceHandle: 'next', target: 'later', targetHandle: 'after' },
];
const CONTEXT_SCHEMA = {
  kinds: [{ key: 'encounter', primitive: 'STRUCTURED', fields: { type: 'object', properties: { reason: { type: 'string', description: 'Why the patient came' } } } }],
};

describe('pickerGroups — one picker, four groups in order (§10.1)', () => {
  it('offers ancestors only, by label, ranked by fit, with the best match marked', () => {
    const groups = pickerGroups({ nodes: NODES, edges: EDGES, nodeId: 'w', agents: AGENTS, targetType: 'text' });
    expect(groups.map((group) => group.key)).toEqual(['steps', 'context', 'consultation', 'run']);
    const steps = groups[0]!;
    expect(steps.items.map((item) => item.raw)).not.toContain('nodes.later.outputs.text');
    expect(steps.items[0]).toMatchObject({ raw: 'nodes.asr1.outputs.transcript', path: 'Transcribe › transcript', bestMatch: true, scope: 'steps' });
    const segments = steps.items.find((item) => item.raw === 'nodes.asr1.outputs.segments');
    expect(segments?.convertNote).toBe('Formatted as text');
  });

  it('names the context schema and its version in the Context group', () => {
    const groups = pickerGroups({ nodes: NODES, edges: EDGES, nodeId: 'w', agents: AGENTS, contextSchema: CONTEXT_SCHEMA, contextSchemaName: 'Cardiology intake', contextSchemaVersion: 3 });
    expect(groups[1]?.subtitle).toBe('“Cardiology intake” v3');
    expect(groups[1]?.items.map((item) => item.raw)).toContain('context.encounter.reason');
  });

  it('blocks consultation and run fields inside a condition (CEL cannot read them this release)', () => {
    const groups = pickerGroups({ nodes: NODES, edges: EDGES, nodeId: 'w', agents: AGENTS, purpose: 'condition', settings: { connections: ['api'], sources: ['consultation'] } });
    expect(groups[2]?.items.every((item) => item.disabledReason !== undefined)).toBe(true);
    expect(groups[3]?.items.find((item) => item.raw === 'run.id')?.disabledReason).toMatch(/condition/i);
  });

  it('attaches samples from the last run and filters as you type, saying why a group is empty', () => {
    const samples = samplesFromRunOutputs({ asr1: { transcript: 'chest tightness since Tuesday', segments: [{}, {}] } });
    const groups = pickerGroups({ nodes: NODES, edges: EDGES, nodeId: 'w', agents: AGENTS, samples });
    expect(groups[0]?.items.find((item) => item.raw === 'nodes.asr1.outputs.transcript')?.sample).toBe('“chest tightness since Tuesday”');
    const filtered = filterPickerGroups(groups, 'outputs.transcr');
    expect(filtered[0]?.items.map((item) => item.raw)).toEqual(['nodes.asr1.outputs.transcript']);
    expect(filtered[1]?.items).toEqual([]);
    expect(filtered[1]?.emptyReason).toMatch(/outputs.transcr/);
  });

  it('formats samples compactly', () => {
    expect(formatSample('x'.repeat(80))).toHaveLength(62);
    expect(formatSample([1, 2, 3])).toBe('3 items');
    expect(formatSample({ a: 1, b: 2 })).toBe('{ a, b }');
    expect(formatSample(54)).toBe('54');
  });
});

describe('binding chips — shown by label, stored by id (OD-20)', () => {
  it('labels step paths by the step label and classifies scopes', () => {
    expect(pathLabel('nodes.asr1.outputs.transcript', NODES)).toBe('Transcribe › transcript');
    expect(scopeOfPath('consultation.patient.age')).toBe('consultation');
    expect(scopeOfPath('vars.days')).toBe('run');
    expect(describeBinding({ from: 'nodes.asr1.outputs.transcript' }, NODES)).toMatchObject({ kind: 'from', label: 'Transcribe › transcript', scope: 'steps', title: 'nodes.asr1.outputs.transcript' });
    expect(describeBinding({ value: 'en' }, NODES)).toMatchObject({ kind: 'value', label: '“en”', scope: 'value' });
    expect(describeBinding({ firstOf: ['nodes.asr1.outputs.transcript', 'context.encounter.reason'] }, NODES)?.label).toBe('First of: Transcribe › transcript, context.encounter.reason');
    expect(describeBinding({ template: 'Hi {{context.x}}' }, NODES)).toMatchObject({ kind: 'template', scope: 'template' });
  });
});

describe('inputRows — the Inputs panel (§8.4 item 5, §10.1)', () => {
  it('lists the task inputs then the prompt variables, with their binding and status', () => {
    const writer = node('w', 'core.agent', {
      agentRef: { slug: 'writer' },
      inputs: { message: { from: 'nodes.asr1.outputs.transcript' } },
      overrides: { promptVariables: { patient_age: '{{consultation.patient.age}}', tone: 'friendly' } },
    });
    const rows = inputRows({
      node: writer,
      nodes: [...NODES.filter((candidate) => candidate.id !== 'w'), writer],
      edges: EDGES,
      agents: AGENTS,
      promptVariables: [
        { name: 'patient_age', required: true, type: 'number' },
        { name: 'tone', required: false },
        { name: 'history', required: true },
      ],
    });
    expect(rows.map((row) => [row.name, row.origin, row.status])).toEqual([
      ['message', 'io', 'bound'],
      ['context', 'io', 'empty'],
      ['patient_age', 'prompt', 'bound'],
      ['tone', 'prompt', 'bound'],
      ['history', 'prompt', 'missing'],
    ]);
    expect(rows[2]?.binding).toEqual({ from: 'consultation.patient.age' });
    expect(rows[3]?.binding).toEqual({ value: 'friendly' });
  });

  it('marks a required input fed only by a legacy data edge as bound (implied)', () => {
    const asr = node('asr1', 'core.agent', { agentRef: { slug: 'asr' } });
    const tts = node('s', 'core.agent', { agentRef: { slug: 'tts' } });
    const writer = node('w', 'core.agent', { agentRef: { slug: 'writer' } });
    const rows = inputRows({ node: tts, nodes: [asr, writer, tts], edges: [{ id: 'e', source: 'w', sourceHandle: 'out', target: 's', targetHandle: 'in' }], agents: AGENTS, promptVariables: [] });
    expect(rows[0]).toMatchObject({ name: 'text', status: 'bound', implied: true, binding: { from: 'nodes.w.outputs.text' } });
  });

  it('round-trips prompt-variable text and bindings', () => {
    expect(promptVariableBinding('{{ nodes.a.outputs.text }}')).toEqual({ from: 'nodes.a.outputs.text' });
    expect(promptVariableBinding('Summary: {{nodes.a.outputs.text}}')).toEqual({ template: 'Summary: {{nodes.a.outputs.text}}' });
    expect(promptVariableBinding('')).toBeNull();
    expect(promptVariableText({ from: 'context.x' })).toBe('{{context.x}}');
    expect(promptVariableText({ value: 3 })).toBe('3');
    expect(promptVariableText({ template: 'a {{b}}' })).toBe('a {{b}}');
  });
});

describe('condition builder — CEL without code (§8.4 item 6)', () => {
  it('generates CEL from rules and reads it back', () => {
    const model = {
      join: 'all' as const,
      rules: [
        { field: 'nodes.c.outputs.classification.score', operator: 'gt' as const, value: '0.8' },
        { field: 'trigger.encounter.reason', operator: 'contains' as const, value: 'chest "pain"' },
        { field: 'vars.flag', operator: 'isSet' as const, value: '' },
      ],
    };
    const cel = conditionToCel(model);
    expect(cel).toBe('nodes.c.outputs.classification.score > 0.8 && trigger.encounter.reason.contains("chest \\"pain\\"") && has(vars.flag)');
    expect(celToCondition(cel)).toEqual(model);
  });

  it('reads `||` chains and string/boolean equality; refuses what it cannot represent', () => {
    expect(celToCondition('vars.kind == "urgent" || vars.done == true')).toEqual({
      join: 'any',
      rules: [
        { field: 'vars.kind', operator: 'eq', value: 'urgent' },
        { field: 'vars.done', operator: 'eq', value: 'true' },
      ],
    });
    expect(celToCondition('!has(vars.x)')).toEqual({ join: 'all', rules: [{ field: 'vars.x', operator: 'isNotSet', value: '' }] });
    expect(celToCondition('size(vars.list) > 2')).toBeNull();
    expect(celToCondition('a && b || c')).toBeNull();
    expect(celToCondition('')).toEqual({ join: 'all', rules: [] });
  });

  it('maps a context path onto the CEL trigger root', () => {
    expect(celPathOf('context.encounter.reason')).toBe('trigger.encounter.reason');
    expect(celPathOf('nodes.a.outputs.text')).toBe('nodes.a.outputs.text');
  });
});

describe('Merge preset (OD-18)', () => {
  it('is a core.data step that passes its one (firstOf-bound) input through', () => {
    expect(PALETTE_PRESETS).toContain(MERGE_PRESET);
    expect(MERGE_PRESET.type).toBe('core.data');
    expect(MERGE_PRESET.config).toMatchObject({ label: 'Merge', mappings: [{ from: 'in', to: 'value' }, { from: 'in', to: 'text' }] });
  });
});

describe('settings model — live implications (§3.5)', () => {
  const asrGraph = [node('t', 'core.trigger'), node('a', 'core.agent', { agentRef: { slug: 'asr' } }), node('o', 'core.output')];

  it('derives a draft from legacy trigger/output config when the graph has no settings', () => {
    const legacy = [node('t', 'core.trigger', { kinds: ['api', 'consultation'] }), node('o', 'core.output', { protocols: ['http-sse'] })];
    expect(settingsDraftOf(legacy, undefined)).toEqual({ connections: ['api', 'sse'], sources: ['consultation'] });
  });

  it('locks implied connections with the reason, and adds them on apply', () => {
    const draft = { connections: ['sse' as const], sources: [] as never[] };
    const options = connectionOptions(draft, asrGraph, { agents: AGENTS });
    const api = options.find((option) => option.value === 'api');
    const socket = options.find((option) => option.value === 'socket');
    expect(api).toMatchObject({ checked: true, locked: true });
    expect(api?.lockReason).toMatch(/SSE/);
    expect(socket).toMatchObject({ checked: true, locked: true });
    expect(socket?.lockReason).toMatch(/transcribes speech/);
    expect(withImpliedConnections(draft, asrGraph, { agents: AGENTS }).connections).toEqual(['api', 'sse', 'socket']);
  });

  it('exempts consultation-sourced ASR from the socket rule (Q6)', () => {
    const options = connectionOptions({ connections: ['api'], sources: ['consultation'] }, asrGraph, { agents: AGENTS });
    expect(options.find((option) => option.value === 'socket')).toMatchObject({ checked: false, locked: false });
  });

  it('writes a contract-valid settings object', () => {
    expect(toWorkflowSettings({ connections: ['sse', 'api'], sources: ['consultation'], contextSchema: { contextSchemaId: 'cs1', versionNumber: null } })).toEqual({
      connections: ['api', 'sse'],
      sources: ['consultation'],
      contextSchema: { contextSchemaId: 'cs1', versionNumber: null },
    });
  });
});

describe('W2 — generation fields', () => {
  it('offers temperature and max output tokens only when the model supports them', () => {
    const caps = { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens', 'topP'] };
    expect(generationFields('TEXT_GENERATION', caps).map((field) => field.key)).toEqual(['temperature', 'maxTokens']);
    expect(generationFields('TEXT_GENERATION', { ...caps, reasoning: true }).map((field) => field.key)).toEqual(['maxTokens']);
    expect(generationFields('TEXT_GENERATION', null)).toEqual([]);
    expect(generationFields('SPEECH_TO_TEXT', caps)).toEqual([]);
  });

  it('reads capabilities off a catalogue row defensively', () => {
    expect(modelCapabilitiesOf({ capabilities: { supportedGenerationParams: ['temperature'] } })).toMatchObject({ supportedGenerationParams: ['temperature'], voices: [] });
    expect(modelCapabilitiesOf({})).toBeNull();
    expect(modelCapabilitiesOf(null)).toBeNull();
  });
});
