import type { ComponentType, DragEvent, ReactNode } from 'react';

/**
 * Mirrors `WorkflowFindingSeverity` from `@arcaai/workflow-contract`
 * (`packages/workflow-contract/src/report.ts:12`) — the composite never imports that package
 * (it is the server validator's engine, not a browser artifact; see
 * `contracts/validation-report.contract.md`), so the two ERROR/WARNING string literals are
 * repeated here rather than shared.
 */
export type WorkflowFindingSeverity = 'ERROR' | 'WARNING';

export interface WorkflowCanvasNodeProblem {
  severity: WorkflowFindingSeverity;
  /** The `WorkflowFinding.message` strings for this node, verbatim. */
  messages: readonly string[];
}

/**
 * One labelled BRANCH output — the only case where a node shows more than one source handle
 * (TASK-893 §3.1). `id` is the React Flow handle id AND the real wire port name (`then`, `else`,
 * `approved`, `each`, …), so an edge drawn from it already names the socket it leaves by.
 */
export interface WorkflowCanvasBranch {
  id: string;
  label: string;
}

/**
 * TASK-1036 C2b — one TYPED port: a field of the node's I/O contract drawn as its own labelled
 * handle. `id` is the React Flow handle id (the consumer's field handle, e.g. `in:message`);
 * `type` is the value type (`text`, `list<entity>`, …) and `tone` its colour family. The shape
 * also encodes the family (round = scalar, square = list, diamond = audio/file reference), so a
 * port's kind is never conveyed by colour alone.
 */
export interface WorkflowCanvasPort {
  id: string;
  label: string;
  type: string;
  tone?: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'list' | 'audio' | 'file' | 'any';
  required?: boolean;
}

/** Per-node sandbox run state, rendered as a status chip in the node header. */
export type WorkflowCanvasRunState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

/**
 * Per-link run state (TASK-1036 F2): `idle` = no data has moved (the plain edge), `done` = the
 * link carried data (recoloured through `--workflow-canvas-edge-done`), `active` = data is moving
 * over it right now (recoloured and animated, never under `prefers-reduced-motion: reduce`).
 */
export type WorkflowCanvasEdgeRunState = 'idle' | 'done' | 'active';

/** Rendered instead of a step number when a node is not linearly ordered. */
export type WorkflowCanvasStepMarker = 'cycle' | 'unreachable';

export interface WorkflowCanvasNode {
  id: string;
  /** Registry node `type` — selects the renderer from the `nodeTypes` prop, when supplied. */
  type: string;
  label: string;
  /** For a child of a group (`parentId` set), RELATIVE to the group's origin — React Flow's own convention, round-tripped verbatim. */
  position: { x: number; y: number };
  /**
   * Render the single primary TARGET handle (id `"in"`, left edge). Default `true`; `false` for a
   * graph entry node such as `core.trigger`.
   *
   * TASK-893 §3.1: the per-port handle rendering (one handle per declared socket, up to 14 on a
   * `core.action`) is gone. The canvas shows the main flow — one dot in, one dot out — and the
   * wire's real `fromPort`/`toPort` are resolved by the consumer on connect. Nothing about the
   * port contract, the compatibility lattice or the interpreter changed; only the presentation.
   */
  hasInput?: boolean;
  /** Render the single primary SOURCE handle (id `"out"`, right edge). Default `true`; `false` for a terminal node such as `core.output`. */
  hasOutput?: boolean;
  /** Extra labelled SOURCE handles stacked below the primary output. Absent/empty = primary only. */
  branches?: readonly WorkflowCanvasBranch[];
  /** TASK-1036 — typed INPUT fields. Non-empty REPLACES the primary `in` dot; absent/empty keeps it. */
  inputPorts?: readonly WorkflowCanvasPort[];
  /** TASK-1036 — typed OUTPUT fields. Non-empty REPLACES the primary `out` dot; absent/empty keeps it. */
  outputPorts?: readonly WorkflowCanvasPort[];
  /** 1-based execution order badge. `null`/absent renders no badge. */
  stepNumber?: number | null;
  /** Rendered INSTEAD of `stepNumber` when the node is not linearly ordered. */
  stepMarker?: WorkflowCanvasStepMarker;
  /** Per-node sandbox run state, rendered as a status chip in the node header. */
  runState?: WorkflowCanvasRunState;
  /** Wall time of the last run of this node, rendered beside `runState`. */
  runDurationMs?: number;
  /** How many warnings this node's run raised, spelled out beside `runState` ("2 warnings"). Zero/absent renders nothing. */
  runWarnings?: number;
  /** `group`: a container (a `core.loop` body) that other nodes nest inside via `parentId`. */
  kind?: 'node' | 'group';
  /** The enclosing group's id — the node is drawn inside it and moves with it. */
  parentId?: string;
  /** A deprecated registry type: still rendered (existing graphs must stay readable), badged as such. */
  deprecated?: boolean;
  /**
   * Open set of registry-declared classes (`contracts/registry.contract.md`
   * `WorkflowNodeClassLookup.classesOf`). A node is "mandatory" iff `'mandatory'` is a member.
   */
  safetyClasses?: readonly string[];
  problem?: WorkflowCanvasNodeProblem;
  /** Opaque per-node config the canvas never reads or validates — round-tripped verbatim. */
  config?: Record<string, unknown>;
}

export interface WorkflowCanvasEdge {
  id: string;
  source: string;
  sourceHandle?: string;
  target: string;
  targetHandle?: string;
  label?: string;
  /**
   * `wire` (default) — a connection the admin draws and deletes on the canvas.
   * `binding` — a data binding the consumer edits elsewhere (an inspector field): drawn dashed and
   * labelled so the flow stays legible, never deletable or reconnectable from the canvas.
   */
  kind?: 'wire' | 'binding';
  /** Run overlay for this link. Absent = `idle`. */
  runState?: WorkflowCanvasEdgeRunState;
}

export interface WorkflowCanvasNodeRendererProps {
  node: WorkflowCanvasNode;
  selected: boolean;
}

/** Registry-driven per-node-type inner content. The chrome (label, safety badge, problem border/description) is always supplied by the composite itself, never by these renderers. */
export type WorkflowCanvasNodeTypes = Record<string, ComponentType<WorkflowCanvasNodeRendererProps>>;

export interface WorkflowConnectRequest {
  source: string;
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
}

export interface WorkflowCanvasProps {
  nodes: readonly WorkflowCanvasNode[];
  edges: readonly WorkflowCanvasEdge[];
  /** Registry-driven inner-content renderers, keyed by node `type`. Unregistered types fall back to a label-only default. */
  nodeTypes?: WorkflowCanvasNodeTypes;
  selectedNodeId?: string | null;
  /**
   * The FULL controlled selection. React Flow supports box- and shift-select natively, but
   * `selected` is controlled here, so reporting only a primary id made the next prop sync
   * unselect everything else — the consumer could never hold more than one node. Supply this and
   * membership decides `selected`; omit it and the single `selectedNodeId` still governs, which
   * is what keeps every existing caller working unchanged.
   */
  selectedNodeIds?: readonly string[];
  readOnly?: boolean;
  /** TASK-1036 — the controlled selected EDGE (the edge inspector). */
  selectedEdgeId?: string | null;
  /** TASK-1036 — an edge was selected (`null` when the selection no longer holds one). */
  onEdgeSelect?: (edgeId: string | null) => void;
  /**
   * TASK-1036 §8.4 item 7 — `+` on an edge: a named button at the link's midpoint asks the
   * consumer to insert a step there (and re-wire it). Absent or `readOnly` = no button.
   */
  onEdgeInsert?: (edgeId: string) => void;
  /**
   * TASK-1036 §8.4 item 7 — a link dragged out of a SOURCE handle and dropped on empty canvas.
   * Reports the handle it came from and the drop point in flow coordinates, so the consumer can
   * open its add-a-step menu there and connect the new step. Never called while `readOnly`.
   */
  onConnectEndOnPane?: (from: { nodeId: string; handleId: string | null }, position: { x: number; y: number }) => void;
  /** Reserved for run-replay overlay (per-node status/timing/confidence badge slots). Not consumed by Studio v1. */
  overlay?: (node: WorkflowCanvasNode) => ReactNode;
  onNodesChange?: (nodes: WorkflowCanvasNode[]) => void;
  /**
   * Non-removal edge changes (selection, reconnection). Edge REMOVAL never comes through here —
   * it is reported once, by id, through `onEdgeDelete`, exactly as node removal is reported
   * through `onDeleteRequest` rather than through `onNodesChange`.
   */
  onEdgesChange?: (edges: WorkflowCanvasEdge[]) => void;
  /**
   * The ONE deletion channel for edges (TASK-893 §2.2). Called for BOTH the Delete/Backspace key
   * on a selected edge AND the hover-X affordance on the edge itself. The composite never removes
   * an edge on its own — the consumer decides, exactly as it does for `onDeleteRequest`.
   *
   * Absent, or `readOnly`, means edges are not deletable: the X is not rendered and the delete key
   * is disarmed.
   */
  onEdgeDelete?: (edgeId: string) => void;
  /**
   * A node was dragged into, out of, or between loop groups. `parentId` is `null` when the node
   * was dropped on the bare pane. `position` is already expressed relative to the NEW parent (or
   * to the pane when `parentId` is `null`), so the consumer stores it verbatim.
   *
   * Only fires when the parent actually CHANGED — an ordinary move inside the same parent is a
   * position change and reaches the consumer through `onNodesChange` alone.
   */
  onNodeParentChange?: (nodeId: string, parentId: string | null, position: { x: number; y: number }) => void;
  onConnect?: (connection: WorkflowConnectRequest) => void;
  /**
   * Drag-time connection guard. React Flow calls it while the pointer is still dragging, so an
   * invalid target is refused visually (the handle stops accepting the drop) rather than only
   * after `onConnect` fires and the consumer toasts a rejection. Same predicate the consumer's
   * store uses for the committed `connect`, so the two can never disagree.
   */
  isValidConnection?: (connection: WorkflowConnectRequest) => boolean;
  onSelect?: (nodeId: string | null) => void;
  /** The whole selection, alongside `onSelect`'s primary. Fires with `[]` when the pane is
   *  cleared. Needed by any multi-node command — wrapping a set of nodes in a loop, say. */
  onSelectionChange?: (nodeIds: string[]) => void;
  /** Rendered centred over an EMPTY canvas (no nodes). The composite ships no copy of its own —
   *  the consumer supplies the empty state so it can match the rest of its screen. */
  emptyState?: ReactNode;
  /** Never removes a node itself — the consumer decides (and may refuse for a `mandatory` node). */
  onDeleteRequest?: (nodeId: string) => void;
  /**
   * Drop-to-add: something was dropped on the pane. The composite contributes the ONE thing only
   * it can — the drop point projected into flow coordinates (`screenToFlowPosition`, so pan and
   * zoom are accounted for) — and hands the raw event on; what the payload MEANS is the
   * consumer's business (this composite knows nothing about node types or registries).
   *
   * Never the only way to add a node: the consumer keeps a pointer-free path (WCAG 2.5.7). Not
   * called while `readOnly`.
   */
  onPaneDrop?: (event: DragEvent<HTMLDivElement>, position: { x: number; y: number }) => void;
  /** Render the overview minimap (bottom-right). Default `true`; pass `false` for tiny embeds. */
  minimap?: boolean;
  /**
   * Re-run `fitView` when this value changes. Needed after a post-mount layout pass: the
   * boolean `fitView` prop only fits on init, which is the origin pile for graphs that
   * stored no positions.
   */
  fitViewKey?: number;
  /**
   * TASK-1036 R-C — how much of the canvas, in px from each edge, something floats over (the
   * Studio's docked palette and inspector). `fitView` fits into the rectangle that is left, so the
   * graph's ends never sit under a pane. It never moves any control: the zoom controls and the
   * minimap are anchored in a bottom-centre dock (owner, 2026-10-05). Absent = nothing floats over
   * the canvas.
   */
  viewportInsets?: WorkflowCanvasInsets;
  /**
   * TASK-1036 R-C #9 — what the mouse wheel does. `scroll` zooms the canvas (React Flow's
   * default); `modifier` lets the wheel scroll the page and zooms only with Ctrl/⌘ held (and on a
   * trackpad pinch). Default: `modifier` for a `readOnly` canvas — one embedded in a scrolling page
   * (the Test tab's Flow) must not trap the wheel — `scroll` otherwise.
   */
  wheelZoom?: 'scroll' | 'modifier';
  'aria-label': string;
  className?: string;
}

/** TASK-1036 R-C — pixels of the canvas covered from each edge. */
export interface WorkflowCanvasInsets {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}
