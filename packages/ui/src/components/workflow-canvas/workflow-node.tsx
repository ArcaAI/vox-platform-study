'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import type { NodeProps, NodeTypes } from '@xyflow/react';
import { Handle, Position } from '@xyflow/react';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

import type {
  WorkflowCanvasNode,
  WorkflowCanvasNodeRendererProps,
  WorkflowCanvasNodeTypes,
  WorkflowCanvasRunState,
  WorkflowCanvasStepMarker,
} from './types';

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

const PRIMARY_HANDLE_CLASS = '!bg-[var(--workflow-canvas-handle)]';
/** Branch handles sit inline beside their label rather than at React Flow's absolute mid-edge default (`canvas-tokens.css`). */
const BRANCH_HANDLE_CLASS = 'workflow-canvas-branch !bg-[var(--workflow-canvas-handle-control)]';

const STEP_MARKER_GLYPH: Record<WorkflowCanvasStepMarker, string> = { cycle: '↻', unreachable: '⚠' };
const STEP_MARKER_NAME: Record<WorkflowCanvasStepMarker, string> = {
  cycle: 'In a cycle, so it has no execution step',
  unreachable: 'Unreachable from the trigger',
};

/**
 * Execution order, at the head of the node (TASK-893 §3.2). A node the topological sort could not
 * place gets a glyph instead of a number — a cycle and an unreachable node are two findings that
 * used to be a line in the validation rail and are now visible on the graph itself.
 *
 * The glyph or digit is always accompanied by its own name, so the state is never carried by the
 * badge's colour alone (rule 11 §10).
 */
function StepBadge({ stepNumber, stepMarker }: { stepNumber?: number | null; stepMarker?: WorkflowCanvasStepMarker }) {
  if (stepMarker) {
    return (
      <span
        data-slot="workflow-node-step"
        data-step-marker={stepMarker}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-warning text-[11px] leading-none text-warning-strong"
      >
        <span aria-hidden>{STEP_MARKER_GLYPH[stepMarker]}</span>
        <span className="sr-only">{STEP_MARKER_NAME[stepMarker]}</span>
      </span>
    );
  }
  if (stepNumber === null || stepNumber === undefined) return null;
  return (
    <span
      data-slot="workflow-node-step"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] leading-none font-medium tabular-nums text-muted-foreground"
    >
      <span aria-hidden>{stepNumber}</span>
      <span className="sr-only">Step {stepNumber}</span>
    </span>
  );
}

const RUN_STATE_VARIANT: Record<WorkflowCanvasRunState, 'secondary' | 'destructive' | 'outline'> = {
  pending: 'outline',
  running: 'secondary',
  ok: 'outline',
  failed: 'destructive',
  skipped: 'outline',
};

/** Role tint only — the chip always spells its state out, so colour is decoration (rule 11 §10). */
const RUN_STATE_CLASS: Record<WorkflowCanvasRunState, string> = {
  pending: 'text-muted-foreground',
  running: '',
  ok: 'border-success text-success-strong',
  failed: '',
  skipped: 'text-muted-foreground',
};

/** `950` -> `950 ms`; `1240` -> `1.2 s`; `74000` -> `74 s`. */
function formatRunDuration(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** The sandbox's per-node verdict, in the node header (TASK-893 §3.6). Text first, colour second. */
function RunChip({ runState, runDurationMs }: { runState: WorkflowCanvasRunState; runDurationMs?: number }) {
  const duration = runDurationMs === undefined ? null : formatRunDuration(runDurationMs);
  return (
    <Badge variant={RUN_STATE_VARIANT[runState]} data-run-state={runState} className={cn('gap-1 px-1.5 text-[11px]', RUN_STATE_CLASS[runState])}>
      <span className="sr-only">Run state: </span>
      <span>{runState}</span>
      {duration ? <span className="tabular-nums opacity-80">{duration}</span> : null}
    </Badge>
  );
}

/**
 * The shared chrome for every workflow node — step badge, label, run chip, safety badge, problem
 * border, and a hidden validation-summary description every node points at via `aria-describedby`
 * (set on the outer xyflow node object by `workflow-canvas.tsx`, not here). Registry-driven inner
 * content (`data.renderer`) renders inside this chrome; when absent, the label is the whole body.
 * This is the ONE xyflow-registered node type — see `workflow-canvas.tsx`.
 *
 * TASK-893 §3.1: a node shows the MAIN FLOW only — at most one target dot (`in`, left edge) and
 * one source dot (`out`, right edge) — plus one labelled source handle per declared branch,
 * stacked below the primary output. Branches are the single case where more than one output earns
 * its space (`then`/`else`, `approved`/`rejected`/`timedOut`, `each`/`done`), and a branch
 * handle's id IS the wire's port name, so an edge drawn from it already names its socket. The
 * secondary DATA sockets that used to render one handle each (14 on a `core.action`) are bound in
 * the inspector instead; the port contract, the compatibility lattice and the interpreter are
 * unchanged — only the presentation collapsed.
 *
 * A `kind: 'group'` node (a loop body) renders as a container its children sit inside.
 */
function WorkflowNode({ id, data, selected }: NodeProps & { data: WorkflowNodeData }) {
  const { node, renderer: Renderer, readOnly, onDeleteRequest, overlay } = data;
  const problem = node.problem;
  const mandatory = isMandatory(node);
  const group = node.kind === 'group';
  const rendererProps: WorkflowCanvasNodeRendererProps = { node, selected: Boolean(selected) };
  const hasInput = node.hasInput ?? true;
  const hasOutput = node.hasOutput ?? true;
  const branches = node.branches ?? [];

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
      {hasInput ? <Handle id="in" type="target" position={Position.Left} className={PRIMARY_HANDLE_CLASS} /> : null}
      {hasOutput ? <Handle id="out" type="source" position={Position.Right} className={PRIMARY_HANDLE_CLASS} /> : null}

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <StepBadge stepNumber={node.stepNumber} stepMarker={node.stepMarker} />
          <span className="text-sm font-medium">{node.label}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {node.runState ? <RunChip runState={node.runState} runDurationMs={node.runDurationMs} /> : null}
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

      {branches.length > 0 ? (
        /* `role="group"`: an `aria-label` on a bare div is prohibited (axe `aria-prohibited-attr`),
           so the label was being dropped by assistive tech — the handle column had no name at all.
           Surfaced by TASK-890's core.trigger inspector scan; the label text is unchanged. */
        <div className="mt-2 flex flex-col items-end gap-1" data-slot="workflow-node-branches" role="group" aria-label="Outputs">
          {branches.map((branch) => (
            <div key={branch.id} className="flex flex-row-reverse items-center gap-1 text-right text-[11px] leading-4">
              <Handle id={branch.id} type="source" position={Position.Right} className={BRANCH_HANDLE_CLASS} title={branch.label} />
              <span className="truncate">
                {branch.label}
                <span className="sr-only"> branch output</span>
              </span>
            </div>
          ))}
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
