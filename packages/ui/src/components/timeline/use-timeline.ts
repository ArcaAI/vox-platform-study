'use client';

import * as React from 'react';

import { useExpansion, type AsyncCollection } from '@/lib/shared';

import type { TimelineExpansion, TimelineItemModel } from './types';

export interface UseTimelineParams<TItem = TimelineItemModel> {
  items: TItem[];
  order?: 'desc' | 'asc';
  mapItem?: (raw: TItem) => TimelineItemModel;
  collection?: AsyncCollection<TItem>;
  expansion?: TimelineExpansion;
  onItemExpand?: (id: string, expanded: boolean) => void;
}

export interface UseTimelineResult {
  items: TimelineItemModel[];
  expandedIds: string[];
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
  setExpanded: (id: string, expanded: boolean) => void;
  onEndReached: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
}

/**
 * Headless controller for `HistoryTimelineList` (TASK-372 §3.5): ordering,
 * expansion (controlled or uncontrolled; single/multiple), and infinite-scroll
 * triggering against a transport-agnostic `AsyncCollection` (D5).
 */
export function useTimeline<TItem = TimelineItemModel>(params: UseTimelineParams<TItem>): UseTimelineResult {
  const { items, order = 'desc', mapItem, collection, expansion, onItemExpand } = params;

  const models = React.useMemo<TimelineItemModel[]>(() => {
    const mapped = mapItem ? items.map(mapItem) : (items as unknown as TimelineItemModel[]);
    // Input is newest-first by contract; only `asc` reorders.
    return order === 'asc' ? [...mapped].reverse() : mapped;
  }, [items, order, mapItem]);

  const { expandedIds, isExpanded, toggle, setExpanded } = useExpansion({
    value: expansion?.value,
    onChange: expansion?.onChange,
    mode: expansion?.mode,
    defaultExpandedIds: React.useMemo(() => models.filter((m) => m.defaultExpanded).map((m) => m.id), [models]),
    onExpandedChange: onItemExpand,
  });

  const hasNextPage = collection?.hasNextPage ?? false;
  const isFetchingNextPage = collection?.isFetchingNextPage ?? false;
  const onEndReached = React.useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) collection?.fetchNextPage?.();
  }, [hasNextPage, isFetchingNextPage, collection]);

  return { items: models, expandedIds, isExpanded, toggle, setExpanded, onEndReached, hasNextPage, isFetchingNextPage };
}
