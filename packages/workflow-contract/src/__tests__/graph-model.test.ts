import { describe, expect, it } from 'vitest';
import { MAX_GRAPH_EDGES, MAX_GRAPH_NODES, WORKFLOW_NODE_ID_PATTERN, workflowGraphProblems } from '../graph-model';

const validGraph = {
  version: 1,
  nodes: [
    { id: 'n_start', type: 'core.start', config: {} },
    { id: 'n_end', type: 'core.end', config: {} },
  ],
  edges: [{ id: 'e1', from: 'n_start', fromPort: 'out', to: 'n_end', toPort: 'in' }],
};

describe('workflowGraphProblems', () => {
  it('accepts a well-formed graph', () => {
    expect(workflowGraphProblems(validGraph)).toEqual([]);
  });

  it('rejects a non-object', () => {
    expect(workflowGraphProblems(null)).toEqual(['/: graph must be a JSON object']);
    expect(workflowGraphProblems('nope').length).toBeGreaterThan(0);
  });

  it('rejects an unknown version', () => {
    const problems = workflowGraphProblems({ ...validGraph, version: 2 });
    expect(problems.some((p) => p.includes('version'))).toBe(true);
  });

  it('rejects a node id that does not match the id grammar', () => {
    const graph = { ...validGraph, nodes: [{ id: 'N-bad!', type: 'core.start', config: {} }], edges: [] };
    const problems = workflowGraphProblems(graph);
    expect(problems.some((p) => p.includes('N-bad!'))).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const graph = {
      version: 1,
      nodes: [
        { id: 'n_a', type: 'core.start', config: {} },
        { id: 'n_a', type: 'core.end', config: {} },
      ],
      edges: [],
    };
    const problems = workflowGraphProblems(graph);
    expect(problems.some((p) => p.includes('duplicate'))).toBe(true);
  });

  it('rejects an edge referencing a missing node', () => {
    const graph = {
      version: 1,
      nodes: [{ id: 'n_a', type: 'core.start', config: {} }],
      edges: [{ id: 'e1', from: 'n_a', fromPort: 'out', to: 'n_missing', toPort: 'in' }],
    };
    const problems = workflowGraphProblems(graph);
    expect(problems.some((p) => p.includes('n_missing'))).toBe(true);
  });

  it('rejects a duplicate edge id', () => {
    const graph = {
      version: 1,
      nodes: [
        { id: 'n_a', type: 'core.start', config: {} },
        { id: 'n_b', type: 'core.end', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'n_a', fromPort: 'out', to: 'n_b', toPort: 'in' },
        { id: 'e1', from: 'n_a', fromPort: 'out', to: 'n_b', toPort: 'in' },
      ],
    };
    const problems = workflowGraphProblems(graph);
    expect(problems.some((p) => p.includes('duplicate') && p.includes('e1'))).toBe(true);
  });

  it('rejects more than MAX_GRAPH_NODES nodes', () => {
    const nodes = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => ({ id: `n_${i}`, type: 'core.start', config: {} }));
    const problems = workflowGraphProblems({ version: 1, nodes, edges: [] });
    expect(problems.some((p) => p.includes(String(MAX_GRAPH_NODES)))).toBe(true);
  });

  it('rejects more than MAX_GRAPH_EDGES edges', () => {
    const nodes = [
      { id: 'n_a', type: 'core.start', config: {} },
      { id: 'n_b', type: 'core.end', config: {} },
    ];
    const edges = Array.from({ length: MAX_GRAPH_EDGES + 1 }, (_, i) => ({
      id: `e_${i}`,
      from: 'n_a',
      fromPort: 'out',
      to: 'n_b',
      toPort: 'in',
    }));
    const problems = workflowGraphProblems({ version: 1, nodes, edges });
    expect(problems.some((p) => p.includes(String(MAX_GRAPH_EDGES)))).toBe(true);
  });

  it('never throws on malformed input', () => {
    const inputs: unknown[] = [undefined, 42, [], { nodes: 'nope' }, { nodes: [1, 2, 3], edges: null }];
    for (const input of inputs) {
      expect(() => workflowGraphProblems(input)).not.toThrow();
    }
  });

  it('exposes the id grammar pattern', () => {
    expect(WORKFLOW_NODE_ID_PATTERN.test('n_a1')).toBe(true);
    expect(WORKFLOW_NODE_ID_PATTERN.test('N-bad!')).toBe(false);
  });

  describe('position (client canvas layout, optional)', () => {
    it('accepts a node with no position at all', () => {
      const graph = { ...validGraph, nodes: [{ id: 'n_start', type: 'core.start', config: {} }], edges: [] };
      expect(workflowGraphProblems(graph)).toEqual([]);
    });

    it('accepts a node with a well-formed {x, y} position', () => {
      const graph = {
        ...validGraph,
        nodes: [{ id: 'n_start', type: 'core.start', config: {}, position: { x: 10, y: -20.5 } }],
        edges: [],
      };
      expect(workflowGraphProblems(graph)).toEqual([]);
    });

    it('rejects a position that is not a plain object', () => {
      const graph = {
        ...validGraph,
        nodes: [{ id: 'n_start', type: 'core.start', config: {}, position: 'nope' }],
        edges: [],
      };
      const problems = workflowGraphProblems(graph);
      expect(problems.some((p) => p.includes('/position'))).toBe(true);
    });

    it('rejects a position missing x or y', () => {
      const graph = {
        ...validGraph,
        nodes: [{ id: 'n_start', type: 'core.start', config: {}, position: { x: 1 } }],
        edges: [],
      };
      const problems = workflowGraphProblems(graph);
      expect(problems.some((p) => p.includes('/position'))).toBe(true);
    });

    it('rejects a position with non-finite x/y', () => {
      const graph = {
        ...validGraph,
        nodes: [{ id: 'n_start', type: 'core.start', config: {}, position: { x: Number.NaN, y: 1 } }],
        edges: [],
      };
      const problems = workflowGraphProblems(graph);
      expect(problems.some((p) => p.includes('/position'))).toBe(true);
    });

    it('never throws when position itself is malformed input', () => {
      const inputs: unknown[] = [null, 42, [], { x: '1', y: '2' }];
      for (const position of inputs) {
        const graph = { ...validGraph, nodes: [{ id: 'n_start', type: 'core.start', config: {}, position }], edges: [] };
        expect(() => workflowGraphProblems(graph)).not.toThrow();
      }
    });
  });
});
