'use client';

import { humanizeNodeType } from '../lib/graph-layout';
import { NodeRunBadge } from './node-run-badge';
import type { RunNodeRollup } from '../api/types';

/**
 * The structured list/tree peer of the canvas overlay (Task 8) — a
 * first-class, single-pointer, keyboard-only path over the SAME rollup
 * data, per design.md's Studio precedent (WCAG 2.5.7 / keyboard-only
 * authoring). Ordered by `order` — the run's own step sequence, the closest
 * thing to execution order this read model offers.
 */
export function RunTraceListView({ nodes, onSelect }: { nodes: RunNodeRollup[]; onSelect: (rollup: RunNodeRollup) => void }) {
  const ordered = [...nodes].sort((a, b) => a.order - b.order);
  return (
    <ol aria-label="Run trace, in step order" className="flex flex-col gap-2">
      {ordered.map((rollup) => (
        <li key={`${rollup.nodeType}-${rollup.order}`}>
          <button
            type="button"
            onClick={() => onSelect(rollup)}
            className="hover:bg-accent focus-visible:ring-ring flex w-full flex-col gap-1 rounded-md border p-3 text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{humanizeNodeType(rollup.nodeType)}</span>
              <span className="text-muted-foreground font-mono text-xs">{rollup.nodeType}</span>
            </div>
            <NodeRunBadge rollup={rollup} />
          </button>
        </li>
      ))}
    </ol>
  );
}
