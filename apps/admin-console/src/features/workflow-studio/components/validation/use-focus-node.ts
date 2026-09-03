'use client';

/**
 * Click-error → focus-node. Selects the node in the store AND moves DOM
 * focus to it — in the canvas that is the xyflow node element (React Flow stamps
 * `data-id="<nodeId>"` on its `.react-flow__node` wrapper by default — this hook does not
 * touch `packages/ui` to add that, it relies on the library's own convention); in the list
 * editor, `NodeRow` carries the Studio-owned `data-workflow-node-row-id="<nodeId>"` attribute
 * for the same purpose. Focus must not be obscured (WCAG 2.4.11) — `ScreenTemplate`'s pinned
 * regions are flex rows OUTSIDE the content scroll container (`screen-template.tsx:18-20`), so
 * no `scroll-mt-*` is required; `scrollIntoView` below is still called so the target is visible
 * within whichever editor's own internal scroll area (the canvas viewport or the list).
 */
import { useCallback } from 'react';
import type { WorkflowStudioViewMode } from '../../store/types';

function selectorFor(viewMode: WorkflowStudioViewMode, nodeId: string): string {
  return viewMode === 'list' ? `[data-workflow-node-row-id="${CSS.escape(nodeId)}"]` : `.react-flow__node[data-id="${CSS.escape(nodeId)}"]`;
}

export interface UseFocusNodeOptions {
  viewMode: WorkflowStudioViewMode;
  onSelect: (nodeId: string) => void;
  /** Injectable for tests; defaults to the real DOM. */
  root?: ParentNode;
}

export function useFocusNode({ viewMode, onSelect, root }: UseFocusNodeOptions) {
  return useCallback(
    (nodeId: string) => {
      onSelect(nodeId);
      const scope = root ?? document;
      // The target mounts synchronously with `onSelect`'s re-render in real usage; a microtask
      // gives React a paint before we query the DOM, mirroring the canvas's own `queueMicrotask`
      // discipline for post-render DOM measurement ( Task 5 finding).
      queueMicrotask(() => {
        const element = scope.querySelector<HTMLElement>(selectorFor(viewMode, nodeId));
        if (!element) return;
        element.scrollIntoView({ block: 'nearest' });
        const focusable = element.hasAttribute('tabindex') || element.tabIndex >= 0 ? element : element.querySelector<HTMLElement>('[tabindex], button, [href], input, select, textarea');
        (focusable ?? element).focus();
      });
    },
    [viewMode, onSelect, root],
  );
}
