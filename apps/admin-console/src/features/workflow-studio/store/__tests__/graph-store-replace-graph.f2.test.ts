/**
 * TASK-1036 F2 — `replaceGraph(nodes, edges, settings?)`: importing a file that carries
 * `graph.settings` is ONE undo step (it used to be two: replaceGraph, then setSettings).
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore } from '../create-graph-store';

const OLD_SETTINGS = { connections: ['api'], sources: ['consultation'] };
const NEW_SETTINGS = { connections: ['api', 'sse'], sources: [] };
const IMPORTED = [{ id: 'n1', type: 'core.agent', position: { x: 0, y: 0 }, safetyClasses: [] as readonly string[], config: {} }];

describe('replaceGraph with settings', () => {
  it('replaces nodes, edges and settings together and marks the graph dirty', () => {
    const store = createGraphStore();
    store.getState().hydrate([], [], OLD_SETTINGS);
    store.getState().replaceGraph(IMPORTED, [], NEW_SETTINGS);
    expect(store.getState().nodes).toEqual(IMPORTED);
    expect(store.getState().settings).toEqual(NEW_SETTINGS);
    expect(store.getState().dirty).toBe(true);
  });

  it('is ONE undo step: a single undo restores the graph AND the settings', () => {
    const store = createGraphStore();
    store.getState().hydrate([], [], OLD_SETTINGS);
    store.getState().replaceGraph(IMPORTED, [], NEW_SETTINGS);
    store.getState().undo();
    expect(store.getState().nodes).toEqual([]);
    expect(store.getState().settings).toEqual(OLD_SETTINGS);
    expect(store.getState().undoStack).toHaveLength(0);
    store.getState().redo();
    expect(store.getState().nodes).toEqual(IMPORTED);
    expect(store.getState().settings).toEqual(NEW_SETTINGS);
  });

  it('leaves the workflow’s own settings alone when the file carries none', () => {
    const store = createGraphStore();
    store.getState().hydrate([], [], OLD_SETTINGS);
    store.getState().replaceGraph(IMPORTED, []);
    expect(store.getState().settings).toEqual(OLD_SETTINGS);
  });
});
