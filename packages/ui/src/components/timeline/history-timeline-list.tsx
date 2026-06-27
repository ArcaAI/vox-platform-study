'use client';

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Inbox, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/shadcn/button';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';

import { resolveRenderer as resolveDefaultRenderer } from './renderers/registry';
import { TimelineItem } from './timeline-item';
import { useTimeline } from './use-timeline';
import type { HistoryTimelineListProps, TimelineContentVariant, TimelineItemModel, TimelineRenderer } from './types';

export function HistoryTimelineList<TItem = TimelineItemModel>(props: HistoryTimelineListProps<TItem>) {
  const {
    items,
    order,
    mapItem,
    collection,
    renderers,
    expansion,
    onItemExpand,
    onMediaOpen,
    onRetry,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
    density = 'comfortable',
    estimateItemHeight = 96,
    lazyMedia = true,
    height = 560,
    className,
  } = props;

  const timeline = useTimeline<TItem>({ items, order, mapItem, collection, expansion, onItemExpand });
  const models = timeline.items;

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: models.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateItemHeight,
    overscan: 6,
    getItemKey: (index) => models[index]?.id ?? index,
  });

  const resolve = React.useCallback((variant: TimelineContentVariant): TimelineRenderer => resolveDefaultRenderer(variant, renderers), [renderers]);

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.length ? virtualItems[virtualItems.length - 1].index : -1;
  React.useEffect(() => {
    if (models.length > 0 && lastIndex >= models.length - 1) timeline.onEndReached();
    // timeline.onEndReached is stable per collection state; deps are intentionally limited.
  }, [lastIndex, models.length]);

  const showError = error ?? collection?.error ?? null;
  const loading = isLoading ?? collection?.isLoading ?? false;

  const wrapperProps = {
    'data-slot': 'history-timeline-list',
    'data-density': density,
    className: cn('w-full', className),
  } as const;

  if (loading && models.length === 0) {
    return (
      <div {...wrapperProps}>
        {loadingState ?? (
          <div role="status" aria-label="Loading history" className="space-y-3 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        )}
      </div>
    );
  }

  if (showError && models.length === 0) {
    return (
      <div {...wrapperProps}>
        {errorState?.(showError) ?? (
          <div role="alert" className="flex flex-col items-center justify-center gap-3 p-10 text-center">
            <TriangleAlert className="size-10 text-destructive" />
            <div>
              <p className="font-medium">Something went wrong</p>
              <p className="text-sm text-muted-foreground">{showError.message}</p>
            </div>
            {onRetry ? (
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCcw className="size-4" />
                Retry
              </Button>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div {...wrapperProps}>
        {emptyState ?? (
          <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <Inbox className="size-10 text-muted-foreground/50" />
            <p className="font-medium">No history yet</p>
            <p className="text-sm text-muted-foreground">Items from this consultation will appear here.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div {...wrapperProps}>
      <div
        ref={scrollRef}
        role="feed"
        aria-label={props['aria-label'] ?? 'History timeline'}
        aria-busy={loading || undefined}
        className="relative overflow-auto rounded-md border bg-card"
        style={{ height: typeof height === 'number' ? `${height}px` : height }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((virtualItem) => {
            const model = models[virtualItem.index];
            if (!model) return null;
            return (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` }}
              >
                <TimelineItem
                  item={model}
                  expanded={timeline.isExpanded(model.id)}
                  density={density}
                  lazyMedia={lazyMedia}
                  posInSet={virtualItem.index + 1}
                  setSize={models.length}
                  resolveRenderer={resolve}
                  onToggle={timeline.toggle}
                  onMediaOpen={onMediaOpen}
                />
              </div>
            );
          })}
        </div>
      </div>

      {timeline.isFetchingNextPage ? (
        <div data-testid="timeline-loading-more" role="status" aria-label="Loading more" className="space-y-2 p-2">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
    </div>
  );
}
