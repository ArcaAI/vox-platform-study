/**
 * TASK-893 §3.2 — the execution-order badge.
 *
 * Two properties matter more than any individual number, and both are asserted here:
 *
 *  - **Totality.** Every node id gets an entry. The nodes with no step are exactly the ones the
 *    user most needs told about (in a cycle, or nothing reaches them), so they get a marker
 *    rather than a missing badge.
 *  - **Determinism.** The same graph always yields the same numbers, whatever order its nodes and
 *    edges happen to arrive in. A badge that renumbers itself between renders reads as the graph
 *    having changed.
 */
import { describe, expect, it } from 'vitest';
import { computeStepOrder, type StepOrderEntry } from '../step-order';

const TRIGGER = 'core.trigger';
const NOOP = 'noop';

function node(id: string, type: string = NOOP) {
  return { id, type };
}
function edge(source: string, target: string) {
  return { source, target };
}
/** The order as a plain object, so a failure prints the whole picture rather than a Map diff. */
function plain(order: Map<string, StepOrderEntry>): Record<string, StepOrderEntry> {
  return Object.fromEntries(order);
}

describe('computeStepOrder — the happy path', () => {
  it('numbers a linear chain from the trigger, 1-based', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a'), node('b')], [edge('t', 'a'), edge('a', 'b')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { step: 2 }, b: { step: 3 } });
  });

  it('numbers a fan-out as a single linear sequence, not as shared layers', () => {
    // The badge reads "execution order", so two nodes never wear the same number.
    const order = computeStepOrder([node('t', TRIGGER), node('a'), node('b'), node('c')], [edge('t', 'a'), edge('t', 'b'), edge('a', 'c'), edge('b', 'c')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { step: 2 }, b: { step: 3 }, c: { step: 4 } });
  });

  it('gives every node an entry — the map is TOTAL', () => {
    const nodes = [node('t', TRIGGER), node('a'), node('lonely'), node('x'), node('y')];
    const order = computeStepOrder(nodes, [edge('t', 'a'), edge('x', 'y'), edge('y', 'x')]);
    expect([...order.keys()].sort()).toEqual(['a', 'lonely', 't', 'x', 'y']);
  });

  it('returns an empty map for an empty graph', () => {
    expect(computeStepOrder([], [])).toEqual(new Map());
  });
});

describe('entry selection', () => {
  it('starts from EVERY entry node when a graph has more than one', () => {
    const order = computeStepOrder([node('t1', TRIGGER), node('t2', TRIGGER), node('a')], [edge('t1', 'a'), edge('t2', 'a')]);
    expect(plain(order)).toEqual({ t1: { step: 1 }, t2: { step: 2 }, a: { step: 3 } });
  });

  // Every seeded, published definition is still authored in the deprecated vocabulary, whose
  // entry is `core.start`. Without it those graphs would render as entirely `unreachable`.
  it('treats the deprecated `core.start` as an entry too', () => {
    const order = computeStepOrder([node('s', 'core.start'), node('a')], [edge('s', 'a')]);
    expect(plain(order)).toEqual({ s: { step: 1 }, a: { step: 2 } });
  });

  it('falls back to the nodes with no incoming edge when the graph declares no entry node', () => {
    const order = computeStepOrder([node('a'), node('b'), node('c')], [edge('a', 'b'), edge('b', 'c')]);
    expect(plain(order)).toEqual({ a: { step: 1 }, b: { step: 2 }, c: { step: 3 } });
  });

  it('reports a graph that is ALL cycle as a cycle, not as unreachable', () => {
    // No entry node and no in-degree-zero node: there is nothing to be unreachable FROM, and
    // "cycle" is the finding the user can act on.
    const order = computeStepOrder([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
    expect(plain(order)).toEqual({ a: { marker: 'cycle' }, b: { marker: 'cycle' } });
  });
});

describe('markers', () => {
  it('marks a disconnected component unreachable from the entry', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a'), node('x'), node('y')], [edge('t', 'a'), edge('x', 'y')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { step: 2 }, x: { marker: 'unreachable' }, y: { marker: 'unreachable' } });
  });

  it('marks a reachable cycle `cycle`, and keeps numbering everything before it', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a'), node('b')], [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { marker: 'cycle' }, b: { marker: 'cycle' } });
  });

  it('marks a self-loop `cycle` — a node that must run after itself never runs', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a')], [edge('t', 'a'), edge('a', 'a')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { marker: 'cycle' } });
  });

  it('prefers `unreachable` over `cycle` for a cycle nothing reaches', () => {
    // "This never runs" is the more useful of the two facts; the cycle inside it is moot.
    const order = computeStepOrder([node('t', TRIGGER), node('x'), node('y')], [edge('x', 'y'), edge('y', 'x')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, x: { marker: 'unreachable' }, y: { marker: 'unreachable' } });
  });

  // The bug this guards: counting an edge from an unreachable node toward a reachable node's
  // in-degree would hold it above zero forever and mislabel a perfectly ordinary node `cycle`.
  it('does NOT let an edge from an unreachable node block a reachable one', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a'), node('x')], [edge('t', 'a'), edge('x', 'a')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { step: 2 }, x: { marker: 'unreachable' } });
  });
});

describe('determinism', () => {
  it('breaks ties by the node index in the INPUT array, not by edge order', () => {
    const nodes = [node('t', TRIGGER), node('b'), node('a')];
    const edges = [edge('t', 'a'), edge('t', 'b')];
    // `b` is declared before `a`, so `b` is numbered first even though `a`'s edge comes first.
    expect(plain(computeStepOrder(nodes, edges))).toEqual({ t: { step: 1 }, b: { step: 2 }, a: { step: 3 } });
    // Reversing the edges must not change a single number.
    expect(plain(computeStepOrder(nodes, [...edges].reverse()))).toEqual({ t: { step: 1 }, b: { step: 2 }, a: { step: 3 } });
  });

  it('is stable across repeated runs over the same input', () => {
    const nodes = [node('t', TRIGGER), node('d'), node('c'), node('b'), node('a')];
    const edges = [edge('t', 'a'), edge('t', 'b'), edge('t', 'c'), edge('t', 'd'), edge('a', 'd')];
    const first = plain(computeStepOrder(nodes, edges));
    for (let run = 0; run < 5; run += 1) expect(plain(computeStepOrder(nodes, edges))).toEqual(first);
  });
});

describe('malformed input', () => {
  it('ignores an edge naming a node that is not in the graph', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a')], [edge('t', 'a'), edge('ghost', 'a'), edge('a', 'ghost')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { step: 2 } });
  });

  it('handles a duplicated edge without stranding its target', () => {
    const order = computeStepOrder([node('t', TRIGGER), node('a')], [edge('t', 'a'), edge('t', 'a')]);
    expect(plain(order)).toEqual({ t: { step: 1 }, a: { step: 2 } });
  });
});
