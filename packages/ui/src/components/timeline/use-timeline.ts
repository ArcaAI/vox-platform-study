'use client';

import * as React from 'react';

import { useExpansion, type AsyncCollection } from '@/lib/shared';

import type { TimelineExpansion, TimelineItemModel, TimelineRow } from './types';

export interface UseTimelineParams<TItem = TimelineItemModel> {
  items: TItem[];
  /** Order `items` arrive in. Default `'desc'` (newest-first). */
  inputOrder?: 'desc' | 'asc';
  /** Displayed order; defaults to `inputOrder` (no reordering). */
  order?: 'desc' | 'asc';
  mapItem?: (raw: TItem) => TimelineItemModel;
  collection?: AsyncCollection<TItem>;
  expansion?: TimelineExpansion;
  onItemExpand?: (id: string, expanded: boolean) => void;
}

export interface UseTimelineResult {
  /** Rows in display order; `kind: 'band'` rows are not expandable items. */
  items: TimelineRow[];
  expandedIds: string[];
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  setExpanded: (id: string, expanded: boolean) => void;
  onEndReached: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

/**
 * Headless controller for `HistoryTimelineList`: ordering,
 * expansion (controlled or uncontrolled; single/multiple), and infinite-scroll
 * triggering against a transport-agnostic `AsyncCollection` (D5).
 */
export function useTimeline<TItem = TimelineItemModel>(params: UseTimelineParams<TItem>): UseTimelineResult {
  const { items, inputOrder = 'desc', order = inputOrder, mapItem, collection, expansion, onItemExpand } = params;

  const models = React.useMemo<TimelineRow[]>(() => {
    const mapped = mapItem ? items.map(mapItem) : (items as unknown as TimelineRow[]);
    // Reverse only when the requested display order differs from the input order.
    return order !== inputOrder ? [...mapped].reverse() : mapped;
  }, [items, inputOrder, order, mapItem]);

  const { expandedIds, isExpanded, toggle, setExpanded } = useExpansion({
    value: expansion?.value,
    onChange: expansion?.onChange,
    mode: expansion?.mode,
    defaultExpandedIds: React.useMemo(
      () => models.filter((m): m is TimelineItemModel => m.kind !== 'band' && !!m.defaultExpanded).map((m) => m.id),
      [models],
    ),
    onExpandedChange: onItemExpand,
  });

  const hasNextPage = collection?.hasNextPage ?? false;
  const isFetchingNextPage = collection?.isFetchingNextPage ?? false;
  const onEndReached = React.useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) collection?.fetchNextPage?.();
  }, [hasNextPage, isFetchingNextPage, collection]);

  return { items: models, expandedIds, isExpanded, toggle, setExpanded, onEndReached, hasNextPage, isFetchingNextPage };
}
