'use client';

import type { EdgeProps, EdgeTypes } from '@xyflow/react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';

import { cn } from '@/lib/utils';

/** Themed bezier edge — stroke/label colour come from the `--workflow-canvas-*` bridge (`canvas-tokens.css`), never a hardcoded colour (rule 07/11). This is the ONE xyflow-registered edge type — see `workflow-canvas.tsx`. */
function WorkflowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, label, markerEnd, style }: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ ...style, stroke: 'var(--workflow-canvas-edge)', strokeWidth: selected ? 2 : 1.5 }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={cn(
              'nodrag nopan pointer-events-none absolute rounded-sm bg-[var(--workflow-canvas-edge-label-bg)] px-1.5 py-0.5 text-[10px] text-[var(--workflow-canvas-edge-label-fg)]',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const XYFLOW_EDGE_TYPES: EdgeTypes = { workflowEdge: WorkflowEdge };
