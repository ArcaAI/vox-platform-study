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
