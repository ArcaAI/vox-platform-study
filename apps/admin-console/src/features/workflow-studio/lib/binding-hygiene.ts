/**
 * TASK-1036 (OD-29) — bindings that read a step which no longer runs first.
 *
 * A `{ from: 'nodes.<id>.outputs.…' }` binding is only legal while `<id>` is an ANCESTOR of the
 * reader (publish: `BINDING_NOT_ANCESTOR`). Deleting the link or the step that made it an ancestor
 * would otherwise leave a binding the author never sees until publish refuses it. The store runs
 * this after every removal, so the inspector always shows what will actually run.
 *
 * Only `from` and `firstOf` are pruned: they are references the composer wrote. A `template` is
 * text the author typed, so it is left alone and publish names the stale reference.
 */
import { edgeAncestors, type Binding } from '@arcaai/workflow-contract';
import type { GraphStoreEdge, GraphStoreNode } from '../store/types';

const NODE_PATH = /^nodes\.([^.]+)\./;

/** The step id a binding path reads, or `null` for a non-step root. */
export function producerOf(path: string): string | null {
  const match = NODE_PATH.exec(path);
  return match ? (match[1] ?? null) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `binding` without the paths whose producer is not in `allowed`; `null` = nothing left. */
function pruneBinding(binding: unknown, allowed: (producerId: string) => boolean): unknown | null {
  if (!isRecord(binding)) return binding;
  if (typeof binding.from === 'string') {
    const producer = producerOf(binding.from);
    return producer === null || allowed(producer) ? binding : null;
  }
  if (Array.isArray(binding.firstOf)) {
    const kept = binding.firstOf.filter((path): path is string => typeof path === 'string' && (producerOf(path) === null || allowed(producerOf(path) as string)));
    if (kept.length === binding.firstOf.length) return binding;
    if (kept.length === 0) return null;
    if (kept.length === 1) return { from: kept[0] } satisfies Binding;
    return { firstOf: kept } satisfies Binding;
  }
  return binding;
}

/**
 * Every node with its `config.inputs` pruned of references to steps that are not (any more) its
 * ancestors. Returns the SAME array when nothing changed, so a removal that touches no binding
 * does not churn every node's identity.
 */
export function pruneUnreachableBindings(nodes: readonly GraphStoreNode[], edges: readonly GraphStoreEdge[]): GraphStoreNode[] {
  const graph = { edges: edges.map((edge) => ({ id: edge.id, from: edge.source, fromPort: edge.sourceHandle, to: edge.target, toPort: edge.targetHandle })) };
  const alive = new Set(nodes.map((node) => node.id));
  let changed = false;
  const next = nodes.map((node) => {
    const inputs = node.config.inputs;
    if (!isRecord(inputs) || Object.keys(inputs).length === 0) return node;
    let ancestors: Set<string> | null = null;
    const allowed = (producerId: string): boolean => {
      if (!alive.has(producerId)) return false;
      ancestors ??= edgeAncestors(graph, node.id);
      return ancestors.has(producerId);
    };
    let touched = false;
    const kept: Record<string, unknown> = {};
    for (const [name, binding] of Object.entries(inputs)) {
      const pruned = pruneBinding(binding, allowed);
      if (pruned !== binding) touched = true;
      if (pruned !== null) kept[name] = pruned;
    }
    if (!touched) return node;
    changed = true;
    const { inputs: _drop, ...rest } = node.config;
    return { ...node, config: Object.keys(kept).length > 0 ? { ...rest, inputs: kept } : rest };
  });
  return changed ? next : (nodes as GraphStoreNode[]);
}
