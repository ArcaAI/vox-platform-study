import { describe, expect, it } from 'vitest';
import { exportGraphJson, parseGraphJson } from '../graph-io';
import { fromWorkflowGraph } from '../graph-serialization';

const nodes = [
  { id: 'n_trigger', type: 'core.trigger', position: { x: 0, y: 0 }, safetyClasses: ['mandatory'], config: { kinds: ['api'] } },
  { id: 'n_loop', type: 'core.loop', position: { x: 300, y: 0 }, safetyClasses: [], config: { mode: 'foreach' } },
  { id: 'n_body', type: 'core.agent', position: { x: 24, y: 56 }, safetyClasses: [], config: {}, parentId: 'n_loop' },
];
const edges = [{ id: 'e1', source: 'n_trigger', sourceHandle: 'next', target: 'n_loop', targetHandle: 'after' }];

describe('graph JSON import/export', () => {
  it('round-trips the editor buffer, parentId included', () => {
    const text = exportGraphJson(nodes, edges);
    const parsed = parseGraphJson(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const back = fromWorkflowGraph(parsed.graph);
    expect(back.nodes.map((n) => [n.id, n.parentId])).toEqual([
      ['n_trigger', undefined],
      ['n_loop', undefined],
      ['n_body', 'n_loop'],
    ]);
    expect(back.edges).toEqual(edges);
  });

  it.each([
    ['not json', 'Not valid JSON.'],
    ['[]', 'The document must be a JSON object.'],
    ['{"version":2,"nodes":[],"edges":[]}', 'Unsupported graph version — expected "version": 1.'],
    ['{"version":1,"nodes":[{"id":"a","type":"x"},{"id":"a","type":"y"}],"edges":[]}', 'Duplicate node id "a".'],
    ['{"version":1,"nodes":[{"id":"a","type":"x"}],"edges":[{"id":"e","from":"a","fromPort":"out","to":"zzz","toPort":"in"}]}', 'edges[0].to names an unknown node "zzz".'],
    ['{"version":1,"nodes":[{"id":"a","type":"x","parentId":"nope"}],"edges":[]}', 'Node "a" names an unknown parent "nope".'],
  ])('refuses a malformed document with a reason: %s', (text, reason) => {
    expect(parseGraphJson(text)).toEqual({ ok: false, reason });
  });
});
