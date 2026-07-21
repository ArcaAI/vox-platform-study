'use client';

import * as React from 'react';
import { Inbox, TriangleAlert } from 'lucide-react';

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/shadcn/empty';
import { Skeleton } from '@/components/shadcn/skeleton';
import type { AsyncStateProps, BaseSurfaceProps } from '@/lib/shared';
import { cn } from '@/lib/utils';

export interface CardGridProps<T> extends BaseSurfaceProps, AsyncStateProps {
  items: T[];
  getItemId: (item: T) => string;
  renderCard: (item: T, state: { selected: boolean }) => React.ReactNode;
  /** Auto-fill minimum column width in px (default 280). */
  minColumnWidth?: number;
  selectedId?: string;
  onSelect?: (id: string) => void;
  /** Skeleton card count while loading (default 6). */
  skeletonCount?: number;
  'aria-label'?: string;
}

/**
 * Responsive auto-fill collection grid. Builds the grid wrapper +
 * selection/roving-tabindex/states; consumers render each card (typically `EntityCard`)
 * via `renderCard`. ARIA grid pattern: grid → row → gridcell with `aria-selected`.
 */
export function CardGrid<T>(props: CardGridProps<T>) {
  const {
    items,
    getItemId,
    renderCard,
    minColumnWidth = 280,
    selectedId,
    onSelect,
    skeletonCount = 6,
    density = 'comfortable',
    className,
    isLoading,
    error,
    emptyState,
    errorState,
    loadingState,
  } = props;
  const ariaLabel = props['aria-label'];
  const selectable = !!onSelect;

  const [activeIndex, setActiveIndex] = React.useState(0);
  const cellRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const gridStyle: React.CSSProperties = { gridTemplateColumns: `repeat(auto-fill, minmax(${minColumnWidth}px, 1fr))` };

  const focusCell = (index: number) => {
    const next = Math.max(0, Math.min(index, items.length - 1));
    setActiveIndex(next);
    cellRefs.current[next]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number, id: string) => {
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect?.(id);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        focusCell(index + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        focusCell(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusCell(0);
        break;
      case 'End':
        e.preventDefault();
        focusCell(items.length - 1);
        break;
    }
  };

  if (isLoading && items.length === 0) {
    return (
      <div data-slot="card-grid" data-density={density} role="status" aria-label="Loading" className={cn('grid gap-6', className)} style={gridStyle}>
        {loadingState ??
          Array.from({ length: skeletonCount }).map((_, i) => (
            <Skeleton key={i} className={cn('w-full rounded-xl', density === 'compact' ? 'h-24' : 'h-32')} />
          ))}
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div data-slot="card-grid" data-density={density} className={cn('w-full', className)}>
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
      <div data-slot="card-grid" data-density={density} className={cn('w-full', className)}>
        {emptyState ?? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>No items</EmptyTitle>
              <EmptyDescription>Items will appear here once they are created.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  }

  return (
    <div data-slot="card-grid" data-density={density} role="grid" aria-label={ariaLabel} className={cn('grid gap-6', className)} style={gridStyle}>
      <div role="row" className="contents">
        {items.map((item, index) => {
          const id = getItemId(item);
          const selected = selectedId === id;
          return (
            <div
              key={id}
              ref={(el) => {
                cellRefs.current[index] = el;
              }}
              role="gridcell"
              aria-selected={selectable ? selected : undefined}
              tabIndex={selectable ? (index === activeIndex ? 0 : -1) : undefined}
              onClick={selectable ? () => onSelect?.(id) : undefined}
              onKeyDown={selectable ? (e) => handleKeyDown(e, index, id) : undefined}
              onFocus={selectable ? () => setActiveIndex(index) : undefined}
              className={cn('rounded-xl outline-none', selectable && 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2')}
            >
              {renderCard(item, { selected })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
