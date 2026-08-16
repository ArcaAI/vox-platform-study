/**
 * `config.__position` round-trip (TASK-719 Task 11 / definition-api.contract.md's "no
 * `position` field" gap). `WorkflowGraphNode` has NO first-class position field — the Studio
 * nests client-side canvas layout under a Studio-reserved config key rather than inventing one
 * the server doesn't have.
 */
import { describe, expect, it } from 'vitest';
import { fromWorkflowGraph, toWorkflowGraph } from '../graph-serialization';
import type { WorkflowGraph } from '../../api/types';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';

describe('toWorkflowGraph / fromWorkflowGraph', () => {
  it('nests position under config.__position and strips it back out on the way in', () => {
    const nodes: GraphStoreNode[] = [
      { id: 'n1', type: 'noop', position: { x: 10, y: 20 }, safetyClasses: [], config: { promptTemplateId: 'abc' } },
    ];
    const edges: GraphStoreEdge[] = [{ id: 'e1', source: 'n1', sourceHandle: 'out', target: 'n1', targetHandle: 'in' }];

    const graph = toWorkflowGraph(nodes, edges);
    expect(graph).toEqual<WorkflowGraph>({
      version: 1,
      nodes: [{ id: 'n1', type: 'noop', config: { promptTemplateId: 'abc', __position: { x: 10, y: 20 } } }],
      edges: [{ id: 'e1', from: 'n1', fromPort: 'out', to: 'n1', toPort: 'in' }],
    });

    const round = fromWorkflowGraph(graph);
    expect(round.nodes).toEqual(nodes);
    expect(round.edges).toEqual(edges);
  });

  it('defaults a missing __position to the origin rather than crashing', () => {
    const graph: WorkflowGraph = { version: 1, nodes: [{ id: 'n1', type: 'noop', config: {} }], edges: [] };
    const { nodes } = fromWorkflowGraph(graph);
    expect(nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('never leaks __position into the config the validator/inspector sees', () => {
    const nodes: GraphStoreNode[] = [{ id: 'n1', type: 'noop', position: { x: 1, y: 2 }, safetyClasses: [], config: {} }];
    const graph = toWorkflowGraph(nodes, []);
    const round = fromWorkflowGraph(graph);
    expect(round.nodes[0].config).toEqual({});
    expect('__position' in round.nodes[0].config).toBe(false);
  });
});
