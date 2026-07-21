'use client';

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, Inbox, TriangleAlert } from 'lucide-react';

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/empty';
import { Skeleton } from '@/components/shadcn/skeleton';
import { DENSITY_ROW_HEIGHT, useExpansion, type AsyncStateProps, type BaseSurfaceProps } from '@/lib/shared';
import { cn } from '@/lib/utils';

export interface ItemListProps<T> extends BaseSurfaceProps, AsyncStateProps {
  items: T[];
  getItemId: (item: T) => string;
  /** Collapsed row content (icon · primary · meta · status · duration). */
  renderRow: (item: T) => React.ReactNode;
  /** Expandable detail panel revealed beneath the row. */
  renderDetail?: (item: T) => React.ReactNode;
  expansion?: { value?: string[]; onChange?: (ids: string[]) => void; mode?: 'single' | 'multiple' };
  onRowClick?: (id: string) => void;
  /** Opt-in virtualization for large lists. */
  virtualized?: boolean;
  height?: number | string;
  /** Skeleton row count while loading (default 5). */
  skeletonCount?: number;
  'aria-label'?: string;
}

/**
 * Expandable item-list foundation. Full-width rows with a
 * disclosure that reveals a detail panel; roving-tabindex keyboard model; density;
 * optional `@tanstack/react-virtual` virtualization. Expansion is delegated to the
 * shared `useExpansion` controller (single/multiple, controlled/uncontrolled).
 */
export function ItemList<T>(props: ItemListProps<T>) {
  const {
    items,
    getItemId,
    renderRow,
    renderDetail,
    expansion,
    onRowClick,
    virtualized = false,
    height = 480,
    skeletonCount = 5,
    density = 'comfortable',
    className,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
  } = props;
  const ariaLabel = props['aria-label'];
  const hasDetail = !!renderDetail;

  const { isExpanded, toggle, setExpanded } = useExpansion({
    value: expansion?.value,
    onChange: expansion?.onChange,
    mode: expansion?.mode,
  });

  const [activeIndex, setActiveIndex] = React.useState(0);
  const triggerRefs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => DENSITY_ROW_HEIGHT[density],
    overscan: 8,
  });

  const focusRow = (index: number) => {
    const next = Math.max(0, Math.min(index, items.length - 1));
    setActiveIndex(next);
    triggerRefs.current[next]?.focus();
  };

  const activate = (id: string) => {
    onRowClick?.(id);
    if (hasDetail) toggle(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number, id: string) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        activate(id);
        break;
      case 'ArrowRight':
        if (hasDetail) {
          e.preventDefault();
          setExpanded(id, true);
        }
        break;
      case 'ArrowLeft':
        if (hasDetail) {
          e.preventDefault();
          setExpanded(id, false);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(items.length - 1);
        break;
    }
  };

  const wrapperProps = {
    'data-slot': 'item-list',
    'data-density': density,
    className: cn('w-full', className),
  } as const;

  if (isLoading && items.length === 0) {
    return (
      <div {...wrapperProps}>
        {loadingState ?? (
          <div role="status" aria-label="Loading" className="divide-y rounded-md border">
            {Array.from({ length: skeletonCount }).map((_, i) => (
              <div key={i} className={cn('flex items-center gap-3 px-4', density === 'compact' ? 'py-2' : 'py-3')}>
                <Skeleton className="size-5 rounded-md" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ml-auto h-4 w-16" />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div {...wrapperProps}>
        {errorState?.(error) ?? (
          <div role="alert" className="flex flex-col items-center justify-center gap-2 p-10 text-center">
            <TriangleAlert className="size-10 text-destructive" />
            <p className="font-medium">Something went wrong</p>
            <p className="text-sm text-muted-foreground">{error.message}</p>
          </div>
        )}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div {...wrapperProps}>
        {emptyState ?? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>Nothing here yet</EmptyTitle>
              <EmptyDescription>Items will appear here once there is activity.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  }

  const interactive = hasDetail || !!onRowClick;

  // The `extra` props graft virtualization onto the SAME `listitem` element so the
  // accessible `role="list"` always directly owns `role="listitem"` children.
  const renderRow_ = (item: T, index: number, extra?: { ref: (el: HTMLElement | null) => void; style: React.CSSProperties }) => {
    const id = getItemId(item);
    const expanded = isExpanded(id);
    const detailId = `item-list-${id}-detail`;
    const rowBody = <span className="flex min-w-0 flex-1 items-center gap-3 text-left">{renderRow(item)}</span>;

    return (
      <div
        key={id}
        role="listitem"
        data-slot="item-list-row"
        data-state={expanded ? 'expanded' : 'collapsed'}
        data-index={extra ? index : undefined}
        ref={extra?.ref}
        style={extra?.style}
        className="border-b last:border-b-0"
      >
        {interactive ? (
          <button
            type="button"
            ref={(el) => {
              triggerRefs.current[index] = el;
            }}
            data-slot="item-list-row-trigger"
            aria-expanded={hasDetail ? expanded : undefined}
            aria-controls={hasDetail && expanded ? detailId : undefined}
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => activate(id)}
            onKeyDown={(e) => handleKeyDown(e, index, id)}
            className={cn(
              'flex w-full items-center gap-3 px-4 outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
              density === 'compact' ? 'min-h-9 py-2' : 'min-h-12 py-3',
            )}
          >
            {rowBody}
            {hasDetail ? (
              <ChevronRight
                aria-hidden="true"
                className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
              />
            ) : null}
          </button>
        ) : (
          <div className={cn('flex w-full items-center gap-3 px-4', density === 'compact' ? 'min-h-9 py-2' : 'min-h-12 py-3')}>{rowBody}</div>
        )}
        {hasDetail && expanded ? (
          <div id={detailId} data-slot="item-list-detail" className={cn('bg-muted/40 px-4', density === 'compact' ? 'py-2' : 'py-3')}>
            {renderDetail!(item)}
          </div>
        ) : null}
      </div>
    );
  };

  if (virtualized) {
    return (
      <div {...wrapperProps}>
        <div ref={scrollRef} className="overflow-auto rounded-md border" style={{ height: typeof height === 'number' ? `${height}px` : height }}>
          <div role="list" aria-label={ariaLabel} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((virtualItem) => {
              const item = items[virtualItem.index];
              if (!item) return null;
              return renderRow_(item, virtualItem.index, {
                ref: virtualizer.measureElement,
                style: { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualItem.start}px)` },
              });
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div {...wrapperProps}>
      <div role="list" aria-label={ariaLabel} className="rounded-md border">
        {items.map((item, index) => renderRow_(item, index))}
      </div>
    </div>
  );
}
