/**
 * TASK-1036 review R-C #7 — "Hide PHI" in the Composer.
 *
 * One studio-level switch (the graph store's `hidePhi`) masks every value the Composer shows from
 * a test run whose field is PHI-classed: the picker's samples (and so the `{{` completion's), and
 * the Last run tab's inputs and outputs. A NON_PHI value (an id, a language code) stays visible.
 */
import { describe, expect, it } from 'vitest';
import type { AgentIOResolver } from '@arcaai/workflow-contract';
import { createGraphStore } from '../../store';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { PHI_MASK, lastRunPhiFields } from '../phi-mask';
import { pickerGroups } from '../picker-model';

const AGENTS: AgentIOResolver = { asr: { task: 'SPEECH_TO_TEXT' }, writer: { task: 'TEXT_GENERATION' } };

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}
const START = node('t', 'core.trigger', { label: 'Start' });
const ASR = node('asr1', 'core.agent', { agentRef: { slug: 'asr' }, label: 'Transcribe' });
const EDGES: GraphStoreEdge[] = [
  { id: 'e1', source: 't', sourceHandle: 'next', target: 'asr1', targetHandle: 'after' },
  { id: 'e2', source: 'asr1', sourceHandle: 'next', target: 'w', targetHandle: 'after' },
];

describe('picker samples under Hide PHI', () => {
  const writer = node('w', 'core.agent', { agentRef: { slug: 'writer' } });
  const samples = { 'nodes.asr1.outputs.transcript': 'Patient reports chest pain', 'nodes.asr1.outputs.language': 'en' };
  const itemOf = (hidePhi: boolean, raw: string) =>
    pickerGroups({ nodes: [START, ASR, writer], edges: EDGES, nodeId: 'w', agents: AGENTS, samples, hidePhi })
      .flatMap((group) => group.items)
      .find((item) => item.raw === raw);

  it('shows PHI samples when the switch is off', () => {
    expect(itemOf(false, 'nodes.asr1.outputs.transcript')?.sample).toContain('chest pain');
  });

  it('masks a PHI sample when it is on, and leaves a NON_PHI one alone', () => {
    expect(itemOf(true, 'nodes.asr1.outputs.transcript')?.sample).toBe(PHI_MASK);
    expect(itemOf(true, 'nodes.asr1.outputs.language')?.sample).toBe('“en”');
  });
});

describe('lastRunPhiFields', () => {
  it('names the PHI outputs of the step, by its own I/O contract', () => {
    const fields = lastRunPhiFields({ node: ASR, nodes: [START, ASR], edges: EDGES.slice(0, 1), agents: AGENTS });
    expect(fields.outputs.has('transcript')).toBe(true);
    expect(fields.outputs.has('language')).toBe(false);
  });

  it('names an input PHI when its binding reads a PHI field — directly, as a fallback or inside text', () => {
    const writer = node('w', 'core.agent', {
      agentRef: { slug: 'writer' },
      inputs: { message: { from: 'nodes.asr1.outputs.transcript' }, context: { value: 'fixed' } },
      overrides: { promptVariables: { lang: '{{nodes.asr1.outputs.language}}', summary: 'Heard: {{nodes.asr1.outputs.transcript}}' } },
    });
    const fields = lastRunPhiFields({ node: writer, nodes: [START, ASR, writer], edges: EDGES, agents: AGENTS });
    expect(fields.inputs.has('message')).toBe(true);
    expect(fields.inputs.has('summary')).toBe(true);
    expect(fields.inputs.has('context')).toBe(false);
    expect(fields.inputs.has('lang')).toBe(false);
  });
});

describe('the store’s Hide PHI switch', () => {
  it('starts off, toggles, and never dirties the graph or enters undo', () => {
    const store = createGraphStore();
    expect(store.getState().hidePhi).toBe(false);
    store.getState().setHidePhi(true);
    expect(store.getState().hidePhi).toBe(true);
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().undoStack).toHaveLength(0);
  });
});
