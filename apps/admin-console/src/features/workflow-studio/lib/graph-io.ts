/**
 * JSON import/export of the editor buffer (TASK-864 B1). Export is the exact `WorkflowGraph`
 * the autosave PATCH sends; import is the mirror — parsed, SHAPE-checked (never trusted), and
 * handed to the store's `hydrate`. Validation of the graph's meaning stays server-side
 * (`validate`), exactly as for a hand-edited graph.
 */
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../api/types';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';
import { toWorkflowGraph } from './graph-serialization';

export const GRAPH_EXPORT_FILENAME = (slug: string, versionNumber: number) => `${slug}.v${versionNumber}.workflow.json`;

export function exportGraphJson(nodes: readonly GraphStoreNode[], edges: readonly GraphStoreEdge[]): string {
  return JSON.stringify(toWorkflowGraph(nodes, edges), null, 2);
}

export type ParsedGraph = { ok: true; graph: WorkflowGraph } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nodeProblem(value: unknown, index: number): string | null {
  if (!isRecord(value)) return `nodes[${index}] is not an object.`;
  if (typeof value.id !== 'string' || value.id.length === 0) return `nodes[${index}].id must be a non-empty string.`;
  if (typeof value.type !== 'string' || value.type.length === 0) return `nodes[${index}].type must be a non-empty string.`;
  if (value.config !== undefined && !isRecord(value.config)) return `nodes[${index}].config must be an object.`;
  if (value.parentId !== undefined && typeof value.parentId !== 'string') return `nodes[${index}].parentId must be a string.`;
  if (value.position !== undefined && !(isRecord(value.position) && typeof value.position.x === 'number' && typeof value.position.y === 'number')) {
    return `nodes[${index}].position must be { x, y }.`;
  }
  return null;
}

function edgeProblem(value: unknown, index: number, ids: Set<string>): string | null {
  if (!isRecord(value)) return `edges[${index}] is not an object.`;
  for (const key of ['id', 'from', 'fromPort', 'to', 'toPort'] as const) {
    if (typeof value[key] !== 'string' || (value[key] as string).length === 0) return `edges[${index}].${key} must be a non-empty string.`;
  }
  if (!ids.has(value.from as string)) return `edges[${index}].from names an unknown node "${value.from as string}".`;
  if (!ids.has(value.to as string)) return `edges[${index}].to names an unknown node "${value.to as string}".`;
  return null;
}

export function parseGraphJson(text: string): ParsedGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'Not valid JSON.' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'The document must be a JSON object.' };
  if (parsed.version !== 1) return { ok: false, reason: 'Unsupported graph version — expected "version": 1.' };
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return { ok: false, reason: 'The document needs "nodes" and "edges" arrays.' };
  const ids = new Set<string>();
  for (const [index, node] of parsed.nodes.entries()) {
    const problem = nodeProblem(node, index);
    if (problem) return { ok: false, reason: problem };
    const id = (node as WorkflowGraphNode).id;
    if (ids.has(id)) return { ok: false, reason: `Duplicate node id "${id}".` };
    ids.add(id);
  }
  for (const [index, edge] of parsed.edges.entries()) {
    const problem = edgeProblem(edge, index, ids);
    if (problem) return { ok: false, reason: problem };
  }
  for (const node of parsed.nodes as WorkflowGraphNode[]) {
    if (node.parentId !== undefined && !ids.has(node.parentId)) return { ok: false, reason: `Node "${node.id}" names an unknown parent "${node.parentId}".` };
  }
  const nodes: WorkflowGraphNode[] = (parsed.nodes as WorkflowGraphNode[]).map((node) => ({ ...node, config: node.config ?? {} }));
  return { ok: true, graph: { version: 1, nodes, edges: parsed.edges as WorkflowGraphEdge[] } };
}
