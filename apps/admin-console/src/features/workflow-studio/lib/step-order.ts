/**
 * TASK-893 §3.2 — the execution-order badge (①②③…) the canvas renders in every node header.
 *
 * A topological order over the graph's forward edges, starting from its ENTRY nodes. Two things
 * make this worth a module of its own rather than a `useMemo` in the editor:
 *
 *  1. **The result is TOTAL.** Every node id in the input gets an entry — a number, or a marker
 *     saying why it has none. A badge that silently disappears for the nodes that most need
 *     explaining (the ones in a cycle, the ones nothing reaches) would be worse than no badge.
 *     `cycle` and `unreachable` are exactly the two conditions the validation rail already
 *     reports as findings; this puts them where the user is looking.
 *  2. **The order is DETERMINISTIC.** Ties are broken by a node's index in the input array, so
 *     re-running this over the same graph always produces the same numbers. A badge that
 *     renumbers itself between renders is actively misleading — it reads as the graph having
 *     changed when only the iteration order did.
 *
 * Pure: no React, no store, no registry lookup beyond the node `type` it is handed.
 */

export type StepOrderEntry = { step: number } | { marker: 'cycle' | 'unreachable' };

/**
 * Node types that START a graph. `core.trigger` is the `core` vocabulary's entry boundary
 * (classes `['boundary', 'mandatory', 'entry']`); `core.start` is its deprecated predecessor and
 * is still the entry of every seeded, published definition until the Phase-3 migration lands.
 * Naming both is what keeps the badges meaningful on the graphs that exist TODAY.
 */
const ENTRY_NODE_TYPES: ReadonlySet<string> = new Set(['core.trigger', 'core.start']);

interface StepOrderNode {
  id: string;
  type: string;
}

interface StepOrderEdge {
  source: string;
  target: string;
}

/**
 * The execution order of `nodes` under `edges`, as a total map from node id to either its
 * 1-based step or the marker that explains its absence from the linear order.
 *
 * Entry selection, in order:
 *  1. every node whose `type` is an entry type;
 *  2. failing that, every node with no incoming edge (a legacy or partial graph authored without
 *     an entry node still gets useful numbers instead of an all-`unreachable` canvas);
 *  3. failing that too — every node has an incoming edge and none is an entry, i.e. the whole
 *     graph is one or more cycles — every node is treated as reachable, so the cycle detection
 *     below reports `cycle` rather than the far less informative `unreachable`.
 *
 * An edge naming an id that is not in `nodes` is ignored entirely: it can neither confer
 * reachability nor block a real node.
 */
export function computeStepOrder(nodes: readonly StepOrderNode[], edges: readonly StepOrderEdge[]): Map<string, StepOrderEntry> {
  const indexOf = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!indexOf.has(node.id)) indexOf.set(node.id, index);
  });

  const known = edges.filter((edge) => indexOf.has(edge.source) && indexOf.has(edge.target));

  // ---- 1. Entry set -------------------------------------------------------------------------
  const hasIncoming = new Set(known.map((edge) => edge.target));
  let entries = nodes.filter((node) => ENTRY_NODE_TYPES.has(node.type)).map((node) => node.id);
  let allReachable = false;
  if (entries.length === 0) entries = nodes.filter((node) => !hasIncoming.has(node.id)).map((node) => node.id);
  if (entries.length === 0) allReachable = true;

  // ---- 2. Reachability ----------------------------------------------------------------------
  const outgoing = new Map<string, string[]>();
  for (const edge of known) {
    const bucket = outgoing.get(edge.source);
    if (bucket) bucket.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
  }

  const reachable = new Set<string>();
  if (allReachable) {
    for (const node of nodes) reachable.add(node.id);
  } else {
    const queue = [...new Set(entries)];
    for (const id of queue) reachable.add(id);
    for (let head = 0; head < queue.length; head += 1) {
      for (const next of outgoing.get(queue[head]) ?? []) {
        if (reachable.has(next)) continue;
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  // ---- 3. Kahn over the REACHABLE subgraph --------------------------------------------------
  // Restricted to reachable-to-reachable edges on purpose: an edge arriving from an unreachable
  // node would otherwise hold its target's in-degree above zero forever and mislabel a perfectly
  // ordinary node `cycle`. A self-loop is NOT filtered out — a node that must run after itself
  // is a cycle, and letting it block its own in-degree is what reports that.
  const live = known.filter((edge) => reachable.has(edge.source) && reachable.has(edge.target));
  const indegree = new Map<string, number>();
  for (const id of reachable) indegree.set(id, 0);
  for (const edge of live) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);

  const liveOutgoing = new Map<string, string[]>();
  for (const edge of live) {
    const bucket = liveOutgoing.get(edge.source);
    if (bucket) bucket.push(edge.target);
    else liveOutgoing.set(edge.source, [edge.target]);
  }

  // The ready set is kept sorted by input index, and the smallest is always taken next: that is
  // the whole tie-break rule, and it is what makes two runs over the same graph agree.
  const ready: string[] = [];
  const insertReady = (id: string): void => {
    const rank = indexOf.get(id) ?? 0;
    let at = ready.length;
    while (at > 0 && (indexOf.get(ready[at - 1]) ?? 0) > rank) at -= 1;
    ready.splice(at, 0, id);
  };
  for (const [id, count] of indegree) if (count === 0) insertReady(id);

  const order = new Map<string, StepOrderEntry>();
  let step = 0;
  while (ready.length > 0) {
    const id = ready.shift() as string;
    step += 1;
    order.set(id, { step });
    for (const next of liveOutgoing.get(id) ?? []) {
      // Duplicate edges are decremented once each, which is why the adjacency list keeps them.
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) insertReady(next);
    }
  }

  // ---- 4. Totality --------------------------------------------------------------------------
  for (const node of nodes) {
    if (order.has(node.id)) continue;
    order.set(node.id, { marker: reachable.has(node.id) ? 'cycle' : 'unreachable' });
  }
  return order;
}
