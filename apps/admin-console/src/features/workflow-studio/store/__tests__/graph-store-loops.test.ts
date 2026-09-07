/**
 * TASK-893 §3.2 / README §3.3 — loop GROUPING. `parentId` was already on the wire and the
 * compiler already lifts children into `loops[].body`; what was missing was the authoring
 * affordance. These three actions are it.
 *
 * The position arithmetic is the part worth testing hard. A child's `position` is RELATIVE to its
 * group (React Flow's convention, round-tripped verbatim by `graph-serialization.ts`), so
 * `wrapInLoop` has to convert absolute -> relative and `unwrapLoop` has to convert back. Getting
 * that wrong does not throw: it silently teleports every node in the body, and the user cannot
 * tell whether they moved it or the editor did.
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore, LOOP_NODE_TYPE } from '../create-graph-store';
import type { GraphStoreNode } from '../types';

const NOOP = { type: 'noop', safetyClasses: [] as readonly string[] };
const MANDATORY = { type: 'core.trigger', safetyClasses: ['mandatory'] as readonly string[] };

/** Matches `GROUP_PADDING` in `create-graph-store.ts`, itself mirrored from the canvas composite. */
const PADDING = { x: 24, top: 56 };

function nodeById(store: ReturnType<typeof createGraphStore>, id: string): GraphStoreNode {
  const found = store.getState().nodes.find((node) => node.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe('wrapInLoop', () => {
  it('creates a core.loop around the selection and re-parents it with RELATIVE positions', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 100, y: 100 });
    const b = store.getState().addNode(NOOP, { x: 300, y: 200 });
    store.getState().markSaved(1);

    const result = store.getState().wrapInLoop([a, b]);

    expect(result.ok).toBe(true);
    const loopId = result.loopId as string;
    expect(loopId).toBeTruthy();

    const loop = nodeById(store, loopId);
    expect(loop.type).toBe(LOOP_NODE_TYPE);
    // The loop origin sits one padding up-and-left of the selection's bounding box, so the
    // topmost child lands exactly on the padding the canvas will draw around it.
    expect(loop.position).toEqual({ x: 100 - PADDING.x, y: 100 - PADDING.top });
    expect(nodeById(store, a).parentId).toBe(loopId);
    expect(nodeById(store, a).position).toEqual({ x: PADDING.x, y: PADDING.top });
    expect(nodeById(store, b).parentId).toBe(loopId);
    expect(nodeById(store, b).position).toEqual({ x: 200 + PADDING.x, y: 100 + PADDING.top });

    expect(store.getState().dirty).toBe(true);
    expect(store.getState().saveState).toBe('dirty');
    expect(store.getState().selectedNodeId).toBe(loopId);
  });

  it('places the loop AHEAD of its body in the nodes array (a parent must precede its children)', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const loopId = store.getState().wrapInLoop([a]).loopId as string;
    expect(store.getState().nodes[0].id).toBe(loopId);
  });

  it('is undoable', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 100, y: 100 });
    store.getState().wrapInLoop([a]);
    expect(store.getState().nodes).toHaveLength(2);

    store.getState().undo();

    expect(store.getState().nodes).toHaveLength(1);
    expect(nodeById(store, a).parentId).toBeUndefined();
    expect(nodeById(store, a).position).toEqual({ x: 100, y: 100 });
  });

  it('leaves edges exactly as authored — a wire that now crosses the body boundary is a finding, not ours to delete', () => {
    const store = createGraphStore();
    const outside = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const inside = store.getState().addNode(NOOP, { x: 200, y: 0 });
    store.getState().connect({ source: outside, sourceHandle: 'out', target: inside, targetHandle: 'in' });

    store.getState().wrapInLoop([inside]);

    expect(store.getState().edges).toHaveLength(1);
    expect(store.getState().edges[0]).toMatchObject({ source: outside, target: inside });
  });

  it('refuses an empty selection', () => {
    const store = createGraphStore();
    const result = store.getState().wrapInLoop([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/at least one/i);
    expect(store.getState().nodes).toHaveLength(0);
    expect(store.getState().dirty).toBe(false);
  });

  it('refuses an unknown id without touching the graph', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const result = store.getState().wrapInLoop([a, 'ghost']);
    expect(result).toEqual({ ok: false, reason: 'Node not found.' });
    expect(store.getState().nodes).toHaveLength(1);
  });

  // `core.trigger` and `core.output` are BOTH `mandatory` in the registry, and the contract
  // refuses either inside a loop body ("the boundaries belong to the graph, not to an
  // iteration") — so the mandatory check is also the structural check.
  it('refuses a selection containing a mandatory node (which is how the graph boundaries stay out of a body)', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const trigger = store.getState().addNode(MANDATORY, { x: 50, y: 0 });

    const result = store.getState().wrapInLoop([a, trigger]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/mandatory/i);
    expect(store.getState().nodes).toHaveLength(2);
    expect(nodeById(store, a).parentId).toBeUndefined();
  });

  it('refuses a node that is already inside a loop', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    store.getState().wrapInLoop([a]);

    const result = store.getState().wrapInLoop([a]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already inside a loop/i);
    expect(store.getState().nodes).toHaveLength(2);
  });

  it('de-duplicates a repeated id rather than wrapping the node twice', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const result = store.getState().wrapInLoop([a, a]);
    expect(result.ok).toBe(true);
    expect(store.getState().nodes).toHaveLength(2);
  });
});

describe('unwrapLoop', () => {
  it('re-parents the body to the top level with ABSOLUTE positions, then deletes the loop', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 100, y: 100 });
    const b = store.getState().addNode(NOOP, { x: 300, y: 200 });
    const loopId = store.getState().wrapInLoop([a, b]).loopId as string;
    store.getState().markSaved(1);

    const result = store.getState().unwrapLoop(loopId);

    expect(result).toEqual({ ok: true });
    expect(store.getState().nodes.some((node) => node.id === loopId)).toBe(false);
    // Exactly where they were before the wrap — the round trip is lossless.
    expect(nodeById(store, a).position).toEqual({ x: 100, y: 100 });
    expect(nodeById(store, b).position).toEqual({ x: 300, y: 200 });
    expect(nodeById(store, a).parentId).toBeUndefined();
    expect('parentId' in nodeById(store, a)).toBe(false);
    expect(store.getState().dirty).toBe(true);
  });

  it('keeps the body — unlike deleteNode, which takes a loop and its children together', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 10, y: 10 });
    const loopId = store.getState().wrapInLoop([a]).loopId as string;

    store.getState().unwrapLoop(loopId);
    expect(store.getState().nodes.map((node) => node.id)).toEqual([a]);

    // The contrast, asserted rather than described.
    const c = store.getState().addNode(NOOP, { x: 10, y: 10 });
    const second = store.getState().wrapInLoop([c]).loopId as string;
    store.getState().deleteNode(second);
    expect(store.getState().nodes.some((node) => node.id === c)).toBe(false);
  });

  it('drops the edges that touched the loop, and only those', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const b = store.getState().addNode(NOOP, { x: 100, y: 0 });
    store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    const loopId = store.getState().wrapInLoop([a, b]).loopId as string;
    store.getState().connect({ source: loopId, sourceHandle: 'each', target: a, targetHandle: 'after' });
    expect(store.getState().edges).toHaveLength(2);

    store.getState().unwrapLoop(loopId);

    expect(store.getState().edges).toHaveLength(1);
    expect(store.getState().edges[0]).toMatchObject({ source: a, target: b });
  });

  it('re-parents a NESTED loop body to the grandparent, positioned in that scope', () => {
    const store = createGraphStore();
    const outerId = store.getState().addNode({ type: LOOP_NODE_TYPE, safetyClasses: [] }, { x: 1000, y: 1000 });
    const innerId = store.getState().addNode({ type: LOOP_NODE_TYPE, safetyClasses: [] }, { x: 30, y: 40 }, { parentId: outerId });
    const child = store.getState().addNode(NOOP, { x: 5, y: 6 }, { parentId: innerId });

    store.getState().unwrapLoop(innerId);

    // 30+5 / 40+6, expressed in the OUTER loop's scope — not the canvas's.
    expect(nodeById(store, child).parentId).toBe(outerId);
    expect(nodeById(store, child).position).toEqual({ x: 35, y: 46 });
  });

  it('is undoable', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 100, y: 100 });
    const loopId = store.getState().wrapInLoop([a]).loopId as string;

    store.getState().unwrapLoop(loopId);
    store.getState().undo();

    expect(nodeById(store, a).parentId).toBe(loopId);
    expect(store.getState().nodes).toHaveLength(2);
  });

  it('clears the selection when the loop itself was selected', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const loopId = store.getState().wrapInLoop([a]).loopId as string;
    expect(store.getState().selectedNodeId).toBe(loopId);

    store.getState().unwrapLoop(loopId);

    expect(store.getState().selectedNodeId).toBeNull();
  });

  it('refuses an unknown id and a node that is not a loop', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    expect(store.getState().unwrapLoop('ghost')).toEqual({ ok: false, reason: 'Node not found.' });
    const notALoop = store.getState().unwrapLoop(a);
    expect(notALoop.ok).toBe(false);
    if (!notALoop.ok) expect(notALoop.reason).toMatch(/only a loop/i);
    expect(store.getState().dirty).toBe(true); // from the addNode, not from either refusal
    expect(store.getState().undoStack).toHaveLength(1);
  });
});

describe('setNodeParent', () => {
  it('moves a node INTO a group, storing the position it was handed verbatim', () => {
    const store = createGraphStore();
    const loopId = store.getState().addNode({ type: LOOP_NODE_TYPE, safetyClasses: [] }, { x: 100, y: 100 });
    const a = store.getState().addNode(NOOP, { x: 500, y: 500 });
    store.getState().markSaved(1);

    store.getState().setNodeParent(a, loopId, { x: 40, y: 60 });

    expect(nodeById(store, a).parentId).toBe(loopId);
    expect(nodeById(store, a).position).toEqual({ x: 40, y: 60 });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().saveState).toBe('dirty');
  });

  it('moves a node OUT of a group and removes the parentId key entirely', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 100, y: 100 });
    store.getState().wrapInLoop([a]);

    store.getState().setNodeParent(a, null, { x: 700, y: 800 });

    expect(nodeById(store, a).position).toEqual({ x: 700, y: 800 });
    expect('parentId' in nodeById(store, a)).toBe(false);
  });

  it('is undoable', () => {
    const store = createGraphStore();
    const loopId = store.getState().addNode({ type: LOOP_NODE_TYPE, safetyClasses: [] }, { x: 0, y: 0 });
    const a = store.getState().addNode(NOOP, { x: 500, y: 500 });
    store.getState().setNodeParent(a, loopId, { x: 40, y: 60 });

    store.getState().undo();

    expect(nodeById(store, a).parentId).toBeUndefined();
    expect(nodeById(store, a).position).toEqual({ x: 500, y: 500 });
  });

  it('is a no-op when nothing actually changed (React Flow re-emits drag stops on every re-sync)', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 500, y: 500 });
    store.getState().markSaved(1);
    const before = store.getState().nodes;

    store.getState().setNodeParent(a, null, { x: 500, y: 500 });

    expect(store.getState().nodes).toBe(before);
    expect(store.getState().dirty).toBe(false);
  });

  it('refuses to make a node its own parent, or a child of its own descendant', () => {
    const store = createGraphStore();
    const outerId = store.getState().addNode({ type: LOOP_NODE_TYPE, safetyClasses: [] }, { x: 0, y: 0 });
    const innerId = store.getState().addNode({ type: LOOP_NODE_TYPE, safetyClasses: [] }, { x: 10, y: 10 }, { parentId: outerId });

    store.getState().setNodeParent(outerId, outerId, { x: 1, y: 1 });
    expect(nodeById(store, outerId).parentId).toBeUndefined();

    store.getState().setNodeParent(outerId, innerId, { x: 1, y: 1 });
    expect(nodeById(store, outerId).parentId).toBeUndefined();
  });

  it('ignores an unknown node id', () => {
    const store = createGraphStore();
    store.getState().setNodeParent('ghost', null, { x: 1, y: 1 });
    expect(store.getState().nodes).toHaveLength(0);
    expect(store.getState().dirty).toBe(false);
  });
});
