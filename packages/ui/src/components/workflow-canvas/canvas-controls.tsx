'use client';

import { Controls, type FitViewOptions } from '@xyflow/react';
import type { CSSProperties } from 'react';

/**
 * Themed wrapper over xyflow's own `<Controls>` — zoom in / zoom out / fit view / toggle
 * interactivity, each already a real `<button>` with an `aria-label` sourced from
 * `defaultAriaLabelConfig` (`@xyflow/system`), so no hand-rolled a11y is needed here; only the
 * colour tokens are bridged (`canvas-tokens.css`).
 */
export function CanvasControls({
  showInteractive = true,
  fitViewOptions,
  style,
}: {
  showInteractive?: boolean;
  /** TASK-1036 R-C #2 — the fit button fits into the same free rectangle the canvas does. */
  fitViewOptions?: FitViewOptions;
  /** TASK-1036 R-C #1 — margins that move the panel clear of whatever floats over the canvas. */
  style?: CSSProperties;
}) {
  return <Controls position="bottom-left" showInteractive={showInteractive} fitViewOptions={fitViewOptions} style={style} className="workflow-canvas-controls" />;
}
