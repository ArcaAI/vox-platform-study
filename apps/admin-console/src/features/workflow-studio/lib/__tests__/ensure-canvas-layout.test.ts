import { describe, expect, it } from 'vitest';
import { layoutClusteredGraph, positionsAreClustered } from '../ensure-canvas-layout';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';

function node(id: string, position: { x: number; y: number }, type = 'core.agent'): GraphStoreNode {
  return { id, type, position, safetyClasses: [], config: {} };
}

describe('positionsAreClustered', () => {
  it('is false for fewer than two nodes', () => {
    expect(positionsAreClustered([])).toBe(false);
    expect(positionsAreClustered([node('a', { x: 0, y: 0 })])).toBe(false);
  });

  it('is true when every node shares the same coordinates', () => {
    expect(positionsAreClustered([node('a', { x: 0, y: 0 }), node('b', { x: 0, y: 0 }), node('c', { x: 0, y: 0 })])).toBe(true);
  });

  it('is false when any node has a distinct position', () => {
    expect(positionsAreClustered([node('a', { x: 0, y: 0 }), node('b', { x: 240, y: 0 })])).toBe(false);
  });
});

describe('layoutClusteredGraph', () => {
  it('returns null when positions are already distinct', async () => {
    const nodes = [node('a', { x: 0, y: 0 }), node('b', { x: 240, y: 0 })];
    await expect(layoutClusteredGraph(nodes, [])).resolves.toBeNull();
  });

  it('spreads a piled origin graph so nodes no longer share a point', async () => {
    const nodes = [node('n_trigger', { x: 0, y: 0 }, 'core.trigger'), node('n_agent', { x: 0, y: 0 }), node('n_output', { x: 0, y: 0 }, 'core.output')];
    const edges: GraphStoreEdge[] = [
      { id: 'e1', source: 'n_trigger', sourceHandle: 'out', target: 'n_agent', targetHandle: 'in' },
      { id: 'e2', source: 'n_agent', sourceHandle: 'out', target: 'n_output', targetHandle: 'in' },
    ];
    const positions = await layoutClusteredGraph(nodes, edges);
    expect(positions).not.toBeNull();
    expect(positions!.n_trigger).toBeDefined();
    expect(positions!.n_agent).toBeDefined();
    expect(positions!.n_output).toBeDefined();
    expect(new Set(Object.values(positions!).map((p) => `${p.x},${p.y}`)).size).toBe(3);
    expect(positions!.n_trigger.x).toBeLessThan(positions!.n_agent.x);
    expect(positions!.n_agent.x).toBeLessThan(positions!.n_output.x);
  });
});
