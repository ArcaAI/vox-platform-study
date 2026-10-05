/**
 * TASK-1036 (owner, 2026-10-05) — a REFERENCE to a step reads by the step's friendly name too: a
 * binding chip ("Realtime transcription › transcript") and the binding picker's Earlier steps
 * ("Start › …"), never the raw id the contract falls back to (`n_trigger › context`). The stored
 * path is unchanged.
 */
import { describe, expect, it } from 'vitest';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { describeBinding } from '../binding-display';
import { agentNamesOf } from '../node-identity';
import { pickerGroups } from '../picker-model';

function node(id: string, type: string, config: Record<string, unknown> = {}): GraphStoreNode {
  return { id, type, position: { x: 0, y: 0 }, safetyClasses: [], config };
}
const NAMING = agentNamesOf([{ slug: 'whisper-ml-en-realtime', name: 'Realtime transcription (whisper.cpp ML/EN)' }]);

describe('friendly step references', () => {
  it('a binding chip names the producing step, keeping the stored path as its title', () => {
    const nodes = [node('n_asr', 'core.agent', { agentRef: { slug: 'whisper-ml-en-realtime' } })];
    const chip = describeBinding({ from: 'nodes.n_asr.outputs.transcript' }, nodes, NAMING);
    expect(chip?.label).toBe('Realtime transcription (whisper.cpp ML/EN) › transcript');
    expect(chip?.title).toBe('nodes.n_asr.outputs.transcript');
  });

  it('the binding picker lists an earlier step by its friendly name, never its id', () => {
    const nodes = [node('n_trigger', 'core.trigger'), node('n_map', 'core.data')];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'n_trigger', sourceHandle: 'next', target: 'n_map', targetHandle: 'after' } as GraphStoreEdge];
    const steps = pickerGroups({ nodes, edges, nodeId: 'n_map', agents: {}, naming: NAMING }).find((group) => group.key === 'steps');
    expect(steps?.items.length).toBeGreaterThan(0);
    for (const item of steps?.items ?? []) {
      expect(item.path.startsWith('Start › ')).toBe(true);
      expect(item.path).not.toContain('n_trigger');
      expect(item.raw.startsWith('nodes.n_trigger.')).toBe(true);
    }
  });
});
