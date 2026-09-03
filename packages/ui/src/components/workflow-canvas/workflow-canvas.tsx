'use client';

import * as React from 'react';
import type { Connection, Edge, Node, NodeChange, NodeDimensionChange } from '@xyflow/react';
import { Background, BackgroundVariant, ReactFlow, applyEdgeChanges, applyNodeChanges } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { cn } from '@/lib/utils';

import { CanvasControls } from './canvas-controls';
import './canvas-tokens.css';
import { XYFLOW_EDGE_TYPES } from './workflow-edge';
import { XYFLOW_NODE_TYPES, problemSummaryId } from './workflow-node';
import type { WorkflowNodeData } from './workflow-node';
import type { WorkflowCanvasEdge, WorkflowCanvasNode, WorkflowCanvasProps } from './types';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', handler);
    return () => query.removeEventListener('change', handler);
  }, []);
  return reduced;
}

function toXyNode(
  node: WorkflowCanvasNode,
  extra: {
    selected: boolean;
    readOnly: boolean;
    renderer: WorkflowNodeData['renderer'];
    onDeleteRequest: WorkflowNodeData['onDeleteRequest'];
    overlay: WorkflowNodeData['overlay'];
    measured: NodeDimensions | undefined;
  },
): Node<WorkflowNodeData> {
  return {
    id: node.id,
    type: 'workflowNode',
    position: node.position,
    // React Flow is CONTROLLED here, and `adoptUserNodes` re-reads `measured` off the user node
    // on every prop sync — a node object rebuilt without it reverts to `visibility: hidden` and
    // `fitView` never fires (nodesInitialized stays false). Measurement is viewport bookkeeping,
    // not authored graph data, so the composite keeps it rather than pushing it at the consumer.
    measured: extra.measured,
    selected: extra.selected,
    focusable: true,
    ariaLabel: node.label,
    deletable: !extra.readOnly,
    domAttributes: { 'aria-describedby': problemSummaryId(node.id) },
    data: { node, renderer: extra.renderer, readOnly: extra.readOnly, onDeleteRequest: extra.onDeleteRequest, overlay: extra.overlay },
  };
}

function toXyEdge(edge: WorkflowCanvasEdge): Edge {
  return {
    id: edge.id,
    type: 'workflowEdge',
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    label: edge.label,
    focusable: true,
  };
}

function fromXyNode(node: Node<WorkflowNodeData>): WorkflowCanvasNode {
  return { ...node.data.node, position: node.position };
}

interface NodeDimensions {
  width: number;
  height: number;
}

/** Merges React Flow's measurements in, returning the SAME object when nothing moved — a new
 *  identity here would re-run the `xyNodes` memo and re-sync the whole graph on every frame. */
function mergeMeasured(previous: Record<string, NodeDimensions>, changes: NodeDimensionChange[]): Record<string, NodeDimensions> {
  let next: Record<string, NodeDimensions> | null = null;
  for (const change of changes) {
    const dimensions = change.dimensions;
    if (!dimensions) continue;
    const current = previous[change.id];
    if (current && current.width === dimensions.width && current.height === dimensions.height) continue;
    next ??= { ...previous };
    next[change.id] = { width: dimensions.width, height: dimensions.height };
  }
  return next ?? previous;
}

function pruneMeasured(previous: Record<string, NodeDimensions>, removedIds: Set<string>): Record<string, NodeDimensions> {
  const remaining = Object.keys(previous).filter((id) => !removedIds.has(id));
  if (remaining.length === Object.keys(previous).length) return previous;
  return Object.fromEntries(remaining.map((id) => [id, previous[id]]));
}

/**
 * The React Flow canvas, themed and wrapped as a props-in/callbacks-out composite
 * Task 5) — it owns no graph state itself; a consumer (the Studio's Zustand store, Task 11)
 * owns `nodes`/`edges` and re-renders this component. Reachable only through the
 * `./components/workflow-canvas` subpath export (never the root barrel — see `DEPENDENCY.md`).
 *
 * A11y floor built in here, not bolted on: `role="application"` + `aria-label` on the pane, a
 * visually-hidden keyboard hint, every node focusable with an accessible name and
 * `aria-describedby` pointing at its validation summary, real `<button>` zoom/fit/remove
 * controls (pointer-drag is never the only mutation path), and `prefers-reduced-motion`
 * suppresses the fit-view animation.
 */
export function WorkflowCanvas({
  nodes,
  edges,
  nodeTypes,
  selectedNodeId = null,
  readOnly = false,
  overlay,
  onNodesChange,
  onEdgesChange,
  onConnect,
  isValidConnection,
  onSelect,
  onDeleteRequest,
  emptyState,
  className,
  'aria-label': ariaLabel,
}: WorkflowCanvasProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Node dimensions as React Flow measured them (see `toXyNode`). Keyed by node id; entries for
  // removed nodes are pruned so a long editing session cannot grow this unboundedly.
  const [measured, setMeasured] = React.useState<Record<string, NodeDimensions>>({});

  const xyNodes = React.useMemo(
    () =>
      nodes.map((node) =>
        toXyNode(node, {
          selected: node.id === selectedNodeId,
          readOnly,
          renderer: nodeTypes?.[node.type],
          onDeleteRequest,
          overlay,
          measured: measured[node.id],
        }),
      ),
    [nodes, selectedNodeId, readOnly, nodeTypes, onDeleteRequest, overlay, measured],
  );
  const xyEdges = React.useMemo(() => edges.map(toXyEdge), [edges]);

  const handleNodesChange = React.useCallback(
    (changes: NodeChange<Node<WorkflowNodeData>>[]) => {
      const removals = changes.filter((change) => change.type === 'remove');
      for (const removal of removals) onDeleteRequest?.(removal.id);
      if (removals.length > 0) {
        const removedIds = new Set(removals.map((removal) => removal.id));
        setMeasured((previous) => pruneMeasured(previous, removedIds));
      }

      // Dimension changes are the composite's own business — absorbed here, never forwarded, so
      // measuring a node cannot look like an authored edit to the consumer's store.
      const dimensionChanges = changes.filter((change): change is NodeDimensionChange => change.type === 'dimensions');
      if (dimensionChanges.length > 0) setMeasured((previous) => mergeMeasured(previous, dimensionChanges));

      const rest = changes.filter((change) => change.type !== 'remove' && change.type !== 'dimensions');
      if (rest.length === 0 || !onNodesChange) return;
      onNodesChange(applyNodeChanges(rest, xyNodes).map(fromXyNode));
    },
    [xyNodes, onNodesChange, onDeleteRequest],
  );

  const handleEdgesChange = React.useCallback(
    (changes: Parameters<NonNullable<React.ComponentProps<typeof ReactFlow>['onEdgesChange']>>[0]) => {
      if (!onEdgesChange) return;
      const next = applyEdgeChanges(changes, xyEdges);
      onEdgesChange(
        next.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
          label: typeof edge.label === 'string' ? edge.label : undefined,
        })),
      );
    },
    [xyEdges, onEdgesChange],
  );

  // MUST be memoized. React Flow re-subscribes on every new handler identity and re-emits the
  // current selection, so an inline arrow here fed `onSelect` -> store -> `selectedNodeId` ->
  // new `xyNodes` -> render -> new handler -> emit again: "Maximum update depth exceeded", which
  // tore the canvas subtree down the moment a node was selected (observed against the running
  // stack, 2026-08-19).
  const handleSelectionChange = React.useCallback(
    ({ nodes: selected }: { nodes: Node<WorkflowNodeData>[] }) => {
      onSelect?.(selected[0]?.id ?? null);
    },
    [onSelect],
  );

  // React Flow hands this an `Edge | Connection`; both carry the four fields the guard needs.
  const handleIsValidConnection = React.useMemo(
    () =>
      isValidConnection
        ? (connection: Connection | Edge) =>
            isValidConnection({
              source: connection.source,
              sourceHandle: connection.sourceHandle,
              target: connection.target,
              targetHandle: connection.targetHandle,
            })
        : undefined,
    [isValidConnection],
  );

  const handleConnect = React.useCallback(
    (connection: Connection) => {
      onConnect?.({
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target: connection.target,
        targetHandle: connection.targetHandle,
      });
    },
    [onConnect],
  );

  return (
    <div
      data-slot="workflow-canvas"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      className={cn('workflow-canvas relative size-full min-h-0', className)}
    >
      <span className="sr-only">
        Workflow graph editor. Press Tab to move between nodes. Use the structured list view for a pointer-free way to add, configure, connect,
        reorder and delete nodes without dragging.
      </span>
      <ReactFlow
        nodes={xyNodes}
        edges={xyEdges}
        nodeTypes={XYFLOW_NODE_TYPES}
        edgeTypes={XYFLOW_EDGE_TYPES}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={handleConnect}
        isValidConnection={handleIsValidConnection}
        onSelectionChange={handleSelectionChange}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        elementsSelectable
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ duration: reducedMotion ? 0 : 400, padding: 0.2 }}
        role="application"
        aria-label={ariaLabel}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} />
        <CanvasControls showInteractive={!readOnly} />
      </ReactFlow>
      {emptyState && nodes.length === 0 ? (
        // Non-interactive overlay: the pane underneath stays pannable/zoomable and keeps its
        // `role="application"` semantics; the empty state is purely explanatory copy.
        <div data-slot="workflow-canvas-empty" className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
          {emptyState}
        </div>
      ) : null}
    </div>
  );
}
