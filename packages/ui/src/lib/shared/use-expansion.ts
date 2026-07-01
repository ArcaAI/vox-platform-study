'use client';

import * as React from 'react';

export type ExpansionMode = 'single' | 'multiple';

export interface UseExpansionParams {
  /** Controlled expanded ids. When provided, the hook never self-updates. */
  value?: string[];
  /** Fired with the next id set whenever a toggle/setExpanded changes things. */
  onChange?: (ids: string[]) => void;
  /** `multiple` (default) allows many open; `single` keeps only one open. */
  mode?: ExpansionMode;
  /** Initial open ids for the uncontrolled case (read once, on mount). */
  defaultExpandedIds?: string[];
  /** Per-item callback fired on a real expand/collapse transition. */
  onExpandedChange?: (id: string, expanded: boolean) => void;
}

export interface UseExpansionResult {
  expandedIds: string[];
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  setExpanded: (id: string, expanded: boolean) => void;
}

/**
 * Headless expansion controller (controlled/uncontrolled, single/multiple).
 *
 * Extracted from `components/timeline/use-timeline.ts` (TASK-372) so both the
 * `ItemList` (TASK-378 §4a.2) and `HistoryTimelineList` foundations share one
 * implementation. The public behavior matches the original timeline controller.
 */
export function useExpansion(params: UseExpansionParams = {}): UseExpansionResult {
  const { value, onChange, mode = 'multiple', defaultExpandedIds, onExpandedChange } = params;

  const isControlled = value != null;
  const [internal, setInternal] = React.useState<string[]>(() => defaultExpandedIds ?? []);
  const expandedIds = isControlled ? value! : internal;

  const setExpanded = React.useCallback(
    (id: string, expanded: boolean) => {
      const has = expandedIds.includes(id);
      if (expanded === has) return;
      const next = expanded ? (mode === 'single' ? [id] : [...expandedIds, id]) : expandedIds.filter((x) => x !== id);
      if (!isControlled) setInternal(next);
      onChange?.(next);
      onExpandedChange?.(id, expanded);
    },
    [expandedIds, isControlled, mode, onChange, onExpandedChange],
  );

  const toggle = React.useCallback((id: string) => setExpanded(id, !expandedIds.includes(id)), [expandedIds, setExpanded]);
  const isExpanded = React.useCallback((id: string) => expandedIds.includes(id), [expandedIds]);

  return { expandedIds, isExpanded, toggle, setExpanded };
}
