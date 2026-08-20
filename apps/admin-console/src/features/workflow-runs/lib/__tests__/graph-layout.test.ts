import { describe, expect, it } from 'vitest';
import { humanizeNodeType, layoutGraphNodes, toCanvasGraph } from '../graph-layout';
import type { WorkflowGraph } from '../../api/types';

const LINEAR_GRAPH: WorkflowGraph = {
  version: 1,
  nodes: [
    { id: 'start', type: 'core.start', config: {} },
    { id: 'middle', type: 'interpreter.noop', config: {} },
    { id: 'end', type: 'interpreter.passthrough', config: {} },
  ],
  edges: [
    { id: 'e1', from: 'start', fromPort: 'out', to: 'middle', toPort: 'in' },
    { id: 'e2', from: 'middle', fromPort: 'out', to: 'end', toPort: 'in' },
  ],
};

describe('layoutGraphNodes', () => {
  it('assigns increasing x per BFS/longest-path layer for a linear chain', () => {
    const positions = layoutGraphNodes(LINEAR_GRAPH);
    expect(positions.get('start')?.x).toBeLessThan(positions.get('middle')!.x);
    expect(positions.get('middle')?.x).toBeLessThan(positions.get('end')!.x);
  });

  it('stacks sibling nodes in the same layer at increasing y, never colliding', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'root', type: 'core.start', config: {} },
        { id: 'a', type: 'interpreter.noop', config: {} },
        { id: 'b', type: 'interpreter.noop', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'root', fromPort: 'out', to: 'a', toPort: 'in' },
        { id: 'e2', from: 'root', fromPort: 'out', to: 'b', toPort: 'in' },
      ],
    };
    const positions = layoutGraphNodes(graph);
    expect(positions.get('a')!.x).toBe(positions.get('b')!.x);
    expect(positions.get('a')!.y).not.toBe(positions.get('b')!.y);
  });

  it('prefers an authored node.position over the computed layout', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'n1', type: 'interpreter.noop', config: {}, position: { x: 999, y: 111 } }],
      edges: [],
    };
    const positions = layoutGraphNodes(graph);
    expect(positions.get('n1')).toEqual({ x: 999, y: 111 });
  });

  it('falls back to a legacy config.__position when node.position is absent', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'n1', type: 'interpreter.noop', config: { __position: { x: 5, y: 6 } } }],
      edges: [],
    };
    const positions = layoutGraphNodes(graph);
    expect(positions.get('n1')).toEqual({ x: 5, y: 6 });
  });

  it('prefers node.position over a legacy config.__position when both are present', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'n1', type: 'interpreter.noop', config: { __position: { x: 999, y: 999 } }, position: { x: 1, y: 2 } }],
      edges: [],
    };
    const positions = layoutGraphNodes(graph);
    expect(positions.get('n1')).toEqual({ x: 1, y: 2 });
  });

  it('never infinite-loops on a cyclic graph (cycle guard)', () => {
    const cyclic: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'a', type: 't', config: {} },
        { id: 'b', type: 't', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'a', fromPort: 'out', to: 'b', toPort: 'in' },
        { id: 'e2', from: 'b', fromPort: 'out', to: 'a', toPort: 'in' },
      ],
    };
    const positions = layoutGraphNodes(cyclic);
    expect(positions.size).toBe(2);
  });

  it('returns a position for every node, even one with dangling edges to an unknown id', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'solo', type: 't', config: {} }],
      edges: [{ id: 'e1', from: 'solo', fromPort: 'out', to: 'ghost', toPort: 'in' }],
    };
    const positions = layoutGraphNodes(graph);
    expect(positions.get('solo')).toBeDefined();
  });
});

describe('humanizeNodeType', () => {
  it('title-cases the segment after the last dot', () => {
    expect(humanizeNodeType('interpreter.noop')).toBe('Noop');
    expect(humanizeNodeType('interpreter.passthrough')).toBe('Passthrough');
  });

  it('replaces underscores with spaces', () => {
    expect(humanizeNodeType('summarize.extract_entities')).toBe('Extract entities');
  });

  it('falls back to the raw type when there is no dot', () => {
    expect(humanizeNodeType('noop')).toBe('Noop');
  });
});

describe('toCanvasGraph', () => {
  it('maps WorkflowGraphEdge.from/to onto WorkflowCanvasEdge.source/target', () => {
    const canvas = toCanvasGraph(LINEAR_GRAPH);
    expect(canvas.edges).toHaveLength(2);
    expect(canvas.edges[0]).toMatchObject({ source: 'start', target: 'middle', sourceHandle: 'out', targetHandle: 'in' });
  });

  it('maps every graph node to a canvas node with a humanized label and a position', () => {
    const canvas = toCanvasGraph(LINEAR_GRAPH);
    expect(canvas.nodes).toHaveLength(3);
    expect(canvas.nodes[1]).toMatchObject({ id: 'middle', type: 'interpreter.noop', label: 'Noop' });
    expect(canvas.nodes[1].position).toBeDefined();
  });
});
