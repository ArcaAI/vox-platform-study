import type { WorkflowCanvasNode } from '@arcaai/ui/components/workflow-canvas';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../api/types';

/**
 * `WorkflowGraphNode` has no `position` field (`@arcaai/workflow-contract`'s
 * `graph-model.ts`) — TASK-719's own contract audit recorded the documented
 * fallback: a Studio-reserved `config.__position` nesting, for when a graph
 * actually carries authored coordinates. This module reads that fallback
 * when present, and otherwise computes a deterministic layered layout so the
 * read-only run-trace canvas (Task 8) never renders every node stacked at
 * the origin.
 */

const COLUMN_WIDTH = 240;
const ROW_HEIGHT = 120;

interface Position {
  x: number;
  y: number;
}

function readAuthoredPosition(node: WorkflowGraphNode): Position | null {
  const raw = node.config?.__position;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as Record<string, unknown>).x === 'number' &&
    typeof (raw as Record<string, unknown>).y === 'number'
  ) {
    return { x: (raw as { x: number }).x, y: (raw as { y: number }).y };
  }
  return null;
}

/**
 * Longest-path-from-a-root layer index for every node (a standard layered
 * DAG layout, e.g. Sugiyama's first step). Nodes with no incoming edge are
 * layer 0; every other node's layer is `1 + max(layer of its predecessors)`.
 * A cyclic graph (which `@arcaai/workflow-contract` rejects at publish time,
 * but a DRAFT may still carry) falls back to array order rather than
 * looping forever.
 */
function computeLayers(nodes: readonly WorkflowGraphNode[], edges: readonly WorkflowGraphEdge[]): Map<string, number> {
  const ids = nodes.map((node) => node.id);
  const idSet = new Set(ids);
  const predecessors = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    predecessors.get(edge.to)?.push(edge.from);
  }

  const layers = new Map<string, number>();
  const visiting = new Set<string>();

  function layerOf(id: string): number {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0; // cycle guard — never recurse forever
    visiting.add(id);
    const preds = predecessors.get(id) ?? [];
    const layer = preds.length === 0 ? 0 : 1 + Math.max(...preds.map((predId) => layerOf(predId)));
    visiting.delete(id);
    layers.set(id, layer);
    return layer;
  }

  for (const id of ids) layerOf(id);
  return layers;
}

/** Deterministic `{x, y}` for every node: authored `config.__position` first, else a layered fallback. */
export function layoutGraphNodes(graph: Pick<WorkflowGraph, 'nodes' | 'edges'>): Map<string, Position> {
  const layers = computeLayers(graph.nodes, graph.edges);
  const rowCountPerLayer = new Map<number, number>();
  const positions = new Map<string, Position>();

  for (const node of graph.nodes) {
    const authored = readAuthoredPosition(node);
    if (authored) {
      positions.set(node.id, authored);
      continue;
    }
    const layer = layers.get(node.id) ?? 0;
    const row = rowCountPerLayer.get(layer) ?? 0;
    rowCountPerLayer.set(layer, row + 1);
    positions.set(node.id, { x: layer * COLUMN_WIDTH, y: row * ROW_HEIGHT });
  }

  return positions;
}

/** Humanize a registry node `type` string ("interpreter.noop" -> "Noop") into a canvas label, absent a real display-name field on the registry today. */
export function humanizeNodeType(type: string): string {
  const last = type.split('.').pop() ?? type;
  return last.length === 0 ? type : last.charAt(0).toUpperCase() + last.slice(1).replaceAll('_', ' ');
}

/** `WorkflowGraph` -> the canvas composite's node/edge shape (readOnly rendering only — never round-tripped back to a write). */
export function toCanvasGraph(graph: Pick<WorkflowGraph, 'nodes' | 'edges'>): {
  nodes: WorkflowCanvasNode[];
  edges: { id: string; source: string; sourceHandle?: string; target: string; targetHandle?: string }[];
} {
  const positions = layoutGraphNodes(graph);
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: humanizeNodeType(node.type),
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      config: node.config,
    })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      sourceHandle: edge.fromPort,
      target: edge.to,
      targetHandle: edge.toPort,
    })),
  };
}
