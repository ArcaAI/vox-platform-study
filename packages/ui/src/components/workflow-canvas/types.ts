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

/** Per-node sandbox run state, rendered as a status chip in the node header. */
export type WorkflowCanvasRunState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

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
  /** 1-based execution order badge. `null`/absent renders no badge. */
  stepNumber?: number | null;
  /** Rendered INSTEAD of `stepNumber` when the node is not linearly ordered. */
  stepMarker?: WorkflowCanvasStepMarker;
  /** Per-node sandbox run state, rendered as a status chip in the node header. */
  runState?: WorkflowCanvasRunState;
  /** Wall time of the last run of this node, rendered beside `runState`. */
  runDurationMs?: number;
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
  'aria-label': string;
  className?: string;
}
