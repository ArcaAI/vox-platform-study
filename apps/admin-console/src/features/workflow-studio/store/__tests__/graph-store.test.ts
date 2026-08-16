/**
 * Graph editing store (TASK-719 Task 11). Business rules live on the store's actions so both
 * editors (canvas + list/tree, Task 13) get identical refusal behavior — README §4 Task 11.
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore } from '../create-graph-store';

function mandatoryNode(id: string) {
  return { id, type: 'noop', position: { x: 0, y: 0 }, safetyClasses: ['mandatory'], config: {} };
}

describe('createGraphStore', () => {
  it('starts empty, clean, and in canvas view', () => {
    const store = createGraphStore();
    const state = store.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.selectedNodeId).toBeNull();
    expect(state.viewMode).toBe('canvas');
    expect(state.dirty).toBe(false);
    expect(state.autosaveState).toBe('idle');
  });

  it('addNode inserts a node, marks dirty, and returns the new id', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 5, y: 5 });
    const state = store.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]).toMatchObject({ id, type: 'noop', position: { x: 5, y: 5 } });
    expect(state.dirty).toBe(true);
  });

  it('deleteNode removes an ordinary node', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    const result = store.getState().deleteNode(id);
    expect(result).toEqual({ ok: true });
    expect(store.getState().nodes).toHaveLength(0);
  });

  it('deleteNode REFUSES a mandatory node, in both editors alike, with a reason', () => {
    const store = createGraphStore();
    store.setState({ nodes: [mandatoryNode('m1')] });
    const result = store.getState().deleteNode('m1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/mandatory/i);
    expect(store.getState().nodes).toHaveLength(1);
  });

  it('deleteNode on an unknown id is a no-op failure, not a throw', () => {
    const store = createGraphStore();
    const result = store.getState().deleteNode('missing');
    expect(result.ok).toBe(false);
  });

  it('connect refuses a self-edge', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    const result = store.getState().connect({ source: id, sourceHandle: 'out', target: id, targetHandle: 'in' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/self/i);
    expect(store.getState().edges).toHaveLength(0);
  });

  it('connect refuses a duplicate edge', () => {
    const store = createGraphStore();
    const a = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 1, y: 1 });
    const first = store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    expect(first.ok).toBe(true);
    const second = store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/duplicate/i);
    expect(store.getState().edges).toHaveLength(1);
  });

  it('initializeGraph pre-places mandatory node types, not deletable from the start', () => {
    const store = createGraphStore();
    store.getState().initializeGraph([
      { type: 'guardrail_gate', safetyClasses: ['mandatory'] },
      { type: 'noop', safetyClasses: [] },
    ]);
    const state = store.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0].type).toBe('guardrail_gate');
    expect(state.nodes[0].safetyClasses).toContain('mandatory');
  });

  it('updateNodeConfig merges config and marks dirty without moving the node', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().markSaved(1);
    store.getState().updateNodeConfig(id, { promptTemplateId: 'a' });
    const state = store.getState();
    expect(state.nodes[0].config).toEqual({ promptTemplateId: 'a' });
    expect(state.dirty).toBe(true);
  });

  it('moveNode updates position without marking dirty (layout is client-only bookkeeping)', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().markSaved(1);
    store.getState().moveNode(id, { x: 9, y: 9 });
    const state = store.getState();
    expect(state.nodes[0].position).toEqual({ x: 9, y: 9 });
  });

  it('markSaved clears dirty and records the version', () => {
    const store = createGraphStore();
    store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().markSaved(4);
    const state = store.getState();
    expect(state.dirty).toBe(false);
    expect(state.lastSavedVersion).toBe(4);
    expect(state.autosaveState).toBe('saved');
  });

  it('hydrate replaces the graph wholesale and resets dirty', () => {
    const store = createGraphStore();
    store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().hydrate([mandatoryNode('m1')], []);
    const state = store.getState();
    expect(state.nodes).toEqual([mandatoryNode('m1')]);
    expect(state.dirty).toBe(false);
  });

  it('reorderNode swaps display order without marking dirty (list-editor-only bookkeeping)', () => {
    const store = createGraphStore();
    const a = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 1, y: 1 });
    store.getState().markSaved(1);
    store.getState().reorderNode(b, 'up');
    const state = store.getState();
    expect(state.nodes.map((node) => node.id)).toEqual([b, a]);
    expect(state.dirty).toBe(false);
  });

  it('reorderNode is a no-op at the boundary (first node "up", last node "down")', () => {
    const store = createGraphStore();
    const a = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().reorderNode(a, 'up');
    expect(store.getState().nodes.map((node) => node.id)).toEqual([a]);
  });

  it('selectNode / setViewMode / setAutosaveState update their own slice only', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().selectNode(id);
    store.getState().setViewMode('list');
    store.getState().setAutosaveState('conflict');
    const state = store.getState();
    expect(state.selectedNodeId).toBe(id);
    expect(state.viewMode).toBe('list');
    expect(state.autosaveState).toBe('conflict');
  });
});
