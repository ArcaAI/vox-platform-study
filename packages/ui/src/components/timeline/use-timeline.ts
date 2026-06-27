'use client';

import * as React from 'react';

import type { AsyncCollection } from '@/lib/shared';

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

  const isControlled = expansion?.value != null;
  const mode = expansion?.mode ?? 'multiple';

  const [internal, setInternal] = React.useState<string[]>(() => models.filter((m) => m.defaultExpanded).map((m) => m.id));
  const expandedIds = isControlled ? expansion!.value! : internal;

  const setExpanded = React.useCallback(
    (id: string, expanded: boolean) => {
      const has = expandedIds.includes(id);
      if (expanded === has) return;
      const next = expanded ? (mode === 'single' ? [id] : [...expandedIds, id]) : expandedIds.filter((x) => x !== id);
      if (!isControlled) setInternal(next);
      expansion?.onChange?.(next);
      onItemExpand?.(id, expanded);
    },
    [expandedIds, isControlled, mode, expansion, onItemExpand],
  );

  const toggle = React.useCallback((id: string) => setExpanded(id, !expandedIds.includes(id)), [expandedIds, setExpanded]);
  const isExpanded = React.useCallback((id: string) => expandedIds.includes(id), [expandedIds]);

  const hasNextPage = collection?.hasNextPage ?? false;
  const isFetchingNextPage = collection?.isFetchingNextPage ?? false;
  const onEndReached = React.useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) collection?.fetchNextPage?.();
  }, [hasNextPage, isFetchingNextPage, collection]);

  return { items: models, expandedIds, isExpanded, toggle, setExpanded, onEndReached, hasNextPage, isFetchingNextPage };
}
