/**
 * The store's node/edge model <-> `WorkflowGraph` (the server DTO shape) round trip
 * Task 11). `WorkflowGraphNode.position` is now a first-class, optional sibling of `config`
 * (definition-api.contract.md's "no `position` field" gap, closed — `@arcaai/workflow-contract`
 * `graph-model.ts`), so `toGraphNode` writes it there directly. `fromGraphNode` still reads the
 * legacy `config.__position` nesting this Studio used before that field existed, so a graph
 * saved under the old scheme still renders at its authored coordinates rather than snapping to
 * the origin — but that legacy shape is never written again.
 */
import type { WorkflowSettings } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../api/types';

/**
 * TASK-1036 §3.5 (D-3 / OD-5) — a graph that may carry `settings`. The server's `WorkflowGraph`
 * mirror does not name the key yet; the contract (`workflow-settings.ts`) reads it off the graph
 * JSON, so the Studio writes it there too.
 */
export type WorkflowGraphWithSettings = WorkflowGraph & { settings?: WorkflowSettings };

/** Studio-reserved key from before `WorkflowGraphNode.position` existed — read-only fallback. */
const LEGACY_POSITION_KEY = '__position';

interface Position {
  x: number;
  y: number;
}

function isPosition(value: unknown): value is Position {
  return typeof value === 'object' && value !== null && typeof (value as Position).x === 'number' && typeof (value as Position).y === 'number';
}

function toGraphNode(node: GraphStoreNode): WorkflowGraphNode {
  return { id: node.id, type: node.type, config: node.config, position: node.position, ...(node.parentId ? { parentId: node.parentId } : {}) };
}

function fromGraphNode(node: WorkflowGraphNode): GraphStoreNode {
  const { [LEGACY_POSITION_KEY]: legacyPosition, ...config } = node.config;
  const position = isPosition(node.position) ? node.position : isPosition(legacyPosition) ? legacyPosition : { x: 0, y: 0 };
  // `classesOf`/`safetyClasses` come from the node registry, not the graph document — the
  // caller (the store's `hydrate` action, or a selector that joins against the registry query)
  // fills this in; a bare deserialization has no registry to consult, so it starts empty.
  return { id: node.id, type: node.type, position, safetyClasses: [], config, ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}) };
}

function toGraphEdge(edge: GraphStoreEdge): WorkflowGraphEdge {
  return { id: edge.id, from: edge.source, fromPort: edge.sourceHandle, to: edge.target, toPort: edge.targetHandle };
}

function fromGraphEdge(edge: WorkflowGraphEdge): GraphStoreEdge {
  return { id: edge.id, source: edge.from, sourceHandle: edge.fromPort, target: edge.to, targetHandle: edge.toPort };
}

export function toWorkflowGraph(nodes: readonly GraphStoreNode[], edges: readonly GraphStoreEdge[], settings?: WorkflowSettings): WorkflowGraphWithSettings {
  return { version: 1, nodes: nodes.map(toGraphNode), edges: edges.map(toGraphEdge), ...(settings !== undefined ? { settings } : {}) };
}

/**
 * `settings` comes back exactly as stored when it is an object — even one the contract would
 * refuse. Validity is publish's verdict (`workflowSettingsProblems`), and dropping an unreadable
 * block here would silently delete it on the next Save.
 */
export function fromWorkflowGraph(graph: WorkflowGraph): { nodes: GraphStoreNode[]; edges: GraphStoreEdge[]; settings?: WorkflowSettings } {
  const raw = (graph as { settings?: unknown }).settings;
  const settings = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as WorkflowSettings) : undefined;
  return { nodes: graph.nodes.map(fromGraphNode), edges: graph.edges.map(fromGraphEdge), ...(settings !== undefined ? { settings } : {}) };
}
