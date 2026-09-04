import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT_OPTIONS, layoutWorkflowGraph, type LayoutEngine } from '../layout';

const nodes = [
  { id: 'trigger' },
  { id: 'agent' },
  { id: 'cond' },
  { id: 'loop', kind: 'group' as const },
  { id: 'body_a', parentId: 'loop' },
  { id: 'body_b', parentId: 'loop' },
  { id: 'output' },
];
const edges = [
  { source: 'trigger', target: 'agent' },
  { source: 'agent', target: 'cond' },
  { source: 'cond', target: 'loop' },
  { source: 'loop', target: 'output' },
  { source: 'body_a', target: 'body_b' },
  { source: 'output', target: 'trigger' }, // a back edge must not blow the layering up
];

describe('layoutWorkflowGraph (built-in layered engine)', () => {
  it('places every node, layer by layer, left to right', async () => {
    const result = await layoutWorkflowGraph(nodes, edges);
    expect(result.engine).toBe('layered');
    expect(Object.keys(result.positions).sort()).toEqual(nodes.map((n) => n.id).sort());
    const x = (id: string) => result.positions[id].x;
    expect(x('trigger')).toBeLessThan(x('agent'));
    expect(x('agent')).toBeLessThan(x('cond'));
    expect(x('cond')).toBeLessThan(x('loop'));
    expect(x('loop')).toBeLessThan(x('output'));
  });

  it('lays a group`s children out in the group`s own coordinate space and sizes the group around them', async () => {
    const result = await layoutWorkflowGraph(nodes, edges);
    const { groupPaddingX, groupPaddingTop, nodeWidth, gapX } = DEFAULT_LAYOUT_OPTIONS;
    expect(result.positions.body_a).toEqual({ x: groupPaddingX, y: groupPaddingTop });
    expect(result.positions.body_b.x).toBe(groupPaddingX + nodeWidth + gapX);
    expect(result.sizes.loop.width).toBe(groupPaddingX * 2 + nodeWidth * 2 + gapX);
    expect(result.sizes.loop.height).toBeGreaterThan(DEFAULT_LAYOUT_OPTIONS.nodeHeight);
  });

  it('is deterministic', async () => {
    const [a, b] = await Promise.all([layoutWorkflowGraph(nodes, edges), layoutWorkflowGraph(nodes, edges)]);
    expect(a).toEqual(b);
  });

  it('separates the nodes of one layer vertically by nodeHeight + gapY', async () => {
    const fan = [{ id: 's' }, { id: 'a' }, { id: 'b' }];
    const result = await layoutWorkflowGraph(fan, [
      { source: 's', target: 'a' },
      { source: 's', target: 'b' },
    ]);
    expect(result.positions.a.x).toBe(result.positions.b.x);
    expect(result.positions.b.y - result.positions.a.y).toBe(DEFAULT_LAYOUT_OPTIONS.nodeHeight + DEFAULT_LAYOUT_OPTIONS.gapY);
  });
});

describe('layoutWorkflowGraph (injected ELK-shaped engine)', () => {
  it('uses the engine`s coordinates when it answers for every node', async () => {
    const engine: LayoutEngine = {
      layout: async (graph) => ({
        ...graph,
        children: (graph.children ?? []).map((child, index) => ({ ...child, x: index * 300, y: 7, children: (child.children ?? []).map((grand, j) => ({ ...grand, x: j * 10, y: 1 })) })),
      }),
    };
    const result = await layoutWorkflowGraph(nodes, edges, { engine });
    expect(result.engine).toBe('elk');
    expect(result.positions.trigger).toEqual({ x: 0, y: 7 });
    expect(result.positions.body_b).toEqual({ x: 10, y: 1 });
  });

  it('falls back to the built-in engine when the injected one throws or answers partially', async () => {
    const throwing: LayoutEngine = { layout: async () => { throw new Error('elk is not installed'); } };
    const partial: LayoutEngine = { layout: async (graph) => ({ ...graph, children: [] }) };
    expect((await layoutWorkflowGraph(nodes, edges, { engine: throwing })).engine).toBe('layered');
    expect((await layoutWorkflowGraph(nodes, edges, { engine: partial })).engine).toBe('layered');
  });
});
