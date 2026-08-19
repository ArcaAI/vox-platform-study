/**
 * TASK-719 UX pass — the store-side halves of the editor affordances added on 2026-08-19:
 * `canConnect` (the drag-time guard the canvas asks BEFORE a drop is committed) and
 * `duplicateNode`. Undo/redo already existed on the store; the tests here pin that the new
 * mutations participate in it, because a duplicate that cannot be undone is worse than no
 * duplicate at all.
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore } from '../create-graph-store';

const NOOP = { type: 'noop', safetyClasses: [] as readonly string[] };
const MANDATORY = { type: 'guardrail_gate', safetyClasses: ['mandatory'] as readonly string[] };

describe('canConnect — the same rules as connect, without mutating', () => {
  it('refuses a self-edge, a missing endpoint and a duplicate, and never changes the graph', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(NOOP, { x: 0, y: 0 });
    const b = store.getState().addNode(NOOP, { x: 0, y: 0 });

    expect(store.getState().canConnect({ source: a, sourceHandle: 'out', target: a, targetHandle: 'in' })).toEqual({
      ok: false,
      reason: 'A node cannot connect to itself.',
    });
    expect(store.getState().canConnect({ source: a, sourceHandle: 'out', target: 'ghost', targetHandle: 'in' }).ok).toBe(false);
    expect(store.getState().canConnect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' })).toEqual({ ok: true });
    expect(store.getState().edges).toHaveLength(0);

    store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    expect(store.getState().canConnect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' }).ok).toBe(false);
  });
});

describe('duplicateNode', () => {
  it('copies type, classes and config into a new selected node, offset from the original', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(NOOP, { x: 10, y: 20 });
    store.getState().updateNodeConfig(id, { prompt: 'hello' });

    expect(store.getState().duplicateNode(id)).toEqual({ ok: true });

    const { nodes, selectedNodeId } = store.getState();
    expect(nodes).toHaveLength(2);
    const copy = nodes[1];
    expect(copy.id).not.toBe(id);
    expect(copy.type).toBe('noop');
    expect(copy.config).toEqual({ prompt: 'hello' });
    expect(copy.position).toEqual({ x: 50, y: 80 });
    expect(selectedNodeId).toBe(copy.id);
    expect(store.getState().dirty).toBe(true);
  });

  it('does NOT alias the original config object', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(NOOP, { x: 0, y: 0 });
    store.getState().updateNodeConfig(id, { prompt: 'hello' });
    store.getState().duplicateNode(id);
    const copyId = store.getState().nodes[1].id;
    store.getState().updateNodeConfig(copyId, { prompt: 'changed' });
    expect(store.getState().nodes[0].config).toEqual({ prompt: 'hello' });
  });

  it('refuses a mandatory node (it is a singleton) and an unknown id', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(MANDATORY, { x: 0, y: 0 });
    expect(store.getState().duplicateNode(id).ok).toBe(false);
    expect(store.getState().duplicateNode('ghost')).toEqual({ ok: false, reason: 'Node not found.' });
    expect(store.getState().nodes).toHaveLength(1);
  });

  it('is undoable', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(NOOP, { x: 0, y: 0 });
    store.getState().duplicateNode(id);
    expect(store.getState().nodes).toHaveLength(2);
    store.getState().undo();
    expect(store.getState().nodes).toHaveLength(1);
    store.getState().redo();
    expect(store.getState().nodes).toHaveLength(2);
  });
});
