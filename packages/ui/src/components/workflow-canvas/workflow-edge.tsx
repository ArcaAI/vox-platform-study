'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import type { EdgeProps, EdgeTypes } from '@xyflow/react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from '@xyflow/react';

import { Button } from '@/components/shadcn/button';
import { cn } from '@/lib/utils';

/**
 * What an edge needs from the composite that is NOT part of its React Flow edge object.
 *
 * Deliberately a context rather than per-edge `data`: `workflow-canvas.tsx` memoizes its
 * `xyEdges` array on the `edges` prop ALONE, and folding a consumer callback (which may be a
 * fresh arrow on every render) into that array would rebuild it every render and make React Flow
 * re-adopt the whole edge set continuously. A context re-renders the edge components and nothing
 * else.
 */
export interface WorkflowEdgeChrome {
  readOnly: boolean;
  /** Absent = edges are not deletable; the X is not rendered. */
  onEdgeDelete?: (edgeId: string) => void;
  /** Which edge the pointer is currently over, as reported by React Flow's own edge mouse events. */
  hoveredEdgeId: string | null;
  /** Node id -> label, so an edge's delete button can be named after what it connects rather than after two uuids. */
  nodeLabelById: ReadonlyMap<string, string>;
}

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map();

const WorkflowEdgeChromeContext = React.createContext<WorkflowEdgeChrome>({
  readOnly: false,
  hoveredEdgeId: null,
  nodeLabelById: EMPTY_LABELS,
});

export const WorkflowEdgeChromeProvider = WorkflowEdgeChromeContext.Provider;

/** Themed bezier edge — stroke/label colour come from the `--workflow-canvas-*` bridge (`canvas-tokens.css`), never a hardcoded colour (rule 07/11). This is the ONE xyflow-registered edge type — see `workflow-canvas.tsx`. */
function WorkflowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  label,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const { readOnly, onEdgeDelete, hoveredEdgeId, nodeLabelById } = React.useContext(WorkflowEdgeChromeContext);
  // A BINDING edge (`WorkflowCanvasEdge.kind`): a data binding the consumer edits in its own
  // inspector field, drawn dashed and always labelled so the flow reads correctly, and never
  // deletable from the canvas — the X is not rendered at all.
  const binding = (data as { kind?: string } | undefined)?.kind === 'binding';
  // Reveal state the portaled button cannot observe for itself: React Flow reports the pointer
  // entering the EDGE (`onEdgeMouseEnter`), but the button lives in the edge-label portal, so
  // moving the pointer off the path and onto the button would fire `onEdgeMouseLeave` and hide
  // the target out from under the click. The button's own pointer/focus state holds it open.
  const [pointerOverButton, setPointerOverButton] = React.useState(false);
  const [buttonFocused, setButtonFocused] = React.useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  const deletable = !readOnly && onEdgeDelete !== undefined && !binding;
  const revealed = hoveredEdgeId === id || pointerOverButton || buttonFocused || Boolean(selected);
  const fromLabel = nodeLabelById.get(source) ?? source;
  const toLabel = nodeLabelById.get(target) ?? target;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: 'var(--workflow-canvas-edge)',
          strokeWidth: selected ? 2 : 1.5,
          ...(binding ? { strokeDasharray: '6 4', opacity: 0.75 } : {}),
        }}
      />
      {label || deletable ? (
        <EdgeLabelRenderer>
          <div
            data-slot="workflow-edge-chrome"
            data-kind={binding ? 'binding' : 'wire'}
            className="nodrag nopan pointer-events-none absolute flex items-center gap-1"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {label ? (
              <span
                className={cn(
                  'rounded-sm bg-[var(--workflow-canvas-edge-label-bg)] px-1.5 py-0.5 text-xs text-[var(--workflow-canvas-edge-label-fg)]',
                  binding && 'font-mono',
                )}
                title={binding ? `Bound as "${label}" on ${toLabel} — edit it in the node's inspector` : undefined}
              >
                {label}
              </span>
            ) : null}
            {deletable ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                // Kept mounted rather than conditionally rendered so it stays in the tab order:
                // focusing it reveals it, which is the pointer-free route to deleting a connection
                // alongside the Delete key on a selected edge (WCAG 2.5.7). Hidden means
                // `pointer-events-none` too, so an invisible button never swallows a pane click.
                // `icon-xs` is 24px — the WCAG 2.5.8 hard floor for a pointer target; do not
                // shrink it to match the node's own (pre-existing, smaller) remove button.
                className={cn(
                  'border border-border shadow-raised transition-opacity',
                  revealed ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
                )}
                aria-label={`Remove connection from ${fromLabel} to ${toLabel}`}
                onPointerEnter={() => setPointerOverButton(true)}
                onPointerLeave={() => setPointerOverButton(false)}
                onFocus={() => setButtonFocused(true)}
                onBlur={() => setButtonFocused(false)}
                onClick={(event) => {
                  event.stopPropagation();
                  onEdgeDelete?.(id);
                }}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const XYFLOW_EDGE_TYPES: EdgeTypes = { workflowEdge: WorkflowEdge };
