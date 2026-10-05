/**
 * A node's DISPLAY IDENTITY — what every Studio surface calls a step.
 *
 * TASK-890 J4-F3: a graph with three `core.agent` nodes showed three identical names, so naming
 * must tell siblings apart. TASK-1036 (owner, 2026-10-05): it must also be HUMAN — the old
 * fallback, the humanized type plus an id slice ("Core.trigger · n_trigger", "Core.agent · n_asr"),
 * read as debug output. Identity is now, in order:
 *   1. the authored label (`config.label`, then `config.name`);
 *   2. for an agent step, the agent's display NAME from the catalogue, else its slug humanized;
 *   3. for an action step, the action's catalogue label;
 *   4. otherwise a friendly per-type title ("Start", "Output", "Map fields", …).
 * Two steps that would share a name are told apart with " 2", " 3" in canvas (array) order — never
 * with the raw id, which stays the stored reference.
 */
import { describe, expect, it } from 'vitest';
import { CORE_NODE_TYPES } from '@arcaai/workflow-contract';
import { agentNamesOf, nodeDisplayName, nodeDisplayNames, nodeTypeTitle, shortNodeId } from '../node-identity';

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config });
const NAMING = agentNamesOf([
  { slug: 'whisper-ml-en-realtime', name: 'Realtime transcription (whisper.cpp ML/EN)' },
  { slug: 'case-notes-pre-summary', name: 'Case notes pre-summary' },
]);

describe('nodeTypeTitle — a friendly title per node type', () => {
  it('names the core vocabulary in words', () => {
    expect(nodeTypeTitle('core.trigger')).toBe('Start');
    expect(nodeTypeTitle('core.output')).toBe('Output');
    expect(nodeTypeTitle('core.data')).toBe('Map fields');
    expect(nodeTypeTitle('core.condition')).toBe('Condition');
    expect(nodeTypeTitle('core.loop')).toBe('Loop');
    expect(nodeTypeTitle('core.action')).toBe('Action');
    expect(nodeTypeTitle('core.agent')).toBe('Agent');
    expect(nodeTypeTitle('core.humanReview')).toBe('Review');
  });

  it('has a title for EVERY core type the registry declares — no raw "Core.x" can reach a card', () => {
    for (const type of CORE_NODE_TYPES) {
      const title = nodeTypeTitle(type);
      expect(title, type).not.toMatch(/core|\./i);
      expect(title.length, type).toBeGreaterThan(0);
    }
  });

  it('an unknown type still reads as words, without its namespace', () => {
    expect(nodeTypeTitle('vendor.sendLetter')).toBe('Send letter');
  });
});

describe('nodeDisplayName', () => {
  it('prefers an authored label, then an authored name', () => {
    expect(nodeDisplayName(node('node_x1', 'core.agent', { label: 'Key points' }))).toBe('Key points');
    expect(nodeDisplayName(node('node_x1', 'core.agent', { name: 'Reviewer' }))).toBe('Reviewer');
    expect(nodeDisplayName(node('node_x1', 'core.agent', { label: 'Key points', name: 'Reviewer' }))).toBe('Key points');
  });

  it('names the seed graph’s steps in words, never "Core.trigger · n_trigger"', () => {
    expect(nodeDisplayName(node('n_trigger', 'core.trigger'))).toBe('Start');
    expect(nodeDisplayName(node('n_output', 'core.output'))).toBe('Output');
    expect(nodeDisplayName(node('n_map', 'core.data'))).toBe('Map fields');
  });

  it('an agent step takes the agent’s display name from the catalogue', () => {
    expect(nodeDisplayName(node('n_asr', 'core.agent', { agentRef: { slug: 'whisper-ml-en-realtime' } }), undefined, NAMING)).toBe(
      'Realtime transcription (whisper.cpp ML/EN)',
    );
  });

  it('an agent the catalogue does not (yet) know reads as its slug in words; none chosen reads "Agent"', () => {
    expect(nodeDisplayName(node('n_asr', 'core.agent', { agentRef: { slug: 'realtime-transcription' } }))).toBe('Realtime transcription');
    expect(nodeDisplayName(node('n_x', 'core.agent'))).toBe('Agent');
  });

  it('an action step takes the action’s catalogue label', () => {
    expect(nodeDisplayName(node('n_c', 'core.action', { actionKey: 'consultation.consentGate' }))).toBe('Consent gate');
    expect(nodeDisplayName(node('n_c', 'core.action'))).toBe('Action');
  });

  it('ignores a blank or non-string label rather than rendering an empty name', () => {
    expect(nodeDisplayName(node('node_x1', 'core.data', { label: '   ' }))).toBe('Map fields');
    expect(nodeDisplayName(node('node_x1', 'core.data', { label: 42 }))).toBe('Map fields');
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.data' })).toBe('Map fields');
  });

  it('never prints the node id', () => {
    for (const type of CORE_NODE_TYPES) expect(nodeDisplayName(node('n_raw_identifier', type))).not.toContain('n_raw_identifier');
  });

  it('given the graph, tells a duplicate apart by its canvas position', () => {
    const graph = [node('a', 'core.data'), node('b', 'core.agent'), node('c', 'core.data')];
    expect(nodeDisplayName(graph[0]!, graph)).toBe('Map fields');
    expect(nodeDisplayName(graph[2]!, graph)).toBe('Map fields 2');
  });
});

describe('nodeDisplayNames — one name per node, unique within the graph', () => {
  it('numbers repeats " 2", " 3" in canvas order and leaves unique names alone', () => {
    const graph = [
      node('n_trigger', 'core.trigger'),
      node('a1', 'core.agent'),
      node('n_asr', 'core.agent', { agentRef: { slug: 'whisper-ml-en-realtime' } }),
      node('a2', 'core.agent'),
      node('a3', 'core.agent'),
      node('n_output', 'core.output'),
    ];
    const names = nodeDisplayNames(graph, NAMING);
    expect([...names.values()]).toEqual(['Start', 'Agent', 'Realtime transcription (whisper.cpp ML/EN)', 'Agent 2', 'Agent 3', 'Output']);
  });

  it('never hands out a number that is already somebody’s name', () => {
    const graph = [node('a', 'core.data'), node('b', 'core.data', { label: 'Map fields 2' }), node('c', 'core.data')];
    const names = nodeDisplayNames(graph);
    expect(new Set(names.values()).size).toBe(3);
    expect(names.get('c')).toBe('Map fields 3');
  });
});

// TASK-965 — `shortNodeId` stays for the inspector's muted ID detail and diagnostics.
describe('shortNodeId', () => {
  it('drops the generator prefix and keeps a short, stable tail', () => {
    expect(shortNodeId('node_mtqb1kr9_7')).toBe('1kr9_7');
    expect(shortNodeId('a')).toBe('a');
    expect(shortNodeId('node_ab12')).toBe('ab12');
  });

  it('keeps a digit-free authored id whole up to 24 characters', () => {
    expect(shortNodeId('n_trigger')).toBe('n_trigger');
    expect(shortNodeId('general_medicine_summary')).toBe('general_medicine_summary');
  });

  it('still slices a generated id and a uuid to their stable tail', () => {
    expect(shortNodeId('01a09985-5191-70ea-b54d-fca9bc8fbc67')).toBe('8fbc67');
  });
});
