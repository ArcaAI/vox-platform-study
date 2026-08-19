import type { ComponentType, ReactNode } from 'react';

/**
 * Mirrors `WorkflowFindingSeverity` from `@arcaai/workflow-contract`
 * (`packages/workflow-contract/src/report.ts:12`) — the composite never imports that package
 * (it is the server validator's engine, not a browser artifact; see TASK-719
 * `contracts/validation-report.contract.md`), so the two ERROR/WARNING string literals are
 * repeated here rather than shared.
 */
export type WorkflowFindingSeverity = 'ERROR' | 'WARNING';

export interface WorkflowCanvasNodeProblem {
  severity: WorkflowFindingSeverity;
  /** The `WorkflowFinding.message` strings for this node, verbatim. */
  messages: readonly string[];
}

export interface WorkflowCanvasNode {
  id: string;
  /** Registry node `type` — selects the renderer from the `nodeTypes` prop, when supplied. */
  type: string;
  label: string;
  position: { x: number; y: number };
  /**
   * Open set of registry-declared classes (`TASK-719 contracts/registry.contract.md` —
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
  /** Reserved for TASK-723's run-replay overlay (per-node status/timing/confidence badge slots). Not consumed by Studio v1. */
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
  'aria-label': string;
  className?: string;
}
