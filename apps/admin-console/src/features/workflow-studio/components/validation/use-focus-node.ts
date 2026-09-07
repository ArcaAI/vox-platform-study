'use client';

/**
 * Click-error → focus-node. Selects the node in the store AND moves DOM
 * focus to it — the xyflow node element (React Flow stamps `data-id="<nodeId>"` on its
 * `.react-flow__node` wrapper by default — this hook does not touch `packages/ui` to add that,
 * it relies on the library's own convention).
 *
 * TASK-893 OD-1: the canvas is the only view. The `viewMode` argument and the list editor's
 * `data-workflow-node-row-id` branch went with `GraphListEditor`.
 *
 * Focus must not be obscured (WCAG 2.4.11) — `ScreenTemplate`'s pinned regions are flex rows
 * OUTSIDE the content scroll container (`screen-template.tsx:18-20`), so no `scroll-mt-*` is
 * required; `scrollIntoView` below is still called so the target is visible within the canvas's
 * own viewport.
 */
import { useCallback } from 'react';

function selectorFor(nodeId: string): string {
  return `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`;
}

export interface UseFocusNodeOptions {
  onSelect: (nodeId: string) => void;
  /** Injectable for tests; defaults to the real DOM. */
  root?: ParentNode;
}

export function useFocusNode({ onSelect, root }: UseFocusNodeOptions) {
  return useCallback(
    (nodeId: string) => {
      onSelect(nodeId);
      const scope = root ?? document;
      // The target mounts synchronously with `onSelect`'s re-render in real usage; a microtask
      // gives React a paint before we query the DOM, mirroring the canvas's own `queueMicrotask`
      // discipline for post-render DOM measurement ( Task 5 finding).
      queueMicrotask(() => {
        const element = scope.querySelector<HTMLElement>(selectorFor(nodeId));
        if (!element) return;
        element.scrollIntoView({ block: 'nearest' });
        const focusable =
          element.hasAttribute('tabindex') || element.tabIndex >= 0 ? element : element.querySelector<HTMLElement>('[tabindex], button, [href], input, select, textarea');
        (focusable ?? element).focus();
      });
    },
    [onSelect, root],
  );
}
