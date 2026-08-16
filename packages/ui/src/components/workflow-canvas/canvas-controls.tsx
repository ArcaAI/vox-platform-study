'use client';

import { Controls } from '@xyflow/react';

/**
 * Themed wrapper over xyflow's own `<Controls>` — zoom in / zoom out / fit view / toggle
 * interactivity, each already a real `<button>` with an `aria-label` sourced from
 * `defaultAriaLabelConfig` (`@xyflow/system`), so no hand-rolled a11y is needed here; only the
 * colour tokens are bridged (`canvas-tokens.css`).
 */
export function CanvasControls({ showInteractive = true }: { showInteractive?: boolean }) {
  return <Controls position="bottom-left" showInteractive={showInteractive} className="workflow-canvas-controls" />;
}
