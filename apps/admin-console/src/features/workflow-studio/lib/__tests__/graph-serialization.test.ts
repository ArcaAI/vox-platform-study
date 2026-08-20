/**
 * `position` round-trip (TASK-719 Task 11 / definition-api.contract.md's "no `position` field"
 * gap, closed). `WorkflowGraphNode.position` is now a first-class, optional sibling of
 * `config` — the Studio writes canvas layout there directly. `fromWorkflowGraph` still reads
 * the legacy `config.__position` nesting as a fallback, so a graph saved before this field
 * existed still renders at its authored coordinates instead of snapping to the origin, but
 * `toWorkflowGraph` never writes that legacy shape again.
 */
import { describe, expect, it } from 'vitest';
import { fromWorkflowGraph, toWorkflowGraph } from '../graph-serialization';
import type { WorkflowGraph } from '../../api/types';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';

describe('toWorkflowGraph / fromWorkflowGraph', () => {
  it('serializes position as a first-class field, never inside config', () => {
    const nodes: GraphStoreNode[] = [
      { id: 'n1', type: 'noop', position: { x: 10, y: 20 }, safetyClasses: [], config: { promptTemplateId: 'abc' } },
    ];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n1', targetHandle: 'in' }];

    const graph = toWorkflowGraph(nodes, edges);
    expect(graph).toEqual<WorkflowGraph>({
      version: 1,
      nodes: [{ id: 'n1', type: 'noop', config: { promptTemplateId: 'abc' }, position: { x: 10, y: 20 } }],
      edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n1', toPort: 'in' }],
    });

    const round = fromWorkflowGraph(graph);
    expect(round.nodes).toEqual(nodes);
    expect(round.edges).toEqual(edges);
  });

  it('defaults a missing position to the origin rather than crashing', () => {
    const graph: WorkflowGraph = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };
    const { nodes } = fromWorkflowGraph(graph);
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('falls back to the legacy config.__position nesting for a graph saved before this field existed', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'n1', type: 'noop', config: { promptTemplateId: 'abc', __position: { x: 5, y: 6 } } }],
      edges: [],
    };
    const { nodes } = fromWorkflowGraph(graph);
    expect(nodes[0].position).toEqual({ x: 5, y: 6 });
    // Never leaks the legacy key into the config the validator/inspector sees.
    expect(nodes[0].config).toEqual({ promptTemplateId: 'abc' });
    expect('__position' in nodes[0].config).toBe(false);
  });

  it('prefers the first-class position field over a legacy config.__position if somehow both are present', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'n1', type: 'noop', config: { __position: { x: 999, y: 999 } }, position: { x: 1, y: 2 } }],
      edges: [],
    };
    const { nodes } = fromWorkflowGraph(graph);
    expect(nodes[0].position).toEqual({ x: 1, y: 2 });
  });

  it('never leaks a legacy __position into the config the validator/inspector sees', () => {
    const nodes: GraphStoreNode[] = [{ id: 'n1', type: 'noop', position: { x: 1, y: 2 }, safetyClasses: [], config: {} }];
    const graph = toWorkflowGraph(nodes, []);
    const round = fromWorkflowGraph(graph);
    expect(round.nodes[0].config).toEqual({});
    expect('__position' in round.nodes[0].config).toBe(false);
  });
});
