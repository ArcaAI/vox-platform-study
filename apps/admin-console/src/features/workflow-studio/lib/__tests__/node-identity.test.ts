/**
 * TASK-890 black-box J4-F3 — a node's DISPLAY IDENTITY.
 *
 * Every surface named a node by its TYPE alone (`humanizeKey(node.type)`), so a graph with three
 * `core.agent` nodes offered three identical "Core.agent" rows, three identical canvas headers
 * and three indistinguishable "Connect to…" options. Identity is: the authored label when there
 * is one, else the humanized type plus a short, stable slice of the node id.
 */
import { describe, expect, it } from 'vitest';
import { nodeDisplayName, shortNodeId } from '../node-identity';

describe('shortNodeId', () => {
  it('drops the generator prefix and keeps a short, stable tail', () => {
    expect(shortNodeId('node_mtqb1kr9_7')).toBe('1kr9_7');
    expect(shortNodeId('a')).toBe('a');
    expect(shortNodeId('node_ab12')).toBe('ab12');
  });
});

describe('nodeDisplayName', () => {
  it('prefers an authored label, then an authored name', () => {
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.agent', config: { label: 'Key points' } })).toBe('Key points');
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.agent', config: { name: 'Reviewer' } })).toBe('Reviewer');
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.agent', config: { label: 'Key points', name: 'Reviewer' } })).toBe('Key points');
  });

  it('falls back to the humanized type plus the short id, so siblings are distinguishable', () => {
    const a = nodeDisplayName({ id: 'node_mtqb1kr9_7', type: 'core.agent', config: {} });
    const b = nodeDisplayName({ id: 'node_mtqb1kr9_8', type: 'core.agent', config: {} });

    expect(a).toBe('Core.agent · 1kr9_7');
    expect(a).not.toBe(b);
  });

  it('ignores a blank or non-string label rather than rendering an empty name', () => {
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.agent', config: { label: '   ' } })).toBe('Core.agent · node_x1'.replace('node_', ''));
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.agent', config: { label: 42 } })).toBe('Core.agent · x1');
    expect(nodeDisplayName({ id: 'node_x1', type: 'core.agent' })).toBe('Core.agent · x1');
  });
});

// TASK-965 — an authored, digit-free id is a name and is shown whole; the seed's `n_trigger`
// rendered as "rigger" on the canvas, which read as a typo.
describe('shortNodeId — authored ids (TASK-965)', () => {
  it('keeps a digit-free authored id whole up to 24 characters', () => {
    expect(shortNodeId('n_trigger')).toBe('n_trigger');
    expect(shortNodeId('n_summary')).toBe('n_summary');
    expect(shortNodeId('general_medicine_summary')).toBe('general_medicine_summary');
  });

  it('still slices a generated id and a uuid to their stable tail', () => {
    expect(shortNodeId('node_mtqb1kr9_7')).toBe('1kr9_7');
    expect(shortNodeId('01a09985-5191-70ea-b54d-fca9bc8fbc67')).toBe('8fbc67');
  });
});
