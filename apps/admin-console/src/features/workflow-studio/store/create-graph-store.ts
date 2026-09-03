/**
 * The graph-editing store. Imitates the SDK's per-mount store discipline
 * (rule 08 §Store): built with `createStore` from `zustand/vanilla`, one instance per editor
 * mount, published through React context (`graph-store-provider.tsx`) — never a module
 * singleton, never exported as an object.
 *
 * Business rules live HERE, on the actions, not duplicated per editor: `deleteNode` refuses a
 * `mandatory` node and returns a reason string both the canvas and the list/tree editor render
 * identically; `connect` refuses a self-edge and a duplicate edge. Server data (the definition,
 * the registry, the validation report) is NOT mirrored into this store — it stays in TanStack
 * Query (`api/hooks.ts`); this store owns only the graph a tenant is actively editing.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ActionResult, AutosaveState, ConnectRequest, GraphStoreEdge, GraphStoreNode, WorkflowStudioViewMode } from './types';
import { checkPortCompatibility } from '../lib/port-compatibility';
import type { WorkflowNodeDescriptor } from '../api/types';

/**
* Node-type -> descriptor lookup for the port-compatibility check. Passed
 *  in at call time, never stored as state — the registry stays in TanStack Query per this
 *  file's own header comment ("Server data ... is NOT mirrored into this store"). Optional so
 *  the topology-only tests below keep working unchanged; the Studio always supplies it. 
 */
type PortLookup = ReadonlyMap<string, WorkflowNodeDescriptor>;

interface GraphSnapshot {
  nodes: GraphStoreNode[];
  edges: GraphStoreEdge[];
}

export interface GraphState extends GraphSnapshot {
  selectedNodeId: string | null;
  viewMode: WorkflowStudioViewMode;
  dirty: boolean;
  lastSavedVersion: number | null;
  autosaveState: AutosaveState;
  /** Bounded undo/redo over graph-shape edits (add/delete/connect/disconnect/config edits) —
   *  layout-only moves are NOT pushed (README Task 11: position bookkeeping isn't an authored
   *  change worth an undo step). */
  undoStack: GraphSnapshot[];
  redoStack: GraphSnapshot[];
}

export interface GraphActions {
  hydrate: (nodes: GraphStoreNode[], edges: GraphStoreEdge[]) => void;
  /** Pre-places every `mandatory`-classed descriptor into a fresh graph (README Task 12: "pre-
   *  placed into a new definition's graph by the store's `initializeGraph` action"). Non-
   *  mandatory descriptors are ignored — they come from the palette rail on demand. */
  initializeGraph: (descriptors: Array<{ type: string; safetyClasses: readonly string[] }>) => void;
  addNode: (descriptor: { type: string; safetyClasses: readonly string[] }, position: { x: number; y: number }) => string;
  deleteNode: (nodeId: string) => ActionResult;
  updateNodeConfig: (nodeId: string, config: Record<string, unknown>) => void;
  /** Copies a node's type/classes/config into a NEW node offset below the original. Refuses a
   *  `mandatory` node: those are singletons pre-placed by `initializeGraph`, so a second copy
   *  would only ever be a validation error. Edges are NOT copied — a duplicate's wiring is an
   *  authoring decision, and silently re-pointing edges would be a guess. */
  duplicateNode: (nodeId: string) => ActionResult;
  moveNode: (nodeId: string, position: { x: number; y: number }) => void;
  /**
* Pure predicate behind `connect` — the SAME rules, evaluated without mutating, so the
   *  canvas can refuse an invalid connection while the pointer is still dragging (React Flow
   *  `isValidConnection`) instead of only after the drop. `portLookup`, when supplied, adds the
   * port-type check (topology rules alone otherwise) — `connect` forwards it to this
   *  SAME function, which is what keeps drag-time and commit-time from ever disagreeing. 
 */
  canConnect: (request: ConnectRequest, portLookup?: PortLookup) => ActionResult;
  connect: (request: ConnectRequest, portLookup?: PortLookup) => ActionResult;
  disconnectEdge: (edgeId: string) => void;
  /** List-editor-only reorder ("move up/down" buttons, never drag — README Task 13: "satisfying
   *  2.5.7 by construction rather than by adding a keyboard shim to a drag interaction"). Swaps
   *  the node's position in the `nodes` array, which is the list editor's row/tab order; it does
   *  not touch canvas `position` or mark the graph dirty (pure display-order bookkeeping, same
   *  posture as `moveNode`). */
  reorderNode: (nodeId: string, direction: 'up' | 'down') => void;
  selectNode: (nodeId: string | null) => void;
  setViewMode: (mode: WorkflowStudioViewMode) => void;
  setAutosaveState: (state: AutosaveState) => void;
  markSaved: (version: number) => void;
  undo: () => void;
  redo: () => void;
}

export type GraphStore = GraphState & GraphActions;
export type GraphStoreApi = StoreApi<GraphStore>;

const MANDATORY_CLASS = 'mandatory';
const UNDO_STACK_LIMIT = 50;

function isMandatory(node: Pick<GraphStoreNode, 'safetyClasses'>): boolean {
  return node.safetyClasses.includes(MANDATORY_CLASS);
}

let nodeSequence = 0;
function generateNodeId(): string {
  nodeSequence += 1;
  return `node_${Date.now().toString(36)}_${nodeSequence}`;
}
let edgeSequence = 0;
function generateEdgeId(): string {
  edgeSequence += 1;
  return `edge_${Date.now().toString(36)}_${edgeSequence}`;
}

export function createGraphStore(): GraphStoreApi {
  return createStore<GraphStore>((set, get) => {
    /** Pushes the CURRENT (pre-mutation) snapshot onto the undo stack and clears redo — the
     *  standard "new edit invalidates the redo branch" rule. */
    function snapshotForUndo(): void {
      const { nodes, edges, undoStack } = get();
      const next = [...undoStack, { nodes, edges }];
      set({ undoStack: next.length > UNDO_STACK_LIMIT ? next.slice(next.length - UNDO_STACK_LIMIT) : next, redoStack: [] });
    }

    return {
      nodes: [],
      edges: [],
      selectedNodeId: null,
      viewMode: 'canvas',
      dirty: false,
      lastSavedVersion: null,
      autosaveState: 'idle',
      undoStack: [],
      redoStack: [],

      hydrate: (nodes, edges) => {
        set({ nodes, edges, selectedNodeId: null, dirty: false, undoStack: [], redoStack: [], autosaveState: 'idle' });
      },

      initializeGraph: (descriptors) => {
        const mandatory = descriptors.filter((descriptor) => descriptor.safetyClasses.includes(MANDATORY_CLASS));
        const nodes: GraphStoreNode[] = mandatory.map((descriptor, index) => ({
          id: generateNodeId(),
          type: descriptor.type,
          position: { x: 80, y: 80 + index * 120 },
          safetyClasses: descriptor.safetyClasses,
          config: {},
        }));
        set({ nodes, edges: [], selectedNodeId: null, dirty: false, undoStack: [], redoStack: [] });
      },

      addNode: (descriptor, position) => {
        snapshotForUndo();
        const id = generateNodeId();
        const node: GraphStoreNode = { id, type: descriptor.type, position, safetyClasses: descriptor.safetyClasses, config: {} };
        set((state) => ({ nodes: [...state.nodes, node], dirty: true }));
        return id;
      },

      deleteNode: (nodeId) => {
        const node = get().nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return { ok: false, reason: 'Node not found.' };
        if (isMandatory(node)) return { ok: false, reason: 'This node type is mandatory for the palette and cannot be deleted.' };
        snapshotForUndo();
        set((state) => ({
          nodes: state.nodes.filter((candidate) => candidate.id !== nodeId),
          edges: state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
          selectedNodeId: state.selectedNodeId === nodeId ? null : state.selectedNodeId,
          dirty: true,
        }));
        return { ok: true };
      },

      updateNodeConfig: (nodeId, config) => {
        snapshotForUndo();
        set((state) => ({
          nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node)),
          dirty: true,
        }));
      },

      duplicateNode: (nodeId) => {
        const node = get().nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return { ok: false, reason: 'Node not found.' };
        if (isMandatory(node)) return { ok: false, reason: 'This node type is mandatory and exists only once — it cannot be duplicated.' };
        snapshotForUndo();
        const copy: GraphStoreNode = {
          ...node,
          id: generateNodeId(),
          position: { x: node.position.x + 40, y: node.position.y + 60 },
          config: { ...node.config },
        };
        set((state) => ({ nodes: [...state.nodes, copy], selectedNodeId: copy.id, dirty: true }));
        return { ok: true };
      },

      // Layout is client-only bookkeeping (definition-api.contract.md: `WorkflowGraphNode` has
      // no server-side position field) — moving a node does NOT mark the graph dirty or push an
      // undo step, so dragging nodes around never triggers an autosave PATCH by itself.
      moveNode: (nodeId, position) => {
        set((state) => ({ nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)) }));
      },

      canConnect: (request, portLookup) => {
        if (request.source === request.target) return { ok: false, reason: 'A node cannot connect to itself.' };
        const { edges, nodes } = get();
        const sourceNode = nodes.find((node) => node.id === request.source);
        const targetNode = nodes.find((node) => node.id === request.target);
        if (!sourceNode || !targetNode) {
          return { ok: false, reason: 'Both endpoints must exist on the graph.' };
        }
        const duplicate = edges.some(
          (edge) =>
            edge.source === request.source &&
            edge.sourceHandle === request.sourceHandle &&
            edge.target === request.target &&
            edge.targetHandle === request.targetHandle,
        );
        if (duplicate) return { ok: false, reason: 'This connection already exists (duplicate edge).' };
        if (portLookup) {
          const compatible = checkPortCompatibility(
            portLookup,
            { type: sourceNode.type, handle: request.sourceHandle },
            { type: targetNode.type, handle: request.targetHandle },
          );
          if (!compatible.ok) return compatible;
        }
        return { ok: true };
      },

      connect: (request, portLookup) => {
        const allowed = get().canConnect(request, portLookup);
        if (!allowed.ok) return allowed;
        snapshotForUndo();
        const edge: GraphStoreEdge = { id: generateEdgeId(), ...request };
        set((state) => ({ edges: [...state.edges, edge], dirty: true }));
        return { ok: true };
      },

      reorderNode: (nodeId, direction) => {
        const { nodes } = get();
        const index = nodes.findIndex((node) => node.id === nodeId);
        const swapWith = direction === 'up' ? index - 1 : index + 1;
        if (index === -1 || swapWith < 0 || swapWith >= nodes.length) return;
        const next = [...nodes];
        [next[index], next[swapWith]] = [next[swapWith], next[index]];
        set({ nodes: next });
      },

      disconnectEdge: (edgeId) => {
        snapshotForUndo();
        set((state) => ({ edges: state.edges.filter((edge) => edge.id !== edgeId), dirty: true }));
      },

      selectNode: (nodeId) => set({ selectedNodeId: nodeId }),
      setViewMode: (mode) => set({ viewMode: mode }),
      setAutosaveState: (state) => set({ autosaveState: state }),

      markSaved: (version) => set({ dirty: false, lastSavedVersion: version, autosaveState: 'saved' }),

      undo: () => {
        const { undoStack, nodes, edges } = get();
        if (undoStack.length === 0) return;
        const previous = undoStack[undoStack.length - 1];
        set((state) => ({
          nodes: previous.nodes,
          edges: previous.edges,
          undoStack: undoStack.slice(0, -1),
          redoStack: [...state.redoStack, { nodes, edges }],
          dirty: true,
        }));
      },

      redo: () => {
        const { redoStack, nodes, edges } = get();
        if (redoStack.length === 0) return;
        const next = redoStack[redoStack.length - 1];
        set((state) => ({
          nodes: next.nodes,
          edges: next.edges,
          redoStack: redoStack.slice(0, -1),
          undoStack: [...state.undoStack, { nodes, edges }],
          dirty: true,
        }));
      },
    };
  });
}
