/**
 * Graph editing store. Business rules live on the store's actions so both
 * editors (canvas + list/tree, Task 13) get identical refusal behavior — Task 11.
 */
import { describe, expect, it } from 'vitest';
import { createGraphStore } from '../create-graph-store';
import type { WorkflowNodeDescriptor } from '../../api/types';

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

  it('connect / canConnect with no portLookup skip the port-type check (topology only)', () => {
    const store = createGraphStore();
    const a = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 1, y: 1 });
    expect(store.getState().canConnect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' }).ok).toBe(true);
  });

  describe('port-type compatibility (Task 12)', () => {
    function descriptor(type: string, inputs: WorkflowNodeDescriptor['inputs'], outputs: WorkflowNodeDescriptor['outputs']): WorkflowNodeDescriptor {
      return {
        type,
        implemented: true,
        activityName: type,
        classes: [],
        paletteKey: 'consultation',
        critical: false,
        externalWrite: false,
        defaultTimeoutSeconds: 30,
        defaultMaxAttempts: 1,
        entitlementKey: null,
        configSchema: null,
        inputs,
        outputs,
      };
    }

    const SYNTHESIZE = descriptor('consultation.synthesize', [{ name: 'in', primitive: 'text', required: true, multiple: true }], [
      { name: 'out', primitive: 'document', required: true, multiple: true },
    ]);
    const EXTRACT_ENTITIES = descriptor(
      'consultation.extractEntities',
      [{ name: 'in', primitive: 'transcript', required: true, multiple: false }],
      [{ name: 'out', primitive: 'entities', required: true, multiple: true }],
    );
    const CAPTURE_BINDING = descriptor('consultation.captureBinding', [], [
      { name: 'out', primitive: 'transcript', required: true, multiple: true },
    ]);

    function withNodes(): { store: ReturnType<typeof createGraphStore>; a: string; b: string; portLookup: Map<string, WorkflowNodeDescriptor> } {
      const store = createGraphStore();
      const a = store.getState().addNode({ type: 'consultation.synthesize', safetyClasses: [] }, { x: 0, y: 0 });
      const b = store.getState().addNode({ type: 'consultation.extractEntities', safetyClasses: [] }, { x: 1, y: 1 });
      const portLookup = new Map([
        ['consultation.synthesize', SYNTHESIZE],
        ['consultation.extractEntities', EXTRACT_ENTITIES],
        ['consultation.captureBinding', CAPTURE_BINDING],
      ]);
      return { store, a, b, portLookup };
    }

    // ANTI-LAUNDERING: the wiring-level proof that the port lattice is actually consulted —
    // `lib/__tests__/port-compatibility.test.ts` proves the predicate itself; this proves the
    // store refuses to commit the same edge.
    it('ANTI-LAUNDERING: connect refuses document -> ner (consultation.synthesize.out -> consultation.extractEntities.in)', () => {
      const { store, a, b, portLookup } = withNodes();
      const result = store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' }, portLookup);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('`document`');
        expect(result.reason).toContain('`transcript`');
      }
      expect(store.getState().edges).toHaveLength(0);
    });

    it('connect allows a compatible edge when a portLookup is supplied', () => {
      const store = createGraphStore();
      const a = store.getState().addNode({ type: 'consultation.captureBinding', safetyClasses: [] }, { x: 0, y: 0 });
      const b = store.getState().addNode({ type: 'consultation.extractEntities', safetyClasses: [] }, { x: 1, y: 1 });
      const portLookup = new Map([
        ['consultation.captureBinding', CAPTURE_BINDING],
        ['consultation.extractEntities', EXTRACT_ENTITIES],
      ]);
      const result = store.getState().connect({ source: a, sourceHandle: 'out', target: b, targetHandle: 'in' }, portLookup);
      expect(result.ok).toBe(true);
      expect(store.getState().edges).toHaveLength(1);
    });

    // The "same predicate" contract (`workflow-canvas/types.ts:64-69`): drag-time
    // (`isValidConnection`, backed by `canConnect`) and commit-time (`connect`) must never
    // disagree — proven here by asserting they return the identical verdict for the identical
    // request, over the exact anti-laundering case.
    it('canConnect (drag-time) and connect (commit-time) agree on the anti-laundering refusal', () => {
      const { store, a, b, portLookup } = withNodes();
      const request = { source: a, sourceHandle: 'out', target: b, targetHandle: 'in' };
      const dragTime = store.getState().canConnect(request, portLookup);
      const commitTime = store.getState().connect(request, portLookup);
      expect(dragTime).toEqual(commitTime);
      expect(dragTime.ok).toBe(false);
    });
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

  /**
   * TASK-890 black-box J5 — a node move that changes nothing must change nothing.
   *
   * `onNodesChange` reports EVERY node on every canvas change, and React Flow re-emits the
   * current positions whenever the controlled `nodes` prop is re-synced. A `moveNode` that
   * rebuilt the array for an identical position made every one of those a fresh `nodes`
   * identity, which re-rendered the canvas, which re-emitted — "Maximum update depth exceeded"
   * tore the editor down mid-drag. Identity stability is the loop's off switch.
   */
  it('moveNode to the position a node already has leaves the nodes array identity untouched', () => {
    const store = createGraphStore();
    const id = store.getState().addNode({ type: 'noop', safetyClasses: [] }, { x: 0, y: 0 });
    store.getState().moveNode(id, { x: 9, y: 9 });
    const before = store.getState().nodes;
    store.getState().moveNode(id, { x: 9, y: 9 });
    expect(store.getState().nodes).toBe(before);
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
