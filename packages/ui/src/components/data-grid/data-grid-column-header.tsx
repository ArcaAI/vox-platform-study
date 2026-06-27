'use client';

import type { Column } from '@tanstack/react-table';
import { ChevronDown, ChevronsUpDown, ChevronUp, EyeOff, PinOff, X } from 'lucide-react';
import { IconPinned } from '@tabler/icons-react';
import type * as React from 'react';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import { cn } from '@/lib/utils';

interface DataGridColumnHeaderProps<TData, TValue> extends React.ComponentProps<typeof DropdownMenuTrigger> {
  column: Column<TData, TValue>;
  label: string;
  enablePinning?: boolean;
  dragHandle?: React.ReactNode;
}

export function DataGridColumnHeader<TData, TValue>({
  column,
  label,
  enablePinning,
  dragHandle,
  className,
  ...props
}: DataGridColumnHeaderProps<TData, TValue>) {
  const sorted = column.getIsSorted();

  if (!column.getCanSort() && !column.getCanHide() && !enablePinning) {
    return (
      <div className={cn('flex items-center gap-1', className)}>
        {dragHandle}
        <span>{label}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {dragHandle}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${label} column options`}
          className={cn(
            '-ml-1.5 flex h-8 items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring data-[state=open]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
            className,
          )}
          {...props}
        >
          {label}
          {column.getCanSort() && (sorted === 'desc' ? <ChevronDown /> : sorted === 'asc' ? <ChevronUp /> : <ChevronsUpDown />)}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-36">
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
          {enablePinning && column.getCanPin() && (
            <>
              {(column.getCanSort() || column.getCanHide()) && <DropdownMenuSeparator />}
              {column.getIsPinned() !== 'left' && (
                <DropdownMenuItem onClick={() => column.pin('left')}>
                  <IconPinned />
                  Pin left
                </DropdownMenuItem>
              )}
              {column.getIsPinned() !== 'right' && (
                <DropdownMenuItem onClick={() => column.pin('right')}>
                  <IconPinned />
                  Pin right
                </DropdownMenuItem>
              )}
              {column.getIsPinned() && (
                <DropdownMenuItem onClick={() => column.pin(false)}>
                  <PinOff />
                  Unpin
                </DropdownMenuItem>
              )}
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
    </div>
  );
}
