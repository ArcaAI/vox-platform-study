import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { allPathsPassThrough, pathExists, reachableFrom, reachesAny, topologicalLevels } from '../graph-algorithms';

function graph(nodeIds: string[], edges: Array<[string, string]>): WorkflowGraph {
  return {
    version: 1,
    nodes: nodeIds.map((id) => ({ id, type: 'x', config: {} })),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, fromPort: 'out', to, toPort: 'in' })),
  };
}

describe('topologicalLevels', () => {
  it('layers a linear chain one node per level', () => {
    const g = graph(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    const result = topologicalLevels(g);
    expect('levels' in result).toBe(true);
    expect((result as { levels: string[][] }).levels).toEqual([['a'], ['b'], ['c']]);
  });

  it('puts independent nodes in the same level', () => {
    const g = graph(
      ['start', 'a', 'b', 'end'],
      [
        ['start', 'a'],
        ['start', 'b'],
        ['a', 'end'],
        ['b', 'end'],
      ],
    );
    const result = topologicalLevels(g) as { levels: string[][] };
    expect(result.levels[0]).toEqual(['start']);
    expect(result.levels[1]).toEqual(['a', 'b']);
    expect(result.levels[2]).toEqual(['end']);
  });

  it('detects a simple cycle', () => {
    const g = graph(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['b', 'a'],
      ],
    );
    const result = topologicalLevels(g);
    expect('cycle' in result).toBe(true);
    expect((result as { cycle: string[] }).cycle.sort()).toEqual(['a', 'b']);
  });

  it('detects a self-loop', () => {
    const g = graph(['a'], [['a', 'a']]);
    const result = topologicalLevels(g);
    expect('cycle' in result).toBe(true);
  });

  it('is total on an empty graph', () => {
    const result = topologicalLevels(graph([], []));
    expect(result).toEqual({ levels: [] });
  });

  it('ignores dangling edge endpoints rather than throwing', () => {
    const g: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'a', type: 'x', config: {} }],
      edges: [{ id: 'e0', from: 'a', fromPort: 'out', to: 'missing', toPort: 'in' }],
    };
    expect(() => topologicalLevels(g)).not.toThrow();
  });
});

describe('reachableFrom', () => {
  it('includes the start node and everything downstream', () => {
    const g = graph(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    expect(reachableFrom(g, 'a')).toEqual(new Set(['a', 'b', 'c']));
  });

  it('is just the node itself with no outgoing edges', () => {
    const g = graph(['a'], []);
    expect(reachableFrom(g, 'a')).toEqual(new Set(['a']));
  });
});

describe('reachesAny', () => {
  it('finds every node that can reach one of the targets', () => {
    const g = graph(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'c'],
        ['b', 'c'],
        ['c', 'd'],
      ],
    );
    expect(reachesAny(g, ['d'])).toEqual(new Set(['a', 'b', 'c', 'd']));
  });
});

describe('pathExists', () => {
  it('finds a path across intermediate nodes', () => {
    const g = graph(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    expect(pathExists(g, ['a'], ['c'])).toBe(true);
  });

  it('reports false when unreachable', () => {
    const g = graph(['a', 'b'], []);
    expect(pathExists(g, ['a'], ['b'])).toBe(false);
  });

  it('honours the avoiding set', () => {
    const g = graph(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    );
    expect(pathExists(g, ['a'], ['c'], { avoiding: ['b'] })).toBe(false);
  });

  it('finds an alternate route around an avoided node', () => {
    const g = graph(
      ['a', 'b', 'c', 'd'],
      [
        ['a', 'b'],
        ['b', 'd'],
        ['a', 'c'],
        ['c', 'd'],
      ],
    );
    expect(pathExists(g, ['a'], ['d'], { avoiding: ['b'] })).toBe(true);
  });
});

describe('allPathsPassThrough — dominator check, not path enumeration', () => {
  it('is true when the only route is gated', () => {
    const g = graph(
      ['start', 'gate', 'end'],
      [
        ['start', 'gate'],
        ['gate', 'end'],
      ],
    );
    expect(allPathsPassThrough(g, ['start'], ['end'], ['gate'])).toBe(true);
  });

  it('is false when a bypass route exists', () => {
    const g = graph(
      ['start', 'gate', 'end'],
      [
        ['start', 'gate'],
        ['gate', 'end'],
        ['start', 'end'],
      ],
    );
    expect(allPathsPassThrough(g, ['start'], ['end'], ['gate'])).toBe(false);
  });

  it('is vacuously true when no path exists at all', () => {
    const g = graph(['start', 'gate', 'end'], []);
    expect(allPathsPassThrough(g, ['start'], ['end'], ['gate'])).toBe(true);
  });

  it('handles a wide fan without enumerating paths (perf bound)', () => {
    // A 200-node "diamond of diamonds" — path enumeration would be exponential;
    // the dominator check must resolve near-instantly.
    const nodeIds = ['start', 'gate', 'end'];
    const edges: Array<[string, string]> = [];
    for (let i = 0; i < 100; i += 1) {
      const mid = `mid_${i}`;
      nodeIds.push(mid);
      edges.push(['start', mid], [mid, 'gate']);
    }
    edges.push(['gate', 'end']);
    const g = graph(nodeIds, edges);
    const startedAt = Date.now();
    expect(allPathsPassThrough(g, ['start'], ['end'], ['gate'])).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
