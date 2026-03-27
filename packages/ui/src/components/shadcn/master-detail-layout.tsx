import * as React from 'react';

import { cn } from '@/lib/utils';
import { ScrollArea } from './scroll-area';
import { Skeleton } from './skeleton';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from './empty';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MasterDetailColumnDefinition<TItem = unknown> {
  id: string;
  title: string | React.ReactNode;
  description?: string | React.ReactNode;
  icon?: React.ReactNode;
  width?: string;
  skeletonCount?: number;
  skeletonHeight?: string;
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  renderItem: (item: TItem, context: MasterDetailColumnContext) => React.ReactNode;
  keyExtractor: (item: TItem) => string;
}

interface MasterDetailColumnContext {
  selectedId: string | null;
  columnIndex: number;
}

interface MasterDetailColumnState<TItem = unknown> {
  data: TItem[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  enabled?: boolean;
}

interface MasterDetailLayoutProps {
  columns: MasterDetailColumnDefinition[];
  states: MasterDetailColumnState[];
  height?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MasterDetailRoot({ className, style, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="master-detail" className={cn('grid overflow-hidden rounded-lg border', className)} style={style} {...props}>
      {children}
    </div>
  );
}

function MasterDetailColumn({ className, isLast, children, ...props }: React.ComponentProps<'div'> & { isLast?: boolean }) {
  return (
    <div data-slot="master-detail-column" className={cn('flex flex-col', !isLast && 'border-r', className)} {...props}>
      {children}
    </div>
  );
}

function MasterDetailColumnHeader({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="master-detail-column-header" className={cn('flex min-h-14 flex-col justify-center border-b px-4 py-3', className)} {...props}>
      {children}
    </div>
  );
}

function MasterDetailColumnTitle({ className, ...props }: React.ComponentProps<'h3'>) {
  return <h3 data-slot="master-detail-column-title" className={cn('text-sm font-semibold', className)} {...props} />;
}

function MasterDetailColumnDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="master-detail-column-description" className={cn('text-muted-foreground text-xs', className)} {...props} />;
}

function MasterDetailItem({
  className,
  isSelected,
  onClick,
  onKeyDown,
  ...props
}: React.ComponentProps<'div'> & {
  isSelected?: boolean;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}) {
  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown?.(event);
      if (event.defaultPrevented) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.currentTarget.click();
      }
    },
    [onKeyDown],
  );

  return (
    <div
      data-slot="master-detail-item"
      data-selected={isSelected || undefined}
      role="button"
      tabIndex={0}
      className={cn(
        'w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'bg-accent border-l-2 border-l-primary',
        className,
      )}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}

function MasterDetailSkeleton({ count = 3, height = 'h-16', className }: { count?: number; height?: string; className?: string }) {
  return (
    <div data-slot="master-detail-skeleton" className={cn('flex flex-col gap-2 p-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn('w-full rounded-md', height)} />
      ))}
    </div>
  );
}

function MasterDetailEmpty({
  icon,
  title,
  description,
  className,
}: {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
  className?: string;
}) {
  return (
    <Empty className={cn('border-0 py-16', className)}>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        {title && <EmptyTitle className="text-sm">{title}</EmptyTitle>}
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  );
}

// ---------------------------------------------------------------------------
// Composed layout
// ---------------------------------------------------------------------------

function MasterDetailLayout({ columns, states, height = 'calc(100vh - 20rem)', className }: MasterDetailLayoutProps) {
  const colCount = columns.length;

  return (
    <MasterDetailRoot
      className={className}
      style={{
        height,
        gridTemplateColumns: columns.map((col) => col.width ?? '1fr').join(' '),
      }}
    >
      {columns.map((col, idx) => {
        const state = states[idx];
        if (!state) return null;

        const isLast = idx === colCount - 1;
        const enabled = state.enabled !== false;

        return (
          <MasterDetailColumn key={col.id} isLast={isLast}>
            <MasterDetailColumnHeader>
              {typeof col.title === 'string' ? <MasterDetailColumnTitle>{col.title}</MasterDetailColumnTitle> : col.title}
              {col.description &&
                (typeof col.description === 'string' ? (
                  <MasterDetailColumnDescription>{col.description}</MasterDetailColumnDescription>
                ) : (
                  col.description
                ))}
            </MasterDetailColumnHeader>

            <ScrollArea className="flex-1">
              {!enabled ? (
                <MasterDetailEmpty
                  icon={col.emptyIcon}
                  title={col.emptyTitle ?? 'No selection'}
                  description={col.emptyDescription ?? 'Select an item from the previous column.'}
                />
              ) : state.isLoading ? (
                <MasterDetailSkeleton count={col.skeletonCount ?? 3} height={col.skeletonHeight ?? 'h-16'} />
              ) : state.data.length === 0 ? (
                <MasterDetailEmpty
                  icon={col.emptyIcon}
                  title={col.emptyTitle ?? 'No items'}
                  description={col.emptyDescription ?? 'No items found.'}
                />
              ) : (
                <div data-slot="master-detail-list" className="divide-y">
                  {state.data.map((item) => {
                    const key = col.keyExtractor(item);
                    return (
                      <MasterDetailItem
                        key={key}
                        isSelected={state.selectedId === key}
                        onClick={() => state.onSelect(key)}
                        data-testid={`${col.id}-item-${key}`}
                      >
                        {col.renderItem(item, {
                          selectedId: state.selectedId,
                          columnIndex: idx,
                        })}
                      </MasterDetailItem>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </MasterDetailColumn>
        );
      })}
    </MasterDetailRoot>
  );
}

// ---------------------------------------------------------------------------
// Detail column (non-selectable, renders custom content)
// ---------------------------------------------------------------------------

interface MasterDetailDetailColumnDefinition {
  id: string;
  title: string | React.ReactNode;
  description?: string | React.ReactNode;
  width?: string;
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
}

interface MasterDetailDetailState {
  hasSelection: boolean;
  content: React.ReactNode;
}

interface MasterDetailComposedProps {
  listColumns: MasterDetailColumnDefinition[];
  listStates: MasterDetailColumnState[];
  detailColumn?: MasterDetailDetailColumnDefinition;
  detailState?: MasterDetailDetailState;
  height?: string;
  className?: string;
}

function MasterDetailComposed({
  listColumns,
  listStates,
  detailColumn,
  detailState,
  height = 'calc(100vh - 20rem)',
  className,
}: MasterDetailComposedProps) {
  const allWidths = [...listColumns.map((c) => c.width ?? '1fr'), ...(detailColumn ? [detailColumn.width ?? '1fr'] : [])];

  return (
    <MasterDetailRoot
      className={className}
      style={{
        height,
        gridTemplateColumns: allWidths.join(' '),
      }}
    >
      {listColumns.map((col, idx) => {
        const state = listStates[idx];
        if (!state) return null;

        const enabled = state.enabled !== false;

        return (
          <MasterDetailColumn key={col.id} isLast={false}>
            <MasterDetailColumnHeader>
              {typeof col.title === 'string' ? <MasterDetailColumnTitle>{col.title}</MasterDetailColumnTitle> : col.title}
              {col.description &&
                (typeof col.description === 'string' ? (
                  <MasterDetailColumnDescription>{col.description}</MasterDetailColumnDescription>
                ) : (
                  col.description
                ))}
            </MasterDetailColumnHeader>

            <ScrollArea className="flex-1">
              {!enabled ? (
                <MasterDetailEmpty
                  icon={col.emptyIcon}
                  title={col.emptyTitle ?? 'No selection'}
                  description={col.emptyDescription ?? 'Select an item from the previous column.'}
                />
              ) : state.isLoading ? (
                <MasterDetailSkeleton count={col.skeletonCount ?? 3} height={col.skeletonHeight ?? 'h-16'} />
              ) : state.data.length === 0 ? (
                <MasterDetailEmpty
                  icon={col.emptyIcon}
                  title={col.emptyTitle ?? 'No items'}
                  description={col.emptyDescription ?? 'No items found.'}
                />
              ) : (
                <div data-slot="master-detail-list" className="divide-y">
                  {state.data.map((item) => {
                    const key = col.keyExtractor(item);
                    return (
                      <MasterDetailItem
                        key={key}
                        isSelected={state.selectedId === key}
                        onClick={() => state.onSelect(key)}
                        data-testid={`${col.id}-item-${key}`}
                      >
                        {col.renderItem(item, {
                          selectedId: state.selectedId,
                          columnIndex: idx,
                        })}
                      </MasterDetailItem>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </MasterDetailColumn>
        );
      })}

      {detailColumn && detailState && (
        <MasterDetailColumn key={detailColumn.id} isLast>
          <MasterDetailColumnHeader>
            {typeof detailColumn.title === 'string' ? <MasterDetailColumnTitle>{detailColumn.title}</MasterDetailColumnTitle> : detailColumn.title}
            {detailColumn.description &&
              (typeof detailColumn.description === 'string' ? (
                <MasterDetailColumnDescription>{detailColumn.description}</MasterDetailColumnDescription>
              ) : (
                detailColumn.description
              ))}
          </MasterDetailColumnHeader>

          <ScrollArea className="flex-1">
            {!detailState.hasSelection ? (
              <MasterDetailEmpty
                icon={detailColumn.emptyIcon}
                title={detailColumn.emptyTitle ?? 'No selection'}
                description={detailColumn.emptyDescription ?? 'Select an item to view details.'}
              />
            ) : (
              detailState.content
            )}
          </ScrollArea>
        </MasterDetailColumn>
      )}
    </MasterDetailRoot>
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  MasterDetailLayout,
  MasterDetailComposed,
  MasterDetailRoot,
  MasterDetailColumn,
  MasterDetailColumnHeader,
  MasterDetailColumnTitle,
  MasterDetailColumnDescription,
  MasterDetailItem,
  MasterDetailSkeleton,
  MasterDetailEmpty,
};

export type {
  MasterDetailColumnDefinition,
  MasterDetailColumnContext,
  MasterDetailColumnState,
  MasterDetailLayoutProps,
  MasterDetailDetailColumnDefinition,
  MasterDetailDetailState,
  MasterDetailComposedProps,
};
