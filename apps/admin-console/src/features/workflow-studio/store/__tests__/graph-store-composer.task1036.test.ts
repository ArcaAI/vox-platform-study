/**
 * TASK-1036 C2b — the composer's store actions: W1 (Start/End can't be deleted or duplicated),
 * OD-20 node labels, OD-29 bindings written into `config.inputs`, edge selection, insert-on-edge,
 * `graph.settings` (§3.5), and the binding hygiene a deleted link or step needs so the graph never
 * keeps a reference to a step that no longer runs before the reader.
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore } from '../create-graph-store';

const TRIGGER = { type: 'core.trigger', safetyClasses: ['mandatory'] as readonly string[] };
const OUTPUT = { type: 'core.output', safetyClasses: ['mandatory'] as readonly string[] };
const AGENT = { type: 'core.agent', safetyClasses: [] as readonly string[] };
// A boundary type that a stale registry forgot to class as mandatory is STILL undeletable (W1).
const UNCLASSED_TRIGGER = { type: 'core.trigger', safetyClasses: [] as readonly string[] };

describe('W1 — Start and End are part of every workflow', () => {
  it('refuses to delete core.trigger / core.output by TYPE, with the reason the inspector shows', () => {
    const store = createGraphStore();
    const start = store.getState().addNode(UNCLASSED_TRIGGER, { x: 0, y: 0 });
    const end = store.getState().addNode(OUTPUT, { x: 0, y: 0 });
    const refusedStart = store.getState().deleteNode(start);
    const refusedEnd = store.getState().deleteNode(end);
    expect(refusedStart.ok).toBe(false);
    expect(refusedEnd.ok).toBe(false);
    expect(!refusedStart.ok && refusedStart.reason).toMatch(/can.t be deleted/);
    expect(store.getState().nodes).toHaveLength(2);
  });

  it('refuses to duplicate a boundary node', () => {
    const store = createGraphStore();
    const start = store.getState().addNode(TRIGGER, { x: 0, y: 0 });
    expect(store.getState().duplicateNode(start).ok).toBe(false);
  });
});

describe('OD-20 — node labels', () => {
  it('sets, trims and clears a label as one undoable edit', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(AGENT, { x: 0, y: 0 });
    expect(store.getState().setNodeLabel(id, '  Draft SOAP note ')).toEqual({ ok: true });
    expect(store.getState().nodes[0].config.label).toBe('Draft SOAP note');
    store.getState().setNodeLabel(id, '   ');
    expect('label' in store.getState().nodes[0].config).toBe(false);
    store.getState().undo();
    expect(store.getState().nodes[0].config.label).toBe('Draft SOAP note');
  });

  it('refuses a label longer than NODE_LABEL_MAX_LENGTH', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const result = store.getState().setNodeLabel(id, 'x'.repeat(81));
    expect(result.ok).toBe(false);
    expect('label' in store.getState().nodes[0].config).toBe(false);
  });
});

describe('OD-29 — bindings live in config.inputs', () => {
  it('writes, replaces and removes one input binding; an empty map leaves no `inputs` key', () => {
    const store = createGraphStore();
    const id = store.getState().addNode(AGENT, { x: 0, y: 0 });
    store.getState().setInputBinding(id, 'message', { from: 'context.message' });
    expect(store.getState().nodes[0].config.inputs).toEqual({ message: { from: 'context.message' } });
    store.getState().setInputBinding(id, 'message', { value: 'hello' });
    expect(store.getState().nodes[0].config.inputs).toEqual({ message: { value: 'hello' } });
    store.getState().setInputBinding(id, 'message', null);
    expect('inputs' in store.getState().nodes[0].config).toBe(false);
    expect(store.getState().dirty).toBe(true);
  });

  it('connect can carry the auto-mapped binding in the SAME undo step', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const b = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const result = store
      .getState()
      .connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' }, undefined, { binding: { input: 'message', binding: { from: `nodes.${a}.outputs.text` } } });
    expect(result.ok).toBe(true);
    expect(store.getState().edges).toHaveLength(1);
    expect(store.getState().nodes[1].config.inputs).toEqual({ message: { from: `nodes.${a}.outputs.text` } });
    store.getState().undo();
    expect(store.getState().edges).toHaveLength(0);
    expect('inputs' in store.getState().nodes[1].config).toBe(false);
  });

  it('disconnecting the only link drops the bindings that now read a step that no longer runs first', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const b = store.getState().addNode(AGENT, { x: 0, y: 0 });
    store
      .getState()
      .connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' }, undefined, { binding: { input: 'message', binding: { from: `nodes.${a}.outputs.text` } } });
    store.getState().setInputBinding(b, 'context', { from: 'context.patient' });
    const edgeId = store.getState().edges[0].id;
    store.getState().disconnectEdge(edgeId);
    expect(store.getState().nodes[1].config.inputs).toEqual({ context: { from: 'context.patient' } });
  });

  it('deleting a step trims it out of a firstOf binding, collapsing to a from when one path is left', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const b = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const c = store.getState().addNode(AGENT, { x: 0, y: 0 });
    store.getState().connect({ source: a, sourceHandle: 'out', target: c, targetHandle: 'in' });
    store.getState().connect({ source: b, sourceHandle: 'next', target: c, targetHandle: 'after' });
    store.getState().setInputBinding(c, 'message', { firstOf: [`nodes.${a}.outputs.text`, `nodes.${b}.outputs.text`] });
    store.getState().deleteNode(b);
    expect(store.getState().nodes.find((node) => node.id === c)?.config.inputs).toEqual({ message: { from: `nodes.${a}.outputs.text` } });
  });
});

describe('edge selection', () => {
  it('selecting an edge clears the node selection and vice versa; deleting the edge clears it', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const b = store.getState().addNode(AGENT, { x: 0, y: 0 });
    store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    const edgeId = store.getState().edges[0].id;
    store.getState().selectNode(a);
    store.getState().selectEdge(edgeId);
    expect(store.getState().selectedNodeId).toBeNull();
    expect(store.getState().selectedEdgeId).toBe(edgeId);
    store.getState().selectNode(b);
    expect(store.getState().selectedEdgeId).toBeNull();
    store.getState().selectEdge(edgeId);
    store.getState().disconnectEdge(edgeId);
    expect(store.getState().selectedEdgeId).toBeNull();
  });
});

describe('insertNodeOnEdge', () => {
  it('removes the link, adds the step and the planner`s wiring as ONE undo step', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const b = store.getState().addNode(AGENT, { x: 0, y: 0 });
    store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    const edgeId = store.getState().edges[0].id;

    const result = store.getState().insertNodeOnEdge(edgeId, AGENT, { x: 5, y: 5 }, ({ newNode }) => ({
      edges: [
        { source: a, sourceHandle: 'out', target: newNode.id, targetHandle: 'in' },
        { source: newNode.id, sourceHandle: 'out', target: b, targetHandle: 'in' },
      ],
      bindings: [{ nodeId: b, input: 'message', binding: { from: `nodes.${newNode.id}.outputs.text` } }],
    }));
    expect(result.ok).toBe(true);
    const inserted = result.ok ? result.nodeId : '';
    expect(store.getState().nodes.map((node) => node.id)).toContain(inserted);
    expect(store.getState().edges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([`${a}->${inserted}`, `${inserted}->${b}`].sort());
    expect(store.getState().nodes.find((node) => node.id === b)?.config.inputs).toEqual({ message: { from: `nodes.${inserted}.outputs.text` } });
    expect(store.getState().selectedNodeId).toBe(inserted);

    store.getState().undo();
    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().edges).toHaveLength(1);
  });

  it('refuses an unknown edge and a planner error without touching the graph', () => {
    const store = createGraphStore();
    const a = store.getState().addNode(AGENT, { x: 0, y: 0 });
    const b = store.getState().addNode(AGENT, { x: 0, y: 0 });
    store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' });
    expect(store.getState().insertNodeOnEdge('ghost', AGENT, { x: 0, y: 0 }, () => ({ edges: [], bindings: [] })).ok).toBe(false);
    const refused = store.getState().insertNodeOnEdge(store.getState().edges[0].id, AGENT, { x: 0, y: 0 }, () => ({ error: 'no fit' }));
    expect(refused).toEqual({ ok: false, reason: 'no fit' });
    expect(store.getState().nodes).toHaveLength(2);
    expect(store.getState().undoStack).toHaveLength(3);
  });
});

describe('addNode with a preset config', () => {
  it('starts the node with the preset config (the Merge preset)', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'core.data', safetyClasses: [] }, { x: 0, y: 0 }, { config: { label: 'Merge', mappings: [{ from: 'in', to: 'text' }] } });
    expect(store.getState().nodes.find((node) => node.id === id)?.config).toEqual({ label: 'Merge', mappings: [{ from: 'in', to: 'text' }] });
  });
});

describe('graph.settings (§3.5)', () => {
  it('hydrates, edits (undoable, dirty) and discards settings with the graph', () => {
    const store = createGraphStore();
    store.getState().hydrate([], [], { connections: ['api'], sources: ['consultation'] });
    expect(store.getState().settings).toEqual({ connections: ['api'], sources: ['consultation'] });
    expect(store.getState().dirty).toBe(false);

    store.getState().setSettings({ connections: ['api', 'sse'], sources: ['consultation'] });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().settings?.connections).toEqual(['api', 'sse']);

    store.getState().undo();
    expect(store.getState().settings?.connections).toEqual(['api']);
    store.getState().redo();
    store.getState().discard();
    expect(store.getState().settings?.connections).toEqual(['api']);
  });

  it('markSaved makes the current settings the new baseline', () => {
    const store = createGraphStore();
    store.getState().hydrate([], []);
    expect(store.getState().settings).toBeUndefined();
    store.getState().setSettings({ connections: ['api'], sources: [] });
    store.getState().markSaved(2);
    store.getState().setSettings({ connections: [], sources: [] });
    store.getState().discard();
    expect(store.getState().settings).toEqual({ connections: ['api'], sources: [] });
  });
});
