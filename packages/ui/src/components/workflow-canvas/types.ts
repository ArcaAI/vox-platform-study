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

/** One declared port on a node INSTANCE — rendered as its own handle (TASK-864 B1). */
export interface WorkflowCanvasPort {
  /** The handle id — the edge's `sourceHandle` / `targetHandle`. */
  id: string;
  /** `control` ports carry sequencing only (branch handles, `next`); everything else carries data. */
  kind: 'control' | 'data';
  /** The port primitive, verbatim (`text`, `transcript`, `context<schemaRef>`, `any`, …) — shown as the handle's title. */
  primitive: string;
  label?: string;
}

export interface WorkflowCanvasNode {
  id: string;
  /** Registry node `type` — selects the renderer from the `nodeTypes` prop, when supplied. */
  type: string;
  label: string;
  /** For a child of a group (`parentId` set), RELATIVE to the group's origin — React Flow's own convention, round-tripped verbatim. */
  position: { x: number; y: number };
  /**
   * Per-instance ports (TASK-864 B1). When present, every port renders as its OWN handle keyed by
   * `id`, so an edge lands on the socket it names; when absent the node keeps the legacy single
   * `in`/`out` pair.
   */
  ports?: { inputs: readonly WorkflowCanvasPort[]; outputs: readonly WorkflowCanvasPort[] };
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
  readOnly?: boolean;
  /** Reserved for run-replay overlay (per-node status/timing/confidence badge slots). Not consumed by Studio v1. */
  overlay?: (node: WorkflowCanvasNode) => ReactNode;
  onNodesChange?: (nodes: WorkflowCanvasNode[]) => void;
  onEdgesChange?: (edges: WorkflowCanvasEdge[]) => void;
  onConnect?: (connection: WorkflowConnectRequest) => void;
  /**
   * Drag-time connection guard. React Flow calls it while the pointer is still dragging, so an
   * invalid target is refused visually (the handle stops accepting the drop) rather than only
   * after `onConnect` fires and the consumer toasts a rejection. Same predicate the consumer's
   * store uses for the committed `connect`, so the two can never disagree.
   */
  isValidConnection?: (connection: WorkflowConnectRequest) => boolean;
  onSelect?: (nodeId: string | null) => void;
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
