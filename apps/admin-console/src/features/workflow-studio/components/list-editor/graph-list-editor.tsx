'use client';

/**
 * `GraphListEditor` (TASK-719 Task 13) — the WCAG 2.5.7 single-pointer / keyboard-only peer of
 * the canvas, not a fallback: every mutation the canvas supports (configure, connect, delete)
 * is reachable here through real `<button>`s; reorder is buttons, not drag. Renders inside
 * `contentMode="scroll"` (rule 11 §1: "this editor is the one that scrolls").
 *
 * Props-in/callbacks-out over the SAME `GraphStore` model as the canvas (`store/types.ts`) — no
 * second graph model to drift. `onDeleteRequest`/`onConnect` return the store's `ActionResult`
 * so a refusal (mandatory node, self-edge, duplicate edge) renders identically to the canvas.
 */
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@arcaai/ui';
import { IconListDetails } from '@tabler/icons-react';
import type { WorkflowFinding } from '../../api/types';
import type { ActionResult, GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { NodeRow } from './node-row';

export interface GraphListEditorProps {
  nodes: GraphStoreNode[];
  edges: GraphStoreEdge[];
  selectedNodeId: string | null;
  /** Server findings, already grouped — see `store/selectors.ts#findingsByNodeId`. */
  problemsByNodeId: Map<string | null, WorkflowFinding[]>;
  readOnly?: boolean;
  onSelect: (nodeId: string) => void;
  onDeleteRequest: (nodeId: string) => ActionResult;
  onMove: (nodeId: string, direction: 'up' | 'down') => void;
  onDuplicate: (nodeId: string) => void;
  onConnect: (source: string, target: string) => ActionResult;
  onDisconnect: (edgeId: string) => void;
}

export function GraphListEditor({ nodes, edges, selectedNodeId, problemsByNodeId, readOnly, onSelect, onDeleteRequest, onMove, onDuplicate, onConnect, onDisconnect }: GraphListEditorProps) {
  if (nodes.length === 0) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <IconListDetails aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>No nodes yet</EmptyTitle>
        <EmptyDescription>Add a node from the palette to start building this workflow.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <ul aria-label="Workflow graph, list view" className="flex flex-col gap-2">
      {nodes.map((node, index) => (
        <NodeRow
          key={node.id}
          node={node}
          edges={edges}
          otherNodes={nodes.filter((candidate) => candidate.id !== node.id)}
          problems={problemsByNodeId.get(node.id) ?? []}
          selected={node.id === selectedNodeId}
          readOnly={readOnly}
          canMoveUp={index > 0}
          canMoveDown={index < nodes.length - 1}
          onSelect={onSelect}
          onDeleteRequest={(nodeId) => {
            onDeleteRequest(nodeId);
          }}
          onMove={onMove}
          onDuplicate={onDuplicate}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
        />
      ))}
    </ul>
  );
}
