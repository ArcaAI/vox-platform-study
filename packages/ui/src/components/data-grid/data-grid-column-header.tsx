'use client';

import type { Column } from '@tanstack/react-table';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronsUpDown, ChevronUp, EyeOff, Filter, PinOff, X } from 'lucide-react';
import { IconPinned } from '@tabler/icons-react';
import * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/shadcn/popover';
import { cn } from '@/lib/utils';

import { FilterControlBody } from './data-grid-faceted-filter';
import type { UseDataGridResult } from './use-data-grid';

interface DataGridColumnHeaderProps<TData, TValue> extends React.ComponentProps<typeof DropdownMenuTrigger> {
  column: Column<TData, TValue>;
  label: string;
  enablePinning?: boolean;
  dragHandle?: React.ReactNode;
  /** When provided, unlocks header-menu "Move left/right" (Δ4) and "Filter…" (Δ6). */
  grid?: UseDataGridResult<TData>;
}

export function DataGridColumnHeader<TData, TValue>({
  column,
  label,
  enablePinning,
  dragHandle,
  grid,
  className,
  ...props
}: DataGridColumnHeaderProps<TData, TValue>) {
  const sorted = column.getIsSorted();
  const pinned = column.getIsPinned();
  const [filterOpen, setFilterOpen] = React.useState(false);

  const canReorder = Boolean(grid?.features.columnReorder);
  const canFilter = Boolean(grid && column.getCanFilter() && column.columnDef.meta?.variant);

  const pinGlyph = pinned ? <IconPinned aria-hidden className="size-3 shrink-0 text-muted-foreground" /> : null;

  if (!column.getCanSort() && !column.getCanHide() && !enablePinning && !canReorder && !canFilter) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        {dragHandle}
        {pinGlyph}
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {dragHandle}
      {pinGlyph}
      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <DropdownMenu>
          <PopoverAnchor asChild>
            <DropdownMenuTrigger
              aria-label={`${label} column options`}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
                // Pull the label back to the cell padding ONLY when no drag handle
                // sits beside it — overlapping the handle fails axe target-offset
                // (adjacent interactive targets need clear spacing, WCAG 2.5.8).
                !dragHandle && '-ml-1.5',
                className,
              )}
              {...props}
            >
              {label}
              {column.getCanSort() && (sorted === 'desc' ? <ChevronDown /> : sorted === 'asc' ? <ChevronUp /> : <ChevronsUpDown />)}
            </DropdownMenuTrigger>
          </PopoverAnchor>
          <DropdownMenuContent align="start" className="w-40">
            {column.getCanSort() && (
              <>
                <DropdownMenuCheckboxItem checked={sorted === 'asc'} onClick={() => column.toggleSorting(false)}>
                  <ChevronUp />
                  Asc
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={sorted === 'desc'} onClick={() => column.toggleSorting(true)}>
                  <ChevronDown />
                  Desc
                </DropdownMenuCheckboxItem>
                {sorted && (
                  <DropdownMenuItem onClick={() => column.clearSorting()}>
                    <X />
                    Reset
                  </DropdownMenuItem>
                )}
              </>
            )}

            {canReorder && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => grid?.moveColumnDirection(column.id, 'left')}>
                  <ArrowLeft />
                  Move left
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => grid?.moveColumnDirection(column.id, 'right')}>
                  <ArrowRight />
                  Move right
                </DropdownMenuItem>
              </>
            )}

            {enablePinning && column.getCanPin() && (
              <>
                <DropdownMenuSeparator />
                {pinned !== 'left' && (
                  <DropdownMenuItem onClick={() => column.pin('left')}>
                    <IconPinned />
                    Pin left
                  </DropdownMenuItem>
                )}
                {pinned !== 'right' && (
                  <DropdownMenuItem onClick={() => column.pin('right')}>
                    <IconPinned />
                    Pin right
                  </DropdownMenuItem>
                )}
                {pinned && (
                  <DropdownMenuItem onClick={() => column.pin(false)}>
                    <PinOff />
                    Unpin
                  </DropdownMenuItem>
                )}
              </>
            )}

            {canFilter && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    // Let the menu close before opening the anchored filter popover.
                    setTimeout(() => setFilterOpen(true), 0);
                  }}
                >
                  <Filter />
                  Filter…
                </DropdownMenuItem>
              </>
            )}

            {column.getCanHide() && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => column.toggleVisibility(false)}>
                  <EyeOff />
                  Hide
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {canFilter && grid && (
          <PopoverContent align="start" className="w-auto min-w-64 p-0">
            <FilterControlBody column={column} grid={grid} title={label} />
          </PopoverContent>
        )}
      </Popover>
    </div>
  );
}
