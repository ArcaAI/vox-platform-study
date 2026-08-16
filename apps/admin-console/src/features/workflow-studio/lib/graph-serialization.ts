/**
 * The store's node/edge model <-> `WorkflowGraph` (the server DTO shape) round trip (TASK-719
 * Task 11). `WorkflowGraphNode` has NO `position` field (confirmed against delivered code —
 * `contracts/definition-api.contract.md`), so client-side canvas layout is nested under the
 * Studio-reserved `config.__position` key at this boundary only; the store, the canvas
 * composite, and the list editor never see it as anything other than `node.position`.
 */
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../api/types';

const POSITION_KEY = '__position';

interface Position {
  x: number;
  y: number;
}

function isPosition(value: unknown): value is Position {
  return typeof value === 'object' && value !== null && typeof (value as Position).x === 'number' && typeof (value as Position).y === 'number';
}

function toGraphNode(node: GraphStoreNode): WorkflowGraphNode {
  return { id: node.id, type: node.type, config: { ...node.config, [POSITION_KEY]: node.position } };
}

function fromGraphNode(node: WorkflowGraphNode): GraphStoreNode {
  const { [POSITION_KEY]: rawPosition, ...config } = node.config;
  const position = isPosition(rawPosition) ? rawPosition : { x: 0, y: 0 };
  // `classesOf`/`safetyClasses` come from the node registry, not the graph document — the
  // caller (the store's `hydrate` action, or a selector that joins against the registry query)
  // fills this in; a bare deserialization has no registry to consult, so it starts empty.
  return { id: node.id, type: node.type, position, safetyClasses: [], config };
}

function toGraphEdge(edge: GraphStoreEdge): WorkflowGraphEdge {
  return { id: edge.id, from: edge.source, fromPort: edge.sourceHandle, to: edge.target, toPort: edge.targetHandle };
}

function fromGraphEdge(edge: WorkflowGraphEdge): GraphStoreEdge {
  return { id: edge.id, source: edge.from, sourceHandle: edge.fromPort, target: edge.to, targetHandle: edge.toPort };
}

export function toWorkflowGraph(nodes: readonly GraphStoreNode[], edges: readonly GraphStoreEdge[]): WorkflowGraph {
  return { version: 1, nodes: nodes.map(toGraphNode), edges: edges.map(toGraphEdge) };
}

export function fromWorkflowGraph(graph: WorkflowGraph): { nodes: GraphStoreNode[]; edges: GraphStoreEdge[] } {
  return { nodes: graph.nodes.map(fromGraphNode), edges: graph.edges.map(fromGraphEdge) };
}
