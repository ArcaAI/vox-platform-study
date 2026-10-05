'use client';

import { Controls, type FitViewOptions } from '@xyflow/react';

/**
 * Themed wrapper over xyflow's own `<Controls>` — zoom in / zoom out / fit view / toggle
 * interactivity, each already a real `<button>` with an `aria-label` sourced from
 * `defaultAriaLabelConfig` (`@xyflow/system`), so no hand-rolled a11y is needed here; only the
 * colour tokens are bridged (`canvas-tokens.css`).
 */
export function CanvasControls({
  showInteractive = true,
  fitViewOptions,
}: {
  showInteractive?: boolean;
  /** TASK-1036 R-C #2 — the fit button fits into the same free rectangle the canvas does. */
  fitViewOptions?: FitViewOptions;
}) {
  // Horizontal: the controls sit in the canvas's bottom-centre dock beside the minimap, and their
  // position never depends on the floating panes (owner, 2026-10-05).
  return (
    <Controls
      position="bottom-center"
      orientation="horizontal"
      showInteractive={showInteractive}
      fitViewOptions={fitViewOptions}
      className="workflow-canvas-controls"
    />
  );
}
