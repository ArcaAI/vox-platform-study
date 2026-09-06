'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

import type { WorkflowCanvasNode, WorkflowCanvasNodeRendererProps, WorkflowCanvasNodeTypes, WorkflowCanvasPort } from './types';

/** Internal xyflow node-data payload. Never exposed to composite consumers directly. */
export interface WorkflowNodeData extends Record<string, unknown> {
  node: WorkflowCanvasNode;
  renderer?: WorkflowCanvasNodeTypes[string];
  readOnly?: boolean;
  onDeleteRequest?: (nodeId: string) => void;
  overlay?: (node: WorkflowCanvasNode) => React.ReactNode;
}

function isMandatory(node: WorkflowCanvasNode): boolean {
  return (node.safetyClasses ?? []).includes('mandatory');
}

/** Exported so `workflow-canvas.tsx` can compute the same id when building `domAttributes.aria-describedby`. */
export function problemSummaryId(nodeId: string): string {
  return `${nodeId}-problem-summary`;
}

const SEVERITY_BORDER: Record<'ERROR' | 'WARNING', string> = {
  ERROR: 'border-destructive',
  WARNING: 'border-warning',
};

const SEVERITY_BADGE_VARIANT: Record<'ERROR' | 'WARNING', 'destructive' | 'secondary'> = {
  ERROR: 'destructive',
  WARNING: 'secondary',
};

const HANDLE_CLASS = 'workflow-canvas-port !bg-[var(--workflow-canvas-handle)]';

function PortHandle({ port, direction }: { port: WorkflowCanvasPort; direction: 'input' | 'output' }) {
  const label = port.label ?? port.id;
  return (
    <span className={cn('flex items-center gap-1 text-[11px] leading-4', direction === 'output' && 'flex-row-reverse text-right')}>
      <Handle
        id={port.id}
        type={direction === 'input' ? 'target' : 'source'}
        position={direction === 'input' ? Position.Left : Position.Right}
        className={HANDLE_CLASS}
        data-port-kind={port.kind}
        data-port-primitive={port.primitive}
        title={`${label} (${port.primitive})`}
      />
      <span className="truncate">
        {label}
        <span className="sr-only">
          {' '}
          ({port.kind} port, {port.primitive})
        </span>
      </span>
    </span>
  );
}

/**
 * The shared chrome for every workflow node — label, safety badge, problem border, and a
 * hidden validation-summary description every node points at via `aria-describedby` (set on
 * the outer xyflow node object by `workflow-canvas.tsx`, not here). Registry-driven inner
 * content (`data.renderer`) renders inside this chrome; when absent, the label is the whole
 * body. This is the ONE xyflow-registered node type — see `workflow-canvas.tsx`.
 *
 * TASK-864 B1: a node carrying `ports` renders ONE handle per port, inputs down the left and
 * outputs down the right, each keyed by the port id so an edge lands on the socket it names;
 * a node without `ports` keeps the legacy single `in`/`out` pair. A `kind: 'group'` node (a
 * loop body) renders as a container its children sit inside.
 */
function WorkflowNode({ id, data, selected }: NodeProps & { data: WorkflowNodeData }) {
  const { node, renderer: Renderer, readOnly, onDeleteRequest, overlay } = data;
  const problem = node.problem;
  const mandatory = isMandatory(node);
  const group = node.kind === 'group';
  const rendererProps: WorkflowCanvasNodeRendererProps = { node, selected: Boolean(selected) };
  const ports = node.ports;

  return (
    <div
      data-slot="workflow-node"
      data-node-type={node.type}
      data-node-kind={group ? 'group' : 'node'}
      data-mandatory={mandatory ? 'true' : 'false'}
      data-deprecated={node.deprecated ? 'true' : undefined}
      className={cn(
        'rounded-md border-2 text-[var(--workflow-canvas-node-fg)]',
        group
          ? 'size-full min-h-[120px] min-w-[240px] border-dashed bg-[var(--workflow-canvas-group-bg)] px-3 py-2'
          : 'min-w-[180px] bg-[var(--workflow-canvas-node-bg)] px-3 py-2',
        problem
          ? SEVERITY_BORDER[problem.severity]
          : group
            ? 'border-[var(--workflow-canvas-group-border)]'
            : 'border-[var(--workflow-canvas-node-border)]',
        selected && 'ring-2 ring-primary ring-offset-1',
      )}
    >
      {!ports ? (
        <>
          <Handle type="target" position={Position.Left} className="!bg-[var(--workflow-canvas-handle)]" />
          <Handle type="source" position={Position.Right} className="!bg-[var(--workflow-canvas-handle)]" />
        </>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium">{node.label}</span>
        {!readOnly && !mandatory ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="nodrag -mt-1 -mr-1 size-5 shrink-0"
            aria-label={`Remove ${node.label}`}
            onClick={(event) => {
              event.stopPropagation();
              onDeleteRequest?.(id);
            }}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {mandatory ? (
          <Badge variant="outline" className="text-xs">
            mandatory
          </Badge>
        ) : null}
        {node.deprecated ? (
          <Badge variant="secondary" className="text-xs">
            deprecated
          </Badge>
        ) : null}
        {problem ? (
          <Badge variant={SEVERITY_BADGE_VARIANT[problem.severity]} className="text-xs">
            {problem.severity === 'ERROR' ? 'error' : 'warning'}
          </Badge>
        ) : null}
      </div>

      {Renderer ? (
        <div className="nodrag mt-2">
          <Renderer {...rendererProps} />
        </div>
      ) : null}

      {ports ? (
        <div className="mt-2 grid grid-cols-2 gap-x-3" data-slot="workflow-node-ports">
          {/* `role="group"`: an `aria-label` on a bare div is prohibited (axe `aria-prohibited-attr`),
              so the label was being dropped by assistive tech — the port column had no name at all.
              Surfaced by TASK-890's core.trigger inspector scan; the label text is unchanged. */}
          <div className="-ml-3 flex flex-col gap-1" role="group" aria-label="Inputs">
            {ports.inputs.map((port) => (
              <PortHandle key={port.id} port={port} direction="input" />
            ))}
          </div>
          <div className="-mr-3 flex flex-col gap-1" role="group" aria-label="Outputs">
            {ports.outputs.map((port) => (
              <PortHandle key={port.id} port={port} direction="output" />
            ))}
          </div>
        </div>
      ) : null}

      {overlay ? <div className="mt-2">{overlay(node)}</div> : null}

      <span id={problemSummaryId(id)} className="sr-only">
        {problem ? `${problem.severity === 'ERROR' ? 'Error' : 'Warning'}: ${problem.messages.join('. ')}` : 'No validation problems.'}
      </span>
    </div>
  );
}

/** The single xyflow-level node type this composite registers — every registry node type renders through this shared chrome. Module-level constant so `<ReactFlow nodeTypes>` never sees a new identity across renders (avoids xyflow's dev warning + a spurious remount). */
export const XYFLOW_NODE_TYPES: NodeTypes = { workflowNode: WorkflowNode };
