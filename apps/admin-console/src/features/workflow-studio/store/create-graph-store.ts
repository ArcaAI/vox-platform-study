/**
 * The graph-editing store. Imitates the SDK's per-mount store discipline
 * (rule 08 §Store): built with `createStore` from `zustand/vanilla`, one instance per editor
 * mount, published through React context (`graph-store-provider.tsx`) — never a module
 * singleton, never exported as an object.
 *
 * Business rules live HERE, on the actions, not duplicated per editor: `deleteNode` refuses a
 * `mandatory` node and returns a reason string the canvas renders inline; `connect` refuses a
 * self-edge and a duplicate edge; `wrapInLoop` refuses a selection it cannot legally group.
 * Server data (the definition, the registry, the validation report) is NOT mirrored into this
 * store — it stays in TanStack Query (`api/hooks.ts`); this store owns only the graph a tenant
 * is actively editing, plus the Save/Discard state machine over it (TASK-893 §3.1-§3.4).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { NODE_LABEL_MAX_LENGTH, type Binding, type WorkflowSettings } from '@arcaai/workflow-contract';
import type { ActionResult, ConnectRequest, GraphStoreEdge, GraphStoreNode, SaveState } from './types';
import { checkPortCompatibility } from '../lib/port-compatibility';
import { pruneUnreachableBindings } from '../lib/binding-hygiene';
import type { WorkflowNodeDescriptor } from '../api/types';

/**
* Node-type -> descriptor lookup for the port-compatibility check. Passed
 *  in at call time, never stored as state — the registry stays in TanStack Query per this
 *  file's own header comment ("Server data ... is NOT mirrored into this store"). Optional so
 *  the topology-only tests below keep working unchanged; the Studio always supplies it. 
 */
type PortLookup = ReadonlyMap<string, WorkflowNodeDescriptor>;

export interface GraphSnapshot {
  nodes: GraphStoreNode[];
  edges: GraphStoreEdge[];
  /**
   * TASK-1036 §3.5 (D-3 / OD-5) — `graph.settings`: connections, sources and the context schema.
   * It lives INSIDE the graph JSON (checksummed, frozen at publish, exported with the graph), so
   * it rides every snapshot: undo, redo and Discard restore it with the nodes it was authored
   * beside. `undefined` = the graph carries no `settings` (legacy graphs; `effectiveSettings`
   * derives them from the trigger and output for one release).
   */
  settings?: WorkflowSettings;
}

/** One binding write the composer makes alongside a structural edit (`insertNodeOnEdge`). */
export interface BindingWrite {
  nodeId: string;
  input: string;
  /** `null` removes the binding. */
  binding: Binding | null;
}

/** What an insert-on-edge planner returns: the wiring for the new step, or why it cannot be wired. */
export type InsertPlan = { edges: ConnectRequest[]; bindings: BindingWrite[] } | { error: string };

export interface GraphState extends GraphSnapshot {
  selectedNodeId: string | null;
  /** TASK-1036 §3.6 — the inspector opens for an edge too (source/target, mapping, delete). A
   *  node and an edge are never selected at once: selecting one clears the other. */
  selectedEdgeId: string | null;
  dirty: boolean;
  saveState: SaveState;
  lastSavedVersion: number | null;
  /** The last SAVED graph — what `discard()` restores. Set by `hydrate`, `initializeGraph` and
   *  `markSaved`; `null` only before the editor has any graph at all, which is the one state in
   *  which `discard()` has nothing to revert TO and is therefore a no-op. */
  baseline: GraphSnapshot | null;
  /** Bounded undo/redo over graph-shape edits (add/delete/connect/disconnect/config edits,
   *  loop grouping) — layout-only moves are NOT pushed: position bookkeeping is not an authored
   *  change worth an undo step, even now that it marks the graph dirty (see `moveNode`). */
  undoStack: GraphSnapshot[];
  redoStack: GraphSnapshot[];
  /**
   * TASK-1036 R-C #7 — the studio's "Hide PHI" (§10.2 Privacy). VIEW state, like the selection:
   * it masks PHI-classed test-run values in the Last run tab, the picker and the `{{` completion,
   * and never dirties the graph or enters undo.
   */
  hidePhi: boolean;
}

export interface GraphActions {
  hydrate: (nodes: GraphStoreNode[], edges: GraphStoreEdge[], settings?: WorkflowSettings) => void;
  /**
   * An AUTHORED wholesale replacement (JSON import, TASK-864 B1): undoable and dirty, unlike `hydrate`.
   * `settings`, when given, replace `graph.settings` in the SAME undo step (an import is one edit);
   * `undefined` leaves the workflow's own settings alone.
   */
  replaceGraph: (nodes: GraphStoreNode[], edges: GraphStoreEdge[], settings?: WorkflowSettings) => void;
  /** Pre-places every `mandatory`-classed descriptor into a fresh graph (README Task 12: "pre-
   *  placed into a new definition's graph by the store's `initializeGraph` action"). Non-
   *  mandatory descriptors are ignored — they come from the palette rail on demand. */
  initializeGraph: (descriptors: Array<{ type: string; safetyClasses: readonly string[] }>) => void;
  /** `options.parentId` nests the new node inside a `core.loop` body (TASK-864); `position` is then relative to that group. */
  addNode: (
    descriptor: { type: string; safetyClasses: readonly string[] },
    position: { x: number; y: number },
    options?: { parentId?: string; config?: Record<string, unknown> },
  ) => string;
  /** Refuses a `mandatory` node, and Start / End by TYPE (W1) — whatever classes they carry. */
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
  /**
   * `options.binding` is the auto-mapped binding (OD-29) the composer derived for this link; it is
   * written into the target's `config.inputs` in the SAME undo step, so undoing the link undoes
   * its mapping too.
   */
  connect: (request: ConnectRequest, portLookup?: PortLookup, options?: { binding?: { input: string; binding: Binding } }) => ActionResult;
  /** Also drops the bindings that read a step which, without this link, no longer runs first. */
  disconnectEdge: (edgeId: string) => void;
  /**
   * TASK-1036 §8.4 item 7 — `+` on an edge: removes the edge, adds a step, and applies the
   * planner's wiring (edges + binding writes) as ONE undoable edit. The planner sees the draft
   * graph with the new node in it and the old edge gone, so it can auto-map both new links.
   */
  insertNodeOnEdge: (
    edgeId: string,
    descriptor: { type: string; safetyClasses: readonly string[] },
    position: { x: number; y: number },
    planner: (draft: { nodes: GraphStoreNode[]; edges: GraphStoreEdge[]; newNode: GraphStoreNode }) => InsertPlan,
    options?: { config?: Record<string, unknown> },
  ) => { ok: true; nodeId: string } | { ok: false; reason: string };
  /** OD-29 — write (or, with `null`, remove) one input binding into `config.inputs`. */
  setInputBinding: (nodeId: string, input: string, binding: Binding | null) => void;
  /** OD-20 — the node's display name; blank removes it. Refuses more than `NODE_LABEL_MAX_LENGTH`. */
  setNodeLabel: (nodeId: string, label: string) => ActionResult;
  /** §3.5 — replace `graph.settings` (undoable, dirty). */
  setSettings: (settings: WorkflowSettings | undefined) => void;
  selectEdge: (edgeId: string | null) => void;
  /**
   * TASK-893 §3.2 — creates a `core.loop` sized around `nodeIds` and re-parents them into it.
   * Refuses an empty selection, a selection containing a `mandatory` node (which includes both
   * graph boundaries: `core.trigger` and `core.output` are `mandatory`, and the contract's own
   * structural rule forbids either inside a loop body), and a selection containing a node that
   * already sits inside a group. Undoable, dirty. Returns the new loop's id on success.
   */
  wrapInLoop: (nodeIds: string[]) => ActionResult & { loopId?: string };
  /** Dissolves the loop: children are re-parented OUT of it (to the loop's own parent, i.e. the
   *  top level for an unnested loop) with their positions converted back to that scope, then the
   *  loop node and every edge touching it are removed. Undoable, dirty. */
  unwrapLoop: (loopId: string) => ActionResult;
  /** Drag into / out of / between loop groups. `parentId` null = top level. `position` is already
   *  expressed relative to the NEW parent (Contract A `onNodeParentChange`), so it is stored
   *  verbatim. Undoable, dirty. */
  setNodeParent: (nodeId: string, parentId: string | null, position: { x: number; y: number }) => void;
  selectNode: (nodeId: string | null) => void;
  /** R-C #7 — view state only: never dirty, never undoable. */
  setHidePhi: (hide: boolean) => void;
  setSaveState: (state: SaveState) => void;
  /** Reverts nodes/edges to `baseline`, clears both undo stacks and returns the machine to
   *  `clean`. A no-op when `baseline` is null. */
  discard: () => void;
  /** Clears `dirty`, records the version, and SNAPSHOTS the saved graph as the new `baseline`
   *  (which is what makes the next `discard()` revert to this save rather than to the load). */
  markSaved: (version: number) => void;
  undo: () => void;
  redo: () => void;
}

export type GraphStore = GraphState & GraphActions;
export type GraphStoreApi = StoreApi<GraphStore>;

const MANDATORY_CLASS = 'mandatory';
const UNDO_STACK_LIMIT = 50;

/**
 * W1 — the graph's entry and exit. Undeletable and single by TYPE, not only by registry class: a
 * registry that ever stopped classing them `mandatory` must not make Start or End deletable.
 */
export const BOUNDARY_NODE_TYPES: ReadonlySet<string> = new Set(['core.trigger', 'core.output']);
export const BOUNDARY_DELETE_REASON = 'Start and Output are part of every workflow and can’t be deleted.';
const BOUNDARY_DUPLICATE_REASON = 'Start and Output exist once in every workflow and can’t be duplicated.';

/** The registry type a canvas GROUP is: `wrapInLoop` creates one, and every consumer that has to
 *  decide `kind: 'group'` reads this rather than re-typing the string. */
export const LOOP_NODE_TYPE = 'core.loop';

/**
 * Inner padding a group keeps around its children. Mirrors `GROUP_PADDING` in
 * `@arcaai/ui`'s `workflow-canvas/workflow-canvas.tsx` (which is not exported): a group's extent
 * is DERIVED from its children's positions plus this padding, so placing the loop origin this
 * far up-and-left of the selection's bounding box is what makes the wrapped nodes land inside
 * the box the canvas will draw, instead of clipping through its header.
 */
const GROUP_PADDING = { x: 24, top: 56 } as const;

function isMandatory(node: Pick<GraphStoreNode, 'safetyClasses'>): boolean {
  return node.safetyClasses.includes(MANDATORY_CLASS);
}

/**
 * The `saveState` an EDIT moves the machine to. `clean`/`saved` become `dirty`; a `conflict` or
 * an `error` is deliberately NOT cleared by editing — the user resolves it by saving again or
 * discarding, and clearing it here would hide the `OccConflictAlert` behind the next keystroke.
 * A `saving` in flight belongs to `useSaveModel`, which will drive it to its own terminal state.
 */
function dirtiedSaveState(current: SaveState): SaveState {
  return current === 'clean' || current === 'saved' ? 'dirty' : current;
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
      const { nodes, edges, settings, undoStack } = get();
      const next = [...undoStack, { nodes, edges, settings }];
      set({ undoStack: next.length > UNDO_STACK_LIMIT ? next.slice(next.length - UNDO_STACK_LIMIT) : next, redoStack: [] });
    }

    /** Every mutation's dirty bookkeeping in one place, so no action can mark `dirty` without
     *  also advancing the save-state machine (they were two independent fields under autosave;
     *  since TASK-893 they are one fact reported two ways). */
    function dirtied(state: GraphState): { dirty: true; saveState: SaveState } {
      return { dirty: true, saveState: dirtiedSaveState(state.saveState) };
    }

    return {
      nodes: [],
      edges: [],
      settings: undefined,
      selectedNodeId: null,
      selectedEdgeId: null,
      dirty: false,
      saveState: 'clean',
      lastSavedVersion: null,
      baseline: null,
      undoStack: [],
      redoStack: [],
      hidePhi: false,

      setHidePhi: (hide) => set({ hidePhi: hide }),

      hydrate: (nodes, edges, settings) => {
        set({
          nodes,
          edges,
          settings,
          selectedNodeId: null,
          selectedEdgeId: null,
          dirty: false,
          saveState: 'clean',
          baseline: { nodes, edges, settings },
          undoStack: [],
          redoStack: [],
        });
      },

      replaceGraph: (nodes, edges, settings) => {
        snapshotForUndo();
        set((state) => ({ nodes, edges, ...(settings !== undefined ? { settings } : {}), selectedNodeId: null, ...dirtied(state) }));
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
        // The pre-placed set IS this graph's clean state: without a baseline here, the first edit
        // on a brand-new definition would be dirty with nothing to Discard back to.
        const { settings } = get();
        set({
          nodes,
          edges: [],
          selectedNodeId: null,
          selectedEdgeId: null,
          dirty: false,
          saveState: 'clean',
          baseline: { nodes, edges: [], settings },
          undoStack: [],
          redoStack: [],
        });
      },

      addNode: (descriptor, position, options) => {
        snapshotForUndo();
        const id = generateNodeId();
        const node: GraphStoreNode = {
          id,
          type: descriptor.type,
          position,
          safetyClasses: descriptor.safetyClasses,
          config: options?.config ? { ...options.config } : {},
          ...(options?.parentId ? { parentId: options.parentId } : {}),
        };
        set((state) => ({ nodes: [...state.nodes, node], ...dirtied(state) }));
        return id;
      },

      deleteNode: (nodeId) => {
        const node = get().nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return { ok: false, reason: 'Node not found.' };
        if (BOUNDARY_NODE_TYPES.has(node.type)) return { ok: false, reason: BOUNDARY_DELETE_REASON };
        if (isMandatory(node)) return { ok: false, reason: 'This node type is mandatory for the palette and cannot be deleted.' };
        snapshotForUndo();
        // A loop body goes with its loop (TASK-864): children naming this node as parent are
        // removed too, so no orphan is ever left pointing at a group that no longer exists.
        // (`unwrapLoop` is the action that KEEPS the children — deleting a loop deletes its body.)
        const removed = new Set<string>([nodeId, ...get().nodes.filter((candidate) => candidate.parentId === nodeId).map((candidate) => candidate.id)]);
        set((state) => {
          const edges = state.edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target));
          return {
            nodes: pruneUnreachableBindings(
              state.nodes.filter((candidate) => !removed.has(candidate.id)),
              edges,
            ),
            edges,
            selectedNodeId: state.selectedNodeId !== null && removed.has(state.selectedNodeId) ? null : state.selectedNodeId,
            selectedEdgeId: state.selectedEdgeId !== null && edges.some((edge) => edge.id === state.selectedEdgeId) ? state.selectedEdgeId : null,
            ...dirtied(state),
          };
        });
        return { ok: true };
      },

      updateNodeConfig: (nodeId, config) => {
        snapshotForUndo();
        set((state) => ({
          nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, config } : node)),
          ...dirtied(state),
        }));
      },

      duplicateNode: (nodeId) => {
        const node = get().nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return { ok: false, reason: 'Node not found.' };
        if (BOUNDARY_NODE_TYPES.has(node.type)) return { ok: false, reason: BOUNDARY_DUPLICATE_REASON };
        if (isMandatory(node)) return { ok: false, reason: 'This node type is mandatory and exists only once — it cannot be duplicated.' };
        snapshotForUndo();
        const copy: GraphStoreNode = {
          ...node,
          id: generateNodeId(),
          position: { x: node.position.x + 40, y: node.position.y + 60 },
          config: { ...node.config },
        };
        set((state) => ({ nodes: [...state.nodes, copy], selectedNodeId: copy.id, ...dirtied(state) }));
        return { ok: true };
      },

      // TASK-893 §3.7 — a move now marks the graph DIRTY. It deliberately did not while the
      // Studio autosaved: layout rode along on whatever PATCH the debounce sent next, so nothing
      // was lost by leaving it clean. With autosave replaced by an explicit Save/Discard, a move
      // that never marks dirty is a move the user silently loses — Save stays disabled and the
      // new position is thrown away on reload. It still pushes NO undo step: position bookkeeping
      // is not an authored change worth an undo slot (see `GraphState.undoStack`).
      //
      // A move to the position the node already holds is not a move. `onNodesChange` reports EVERY
      // node on every canvas change, and React Flow re-emits the current positions whenever the
      // controlled `nodes` prop is re-synced — rebuilding the array for those made a fresh `nodes`
      // identity each time, which re-rendered the canvas, which re-emitted (TASK-890 black-box J5).
      // That early return is now load-bearing twice over: it also stops a re-sync from dirtying a
      // graph nobody touched.
      moveNode: (nodeId, position) => {
        const current = get().nodes.find((node) => node.id === nodeId);
        if (!current || (current.position.x === position.x && current.position.y === position.y)) return;
        set((state) => ({ nodes: state.nodes.map((node) => (node.id === nodeId ? { ...node, position } : node)), ...dirtied(state) }));
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
            { type: sourceNode.type, handle: request.sourceHandle, config: sourceNode.config },
            { type: targetNode.type, handle: request.targetHandle, config: targetNode.config },
          );
          if (!compatible.ok) return compatible;
        }
        return { ok: true };
      },

      connect: (request, portLookup, options) => {
        const allowed = get().canConnect(request, portLookup);
        if (!allowed.ok) return allowed;
        snapshotForUndo();
        const edge: GraphStoreEdge = { id: generateEdgeId(), ...request };
        const binding = options?.binding;
        set((state) => ({
          edges: [...state.edges, edge],
          nodes: binding ? withBinding(state.nodes, request.target, binding.input, binding.binding) : state.nodes,
          ...dirtied(state),
        }));
        return { ok: true };
      },

      disconnectEdge: (edgeId) => {
        if (!get().edges.some((edge) => edge.id === edgeId)) return;
        snapshotForUndo();
        set((state) => {
          const edges = state.edges.filter((edge) => edge.id !== edgeId);
          return {
            edges,
            nodes: pruneUnreachableBindings(state.nodes, edges),
            selectedEdgeId: state.selectedEdgeId === edgeId ? null : state.selectedEdgeId,
            ...dirtied(state),
          };
        });
      },

      insertNodeOnEdge: (edgeId, descriptor, position, planner, options) => {
        const { nodes, edges } = get();
        const edge = edges.find((candidate) => candidate.id === edgeId);
        if (!edge) return { ok: false, reason: 'That link no longer exists.' };
        const newNode: GraphStoreNode = {
          id: generateNodeId(),
          type: descriptor.type,
          position,
          safetyClasses: descriptor.safetyClasses,
          config: options?.config ? { ...options.config } : {},
        };
        const draftNodes = [...nodes, newNode];
        const draftEdges = edges.filter((candidate) => candidate.id !== edgeId);
        const plan = planner({ nodes: draftNodes, edges: draftEdges, newNode });
        if ('error' in plan) return { ok: false, reason: plan.error };
        snapshotForUndo();
        const added = plan.edges
          .filter(
            (request, index, all) =>
              all.findIndex(
                (other) =>
                  other.source === request.source &&
                  other.sourceHandle === request.sourceHandle &&
                  other.target === request.target &&
                  other.targetHandle === request.targetHandle,
              ) === index,
          )
          .map((request) => ({ id: generateEdgeId(), ...request }));
        let nextNodes = draftNodes;
        for (const write of plan.bindings) nextNodes = withBinding(nextNodes, write.nodeId, write.input, write.binding);
        const nextEdges = [...draftEdges, ...added];
        set((state) => ({
          nodes: pruneUnreachableBindings(nextNodes, nextEdges),
          edges: nextEdges,
          selectedNodeId: newNode.id,
          selectedEdgeId: null,
          ...dirtied(state),
        }));
        return { ok: true, nodeId: newNode.id };
      },

      setInputBinding: (nodeId, input, binding) => {
        const { nodes } = get();
        const next = withBinding(nodes, nodeId, input, binding);
        if (next === nodes) return;
        snapshotForUndo();
        set((state) => ({ nodes: next, ...dirtied(state) }));
      },

      setNodeLabel: (nodeId, label) => {
        const node = get().nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return { ok: false, reason: 'Node not found.' };
        const trimmed = label.trim();
        if (trimmed.length > NODE_LABEL_MAX_LENGTH) {
          return { ok: false, reason: `A step name can be at most ${NODE_LABEL_MAX_LENGTH} characters.` };
        }
        const current = typeof node.config.label === 'string' ? node.config.label : '';
        if (current === trimmed) return { ok: true };
        const { label: _previous, ...rest } = node.config;
        const config = trimmed.length > 0 ? { ...rest, label: trimmed } : rest;
        snapshotForUndo();
        set((state) => ({ nodes: state.nodes.map((candidate) => (candidate.id === nodeId ? { ...candidate, config } : candidate)), ...dirtied(state) }));
        return { ok: true };
      },

      setSettings: (settings) => {
        snapshotForUndo();
        set((state) => ({ settings, ...dirtied(state) }));
      },

      selectEdge: (edgeId) => set((state) => ({ selectedEdgeId: edgeId, selectedNodeId: edgeId === null ? state.selectedNodeId : null })),

      wrapInLoop: (nodeIds) => {
        const { nodes } = get();
        const unique = [...new Set(nodeIds)];
        if (unique.length === 0) return { ok: false, reason: 'Select at least one node to wrap in a loop.' };
        const selected: GraphStoreNode[] = [];
        for (const id of unique) {
          const node = nodes.find((candidate) => candidate.id === id);
          if (!node) return { ok: false, reason: 'Node not found.' };
          selected.push(node);
        }
        if (selected.some((node) => isMandatory(node))) {
          // `core.trigger` and `core.output` are both `mandatory`, and the contract refuses either
          // inside a loop body ("the boundaries belong to the graph, not to an iteration" —
          // `core-contract.ts`), so this one check covers the structural rule as well.
          return { ok: false, reason: 'A mandatory node cannot be wrapped in a loop.' };
        }
        // The loop is NEW, so any parent a selected node already has is by definition a different
        // one. Re-wrapping a body node would also break the contract's body-boundary edge rule
        // (a body node may only be entered from its own loop's `each` handle).
        if (selected.some((node) => node.parentId !== undefined)) {
          return { ok: false, reason: 'One or more of these nodes is already inside a loop.' };
        }

        snapshotForUndo();
        const originX = Math.min(...selected.map((node) => node.position.x)) - GROUP_PADDING.x;
        const originY = Math.min(...selected.map((node) => node.position.y)) - GROUP_PADDING.top;
        const loopId = generateNodeId();
        const loop: GraphStoreNode = {
          id: loopId,
          type: LOOP_NODE_TYPE,
          position: { x: originX, y: originY },
          // The registry's own classes for `core.loop` are `['loop']`; they are joined back in on
          // the next hydrate. None of them is `mandatory`, so an empty set here changes no store
          // rule and cannot drift from a registry this store deliberately does not hold.
          safetyClasses: [],
          config: {},
        };
        const wrapped = new Set(unique);
        set((state) => ({
          // React Flow requires a parent to precede its children; the canvas re-sorts anyway
          // (`parentsFirst`), but keeping the loop ahead of its body here means every consumer
          // sees a well-formed array.
          nodes: [
            loop,
            ...state.nodes.map((node) =>
              wrapped.has(node.id)
                ? { ...node, parentId: loopId, position: { x: node.position.x - originX, y: node.position.y - originY } }
                : node,
            ),
          ],
          selectedNodeId: loopId,
          ...dirtied(state),
        }));
        // Edges that now cross the new body boundary are left EXACTLY as authored. Publish
        // validation reports them by id (`core-contract.ts`'s body-boundary rule) and the user
        // rewires them; silently deleting a wire the user drew would be a worse answer than a
        // finding they can see.
        return { ok: true, loopId };
      },

      unwrapLoop: (loopId) => {
        const { nodes } = get();
        const loop = nodes.find((candidate) => candidate.id === loopId);
        if (!loop) return { ok: false, reason: 'Node not found.' };
        if (loop.type !== LOOP_NODE_TYPE) return { ok: false, reason: 'Only a loop can be unwrapped.' };
        snapshotForUndo();
        set((state) => ({
          nodes: state.nodes
            .filter((node) => node.id !== loopId)
            .map((node) => {
              if (node.parentId !== loopId) return node;
              // A child's position is relative to the loop, so its position in the loop's OWN
              // scope is the sum. When the loop is itself unnested that scope is the canvas,
              // which is what makes this the absolute position; when it is nested, the child
              // inherits the grandparent and the same sum is correct there too.
              const position = { x: loop.position.x + node.position.x, y: loop.position.y + node.position.y };
              return loop.parentId ? { ...node, parentId: loop.parentId, position } : { ...withoutParent(node), position };
            }),
          edges: state.edges.filter((edge) => edge.source !== loopId && edge.target !== loopId),
          selectedNodeId: state.selectedNodeId === loopId ? null : state.selectedNodeId,
          ...dirtied(state),
        }));
        return { ok: true };
      },

      setNodeParent: (nodeId, parentId, position) => {
        const { nodes } = get();
        const node = nodes.find((candidate) => candidate.id === nodeId);
        if (!node) return;
        // A node cannot contain itself, directly or through its own descendants — either would
        // make the canvas recurse and the compiler's `loops[].body` lift never terminate.
        if (parentId !== null && (parentId === nodeId || isDescendantOf(nodes, parentId, nodeId))) return;
        const samePlace = (node.parentId ?? null) === parentId && node.position.x === position.x && node.position.y === position.y;
        if (samePlace) return;
        snapshotForUndo();
        set((state) => ({
          nodes: state.nodes.map((candidate) => {
            if (candidate.id !== nodeId) return candidate;
            return parentId === null ? { ...withoutParent(candidate), position } : { ...candidate, parentId, position };
          }),
          ...dirtied(state),
        }));
      },

      selectNode: (nodeId) => set((state) => ({ selectedNodeId: nodeId, selectedEdgeId: nodeId === null ? state.selectedEdgeId : null })),
      setSaveState: (state) => set({ saveState: state }),

      discard: () => {
        const { baseline } = get();
        if (!baseline) return;
        const alive = new Set(baseline.nodes.map((node) => node.id));
        set((state) => ({
          nodes: baseline.nodes,
          edges: baseline.edges,
          settings: baseline.settings,
          // A node created since the last save no longer exists after a discard; leaving it
          // selected would render an inspector for a ghost.
          selectedNodeId: state.selectedNodeId !== null && alive.has(state.selectedNodeId) ? state.selectedNodeId : null,
          selectedEdgeId: state.selectedEdgeId !== null && baseline.edges.some((edge) => edge.id === state.selectedEdgeId) ? state.selectedEdgeId : null,
          dirty: false,
          saveState: 'clean',
          undoStack: [],
          redoStack: [],
        }));
      },

      markSaved: (version) => {
        const { nodes, edges, settings } = get();
        set({ dirty: false, lastSavedVersion: version, saveState: 'saved', baseline: { nodes, edges, settings } });
      },

      undo: () => {
        const { undoStack, nodes, edges, settings } = get();
        if (undoStack.length === 0) return;
        const previous = undoStack[undoStack.length - 1];
        set((state) => ({
          nodes: previous.nodes,
          edges: previous.edges,
          settings: previous.settings,
          undoStack: undoStack.slice(0, -1),
          redoStack: [...state.redoStack, { nodes, edges, settings }],
          ...dirtied(state),
        }));
      },

      redo: () => {
        const { redoStack, nodes, edges, settings } = get();
        if (redoStack.length === 0) return;
        const next = redoStack[redoStack.length - 1];
        set((state) => ({
          nodes: next.nodes,
          edges: next.edges,
          settings: next.settings,
          redoStack: redoStack.slice(0, -1),
          undoStack: [...state.undoStack, { nodes, edges, settings }],
          ...dirtied(state),
        }));
      },
    };
  });
}

/**
 * `nodes` with `binding` written to (or, for `null`, removed from) `config.inputs[input]` of
 * `nodeId`. The SAME array back when nothing changes. An emptied `inputs` map is removed, never
 * left as `{}` (an absent map and an empty one mean the same thing; only one should be stored).
 */
function withBinding(nodes: GraphStoreNode[], nodeId: string, input: string, binding: Binding | null): GraphStoreNode[] {
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) return nodes;
  const node = nodes[index] as GraphStoreNode;
  const raw = node.config.inputs;
  const current: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (binding === null && !(input in current)) return nodes;
  if (binding !== null && JSON.stringify(current[input]) === JSON.stringify(binding)) return nodes;
  const { [input]: _previous, ...others } = current;
  const inputs = binding === null ? others : { ...others, [input]: binding };
  const { inputs: _inputs, ...rest } = node.config;
  const config = Object.keys(inputs).length > 0 ? { ...rest, inputs } : rest;
  const next = nodes.slice();
  next[index] = { ...node, config };
  return next;
}

/** The same node with the `parentId` KEY absent — not present-and-`undefined`, so a graph
 *  serialized straight after a drag-to-top-level never carries a `parentId: undefined` through
 *  `toWorkflowGraph`. */
function withoutParent(node: GraphStoreNode): GraphStoreNode {
  return { id: node.id, type: node.type, position: node.position, safetyClasses: node.safetyClasses, config: node.config };
}

/** Is `candidateId` inside `ancestorId`'s subtree? Walks `parentId` upward, bounded by the node
 *  count so a corrupt graph carrying a parent cycle cannot spin here. */
function isDescendantOf(nodes: readonly GraphStoreNode[], candidateId: string, ancestorId: string): boolean {
  let cursor: GraphStoreNode | undefined = nodes.find((node) => node.id === candidateId);
  for (let hops = 0; cursor !== undefined && hops <= nodes.length; hops += 1) {
    const parentId: string | undefined = cursor.parentId;
    if (parentId === undefined) return false;
    if (parentId === ancestorId) return true;
    cursor = nodes.find((node) => node.id === parentId);
  }
  return false;
}
