/**
 * Pure, total, allocation-bounded graph algorithms over a `WorkflowGraph`. Every function
 * runs in O(V + E) — never path enumeration, which is exponential on a 256-node graph and
 * would hang the publish request ( Risk #3). No graph code existed in this repo
 * before this file
 *
 * Nothing here throws on a malformed graph: dangling edge endpoints are silently ignored (the
 * shape-level check that reports them lives in `workflowGraphProblems`), so an evaluator built
 * on these primitives stays total per 's "a validator that is not total is a validator
 * that can be bypassed".
 */

import type { WorkflowGraph } from './graph-model';

export type TopologicalLevelsResult = { levels: string[][] } | { cycle: string[] };

function buildAdjacency(graph: WorkflowGraph, avoiding?: ReadonlySet<string>): Map<string, string[]> {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    if (avoiding?.has(id)) continue;
    adjacency.set(id, []);
  }
  for (const edge of graph.edges) {
    if (avoiding?.has(edge.from) || avoiding?.has(edge.to)) continue;
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue; // dangling — ignored, see header
    adjacency.get(edge.from)?.push(edge.to);
  }
  return adjacency;
}

function buildReverseAdjacency(graph: WorkflowGraph): Map<string, string[]> {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const reverse = new Map<string, string[]>();
  for (const id of nodeIds) reverse.set(id, []);
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    reverse.get(edge.to)?.push(edge.from);
  }
  return reverse;
}

/**
 * Kahn's algorithm, grouped into LEVELS rather than a flat order: nodes with no remaining
 * unresolved dependency become ready in the same round and MAY run concurrently — the
 * structural expression of "independent tasks must continue" (design.md; INV-044/INV-108).
 * Returns `{ cycle }` (the unvisited node ids) when the graph is not a DAG.
 */
export function topologicalLevels(graph: WorkflowGraph): TopologicalLevelsResult {
  const nodeIds = graph.nodes.map((n) => n.id);
  const adjacency = buildAdjacency(graph);
  const indegree = new Map<string, number>();
  for (const id of nodeIds) indegree.set(id, 0);
  for (const [, targets] of adjacency) {
    for (const to of targets) indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const levels: string[][] = [];
  const visited = new Set<string>();
  let frontier = nodeIds.filter((id) => indegree.get(id) === 0).sort();

  while (frontier.length > 0) {
    levels.push(frontier);
    for (const id of frontier) visited.add(id);
    const next = new Set<string>();
    for (const id of frontier) {
      for (const to of adjacency.get(id) ?? []) {
        const remaining = (indegree.get(to) ?? 0) - 1;
        indegree.set(to, remaining);
        if (remaining === 0) next.add(to);
      }
    }
    frontier = Array.from(next).sort();
  }

  if (visited.size !== nodeIds.length) {
    const cycle = nodeIds.filter((id) => !visited.has(id)).sort();
    return { cycle };
  }
  return { levels };
}

/** Every node reachable from `nodeId`, INCLUDING `nodeId` itself (trivially reachable). */
export function reachableFrom(graph: WorkflowGraph, nodeId: string): Set<string> {
  const adjacency = buildAdjacency(graph);
  const visited = new Set<string>();
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

/** Every node that can reach at least one node in `nodeIds` (reverse BFS; includes targets). */
export function reachesAny(graph: WorkflowGraph, nodeIds: readonly string[]): Set<string> {
  const reverse = buildReverseAdjacency(graph);
  const visited = new Set<string>();
  const queue: string[] = [...nodeIds];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const prev of reverse.get(id) ?? []) {
      if (!visited.has(prev)) queue.push(prev);
    }
  }
  return visited;
}

/**
 * Whether any path exists from a node in `fromIds` to a node in `toIds`, optionally with a
 * set of nodes removed from the graph first (`avoiding`) — the mechanism `allPathsPassThrough`
 * builds on. BFS, O(V + E); never enumerates paths.
 */
export function pathExists(
  graph: WorkflowGraph,
  fromIds: readonly string[],
  toIds: readonly string[],
  options?: { avoiding?: Iterable<string> },
): boolean {
  const avoiding = new Set(options?.avoiding ?? []);
  const adjacency = buildAdjacency(graph, avoiding);
  const toSet = new Set(toIds);
  const visited = new Set<string>();
  const queue: string[] = fromIds.filter((id) => !avoiding.has(id));

  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (toSet.has(id)) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return false;
}

/**
 * True iff EVERY path from `fromIds` to `toIds` passes through at least one node in
 * `throughIds` — implemented as a cut-set / dominator check (remove `throughIds`, ask whether
 * any path survives), not path enumeration, per Risk #3: enumeration is
 * exponential and a 256-node graph would hang the publish request.
 *
 * Vacuously true when no `fromIds → toIds` path exists at all in the original graph — there
 * is no unguarded route to forbid.
 */
export function allPathsPassThrough(
  graph: WorkflowGraph,
  fromIds: readonly string[],
  toIds: readonly string[],
  throughIds: readonly string[],
): boolean {
  if (!pathExists(graph, fromIds, toIds)) return true;
  return !pathExists(graph, fromIds, toIds, { avoiding: throughIds });
}
