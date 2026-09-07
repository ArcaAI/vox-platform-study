/**
 * TASK-893 §3.1-§3.3 — the explicit Save / Discard state machine that replaced autosave.
 *
 * Two facts are worth pinning hard, because both were free under autosave and are now the only
 * thing standing between a user and lost work:
 *
 *  1. `baseline` is the LAST SAVED graph and nothing else. `discard()` reverts to it, so a
 *     baseline that drifts (or is never set) turns Discard into either a no-op or a data loss.
 *  2. A `conflict` or an `error` is NOT cleared by carrying on editing. Autosave's `paused` flag
 *     lived in the hook and was cleared only by an explicit `resume()`; the store half must not
 *     quietly undo that by relabelling the next keystroke `dirty` and hiding the alert.
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore } from '../create-graph-store';
import { selectCanDiscard, selectCanSave, selectSaveState } from '../selectors';
import type { GraphStoreEdge, GraphStoreNode, SaveState } from '../types';

const NOOP = { type: 'noop', safetyClasses: [] as readonly string[] };

function node(id: string, x = 0, y = 0): GraphStoreNode {
  return { id, type: 'noop', position: { x, y }, safetyClasses: [], config: {} };
}
function edge(id: string, source: string, target: string): GraphStoreEdge {
  return { id, source, sourceHandle: 'out', target, targetHandle: 'in' };
}

describe('save state machine', () => {
  it('an edit on a clean graph moves clean -> dirty', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    expect(selectSaveState(store.getState())).toBe('clean');

    store.getState().addNode(NOOP, { x: 1, y: 1 });

    expect(store.getState().dirty).toBe(true);
    expect(selectSaveState(store.getState())).toBe('dirty');
  });

  it('an edit after a successful save moves saved -> dirty', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    store.getState().markSaved(2);
    expect(selectSaveState(store.getState())).toBe('saved');

    store.getState().updateNodeConfig('a', { enabled: false });

    expect(selectSaveState(store.getState())).toBe('dirty');
  });

  it.each<SaveState>(['conflict', 'error'])('an edit does NOT clear a standing %s — only Save or Discard resolves it', (standing) => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    store.getState().setSaveState(standing);

    store.getState().addNode(NOOP, { x: 5, y: 5 });

    expect(store.getState().dirty).toBe(true);
    expect(selectSaveState(store.getState())).toBe(standing);
  });

  it('an edit landing while a save is in flight leaves the machine in `saving` for the hook to finish', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    store.getState().setSaveState('saving');

    store.getState().addNode(NOOP, { x: 5, y: 5 });

    expect(selectSaveState(store.getState())).toBe('saving');
    expect(store.getState().dirty).toBe(true);
  });

  it('undo and redo are edits too — both mark the graph dirty', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    store.getState().addNode(NOOP, { x: 1, y: 1 });
    store.getState().markSaved(1);

    store.getState().undo();
    expect(selectSaveState(store.getState())).toBe('dirty');

    store.getState().markSaved(2);
    store.getState().redo();
    expect(selectSaveState(store.getState())).toBe('dirty');
  });
});

describe('selectCanSave / selectCanDiscard', () => {
  it('Save is offered only for unsaved work, and never while a PATCH is in flight', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    expect(selectCanSave(store.getState())).toBe(false);

    store.getState().addNode(NOOP, { x: 0, y: 0 });
    expect(selectCanSave(store.getState())).toBe(true);

    store.getState().setSaveState('saving');
    expect(selectCanSave(store.getState())).toBe(false);
  });

  it('Discard needs a baseline to revert TO', () => {
    const store = createGraphStore();
    // No hydrate: an editor that never loaded a graph has nothing to discard back to, and
    // reverting to nothing would delete the user's only copy of what they typed.
    store.getState().addNode(NOOP, { x: 0, y: 0 });
    expect(store.getState().dirty).toBe(true);
    expect(selectCanDiscard(store.getState())).toBe(false);

    store.getState().markSaved(1);
    store.getState().addNode(NOOP, { x: 1, y: 1 });
    expect(selectCanDiscard(store.getState())).toBe(true);
  });
});

describe('discard', () => {
  it('restores the last saved graph, clears both stacks and returns to clean', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a'), node('b', 10, 10)], [edge('e1', 'a', 'b')]);

    const added = store.getState().addNode(NOOP, { x: 99, y: 99 });
    store.getState().disconnectEdge('e1');
    store.getState().moveNode('a', { x: 400, y: 400 });
    expect(store.getState().nodes).toHaveLength(3);

    store.getState().discard();

    const state = store.getState();
    expect(state.nodes).toEqual([node('a'), node('b', 10, 10)]);
    expect(state.edges).toEqual([edge('e1', 'a', 'b')]);
    expect(state.nodes.some((candidate) => candidate.id === added)).toBe(false);
    expect(state.dirty).toBe(false);
    expect(state.saveState).toBe('clean');
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
  });

  it('reverts to the LAST SAVE, not to the load', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    const kept = store.getState().addNode(NOOP, { x: 1, y: 1 });
    store.getState().markSaved(3);

    store.getState().addNode(NOOP, { x: 2, y: 2 });
    store.getState().discard();

    expect(store.getState().nodes.map((candidate) => candidate.id)).toEqual(['a', kept]);
    expect(store.getState().lastSavedVersion).toBe(3);
  });

  it('clears the selection when the selected node did not survive the revert', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    const added = store.getState().addNode(NOOP, { x: 1, y: 1 });
    store.getState().selectNode(added);

    store.getState().discard();

    expect(store.getState().selectedNodeId).toBeNull();
  });

  it('keeps a selection that still exists after the revert', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    store.getState().selectNode('a');
    store.getState().addNode(NOOP, { x: 1, y: 1 });

    store.getState().discard();

    expect(store.getState().selectedNodeId).toBe('a');
  });

  it('clears a standing conflict — resolving it by throwing the local edits away is the point', () => {
    const store = createGraphStore();
    store.getState().hydrate([node('a')], []);
    store.getState().addNode(NOOP, { x: 1, y: 1 });
    store.getState().setSaveState('conflict');

    store.getState().discard();

    expect(store.getState().saveState).toBe('clean');
  });

  it('is a no-op with no baseline — it must never empty a graph it cannot restore', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(NOOP, { x: 0, y: 0 });

    store.getState().discard();

    expect(store.getState().nodes.map((candidate) => candidate.id)).toEqual([id]);
    expect(store.getState().dirty).toBe(true);
  });
});

describe('initializeGraph', () => {
  it('makes the pre-placed mandatory set the baseline, so the first edit is discardable', () => {
    const store = createGraphStore();
    store.getState().initializeGraph([
      { type: 'core.trigger', safetyClasses: ['mandatory'] },
      { type: 'noop', safetyClasses: [] },
    ]);
    const seeded = store.getState().nodes;
    expect(store.getState().baseline).toEqual({ nodes: seeded, edges: [] });

    store.getState().addNode(NOOP, { x: 1, y: 1 });
    expect(selectCanDiscard(store.getState())).toBe(true);

    store.getState().discard();
    expect(store.getState().nodes).toEqual(seeded);
  });
});
