'use client';

/**
 * One row of the structured list/tree editor — a focusable element with an
 * accessible name (TASK-890 black-box J4-F3: the node's label, else its type plus a short id —
 * two same-typed rows are no longer indistinguishable), its safety-class badge, its validation
 * status, and row actions (Configure / move up/down / Delete), all real `<button>`s. `mandatory` rows expose no Delete and say why —
 * the SAME rule the canvas enforces (`store.deleteNode`), never re-implemented per editor.
 */
import { Badge, Button } from '@arcaai/ui';
import { IconArrowDown, IconArrowUp, IconCopy, IconSettings, IconTrash } from '@tabler/icons-react';
import { nodeDisplayName } from '../../lib/node-identity';
import type { WorkflowFinding } from '../../api/types';
import type { GraphStoreEdge, GraphStoreNode } from '../../store/types';
import { EdgeEditor } from './edge-editor';

export interface NodeRowProps {
  node: GraphStoreNode;
  edges: GraphStoreEdge[];
  otherNodes: GraphStoreNode[];
  problems: WorkflowFinding[];
  selected: boolean;
  readOnly?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onSelect: (nodeId: string) => void;
  onDeleteRequest: (nodeId: string) => void;
  onMove: (nodeId: string, direction: 'up' | 'down') => void;
  onDuplicate: (nodeId: string) => void;
  onConnect: (source: string, target: string) => { ok: true } | { ok: false; reason: string };
  onDisconnect: (edgeId: string) => void;
}

const SEVERITY_VARIANT = { ERROR: 'destructive', WARNING: 'secondary' } as const;

export function NodeRow({ node, edges, otherNodes, problems, selected, readOnly, canMoveUp, canMoveDown, onSelect, onDeleteRequest, onMove, onDuplicate, onConnect, onDisconnect }: NodeRowProps) {
  const mandatory = node.safetyClasses.includes('mandatory');
  const worstSeverity = problems.some((problem) => problem.severity === 'ERROR') ? 'ERROR' : problems.length > 0 ? 'WARNING' : null;
  const label = nodeDisplayName(node);
  const nodeEdges = edges.filter((edge) => edge.source === node.id);

  return (
    <li data-workflow-node-row-id={node.id} className="rounded-md border p-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          aria-pressed={selected}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="truncate text-sm font-medium">{label}</span>
          {node.safetyClasses.map((cls) => (
            <Badge key={cls} variant={cls === 'mandatory' ? 'destructive' : 'outline'} className="text-xs">
              {cls}
            </Badge>
          ))}
          {worstSeverity ? (
            <Badge variant={SEVERITY_VARIANT[worstSeverity]} className="text-xs">
              {problems.length} {worstSeverity === 'ERROR' ? 'error' : 'warning'}
              {problems.length === 1 ? '' : 's'}
            </Badge>
          ) : null}
        </button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Configure ${label}`} onClick={() => onSelect(node.id)}>
          <IconSettings aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${label} up`} disabled={!canMoveUp || readOnly} onClick={() => onMove(node.id, 'up')}>
          <IconArrowUp aria-hidden="true" />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move ${label} down`} disabled={!canMoveDown || readOnly} onClick={() => onMove(node.id, 'down')}>
          <IconArrowDown aria-hidden="true" />
        </Button>
        {!mandatory && !readOnly ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Duplicate ${label}`} onClick={() => onDuplicate(node.id)}>
            <IconCopy aria-hidden="true" />
          </Button>
        ) : null}
        {!mandatory && !readOnly ? (
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete ${label}`} onClick={() => onDeleteRequest(node.id)}>
            <IconTrash aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {mandatory ? <p className="text-muted-foreground pl-1 text-xs">Mandatory — cannot be deleted.</p> : null}
      <EdgeEditor
        node={node}
        edges={nodeEdges}
        otherNodes={otherNodes}
        readOnly={readOnly}
        onConnect={(targetId) => onConnect(node.id, targetId)}
        onDisconnect={onDisconnect}
      />
    </li>
  );
}
