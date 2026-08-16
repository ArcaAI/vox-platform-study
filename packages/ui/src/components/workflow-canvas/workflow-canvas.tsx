'use client';

import * as React from 'react';
import type { Connection, Edge, Node, NodeChange } from '@xyflow/react';
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
  },
): Node<WorkflowNodeData> {
  return {
    id: node.id,
    type: 'workflowNode',
    position: node.position,
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

/**
 * The React Flow canvas, themed and wrapped as a props-in/callbacks-out composite (TASK-719
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
  onSelect,
  onDeleteRequest,
  className,
  'aria-label': ariaLabel,
}: WorkflowCanvasProps) {
  const reducedMotion = usePrefersReducedMotion();

  const xyNodes = React.useMemo(
    () =>
      nodes.map((node) =>
        toXyNode(node, {
          selected: node.id === selectedNodeId,
          readOnly,
          renderer: nodeTypes?.[node.type],
          onDeleteRequest,
          overlay,
        }),
      ),
    [nodes, selectedNodeId, readOnly, nodeTypes, onDeleteRequest, overlay],
  );
  const xyEdges = React.useMemo(() => edges.map(toXyEdge), [edges]);

  const handleNodesChange = React.useCallback(
    (changes: NodeChange<Node<WorkflowNodeData>>[]) => {
      const removals = changes.filter((change) => change.type === 'remove');
      for (const removal of removals) onDeleteRequest?.(removal.id);
      const rest = changes.filter((change) => change.type !== 'remove');
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
        onSelectionChange={({ nodes: selected }) => onSelect?.(selected[0]?.id ?? null)}
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
    </div>
  );
}
