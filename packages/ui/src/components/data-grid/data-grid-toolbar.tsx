'use client';

import { Check, Rows2, Rows3, Search, Settings2, X } from 'lucide-react';
import * as React from 'react';

import { Button } from '@/components/shadcn/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/shadcn/command';
import { Input } from '@/components/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { cn } from '@/lib/utils';

import { DataGridFacetedFilter } from './data-grid-faceted-filter';
import type { UseDataGridResult } from './use-data-grid';

export interface DataGridToolbarProps<TData> {
  grid: UseDataGridResult<TData>;
  searchPlaceholder?: string;
  className?: string;
  children?: React.ReactNode;
}

export function DataGridToolbar<TData>({ grid, searchPlaceholder = 'Search…', className, children }: DataGridToolbarProps<TData>) {
  const { table, features, density, setDensity, queryState } = grid;
  const [search, setSearch] = React.useState(queryState.globalSearch ?? '');

  const filterableColumns = features.facetedFilters ? table.getAllColumns().filter((c) => c.getCanFilter() && c.columnDef.meta?.variant) : [];

  const hasActiveFilters = queryState.filters.length > 0 || (queryState.globalSearch ?? '') !== '';

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {features.globalSearch && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              grid.setGlobalSearch(e.target.value);
            }}
            placeholder={searchPlaceholder}
            className="h-8 w-40 pl-8 lg:w-56"
          />
        </div>
      )}

      {filterableColumns.map((column) => (
        <DataGridFacetedFilter key={column.id} column={column} grid={grid} title={column.columnDef.meta?.label ?? column.id} />
      ))}

      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          onClick={() => {
            setSearch('');
            grid.setQueryState({ ...queryState, filters: [], globalSearch: '' });
          }}
        >
          Reset
          <X className="size-4" />
        </Button>
      )}

      <div className="ml-auto flex items-center gap-2">
        {children}

        <Button
          variant="outline"
          size="icon"
          className="size-8"
          title="Toggle density"
          aria-label={density === 'compact' ? 'Switch to comfortable density' : 'Switch to compact density'}
          aria-pressed={density === 'compact'}
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        >
          {density === 'compact' ? <Rows3 /> : <Rows2 />}
        </Button>

        {features.columnVisibility && <ViewOptions grid={grid} />}
      </div>
    </div>
  );
}

function ViewOptions<TData>({ grid }: { grid: UseDataGridResult<TData> }) {
  const columns = grid.table.getAllColumns().filter((c) => typeof c.accessorFn !== 'undefined' && c.getCanHide());

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label="Toggle columns" role="combobox" variant="outline" size="sm" className="h-8">
          <Settings2 className="text-muted-foreground" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="end">
        <Command>
          <CommandInput placeholder="Search columns…" />
          <CommandList>
            <CommandEmpty>No columns found.</CommandEmpty>
            <CommandGroup>
              {columns.map((column) => (
                <CommandItem key={column.id} onSelect={() => column.toggleVisibility(!column.getIsVisible())}>
                  <span className="truncate">{column.columnDef.meta?.label ?? column.id}</span>
                  <Check className={cn('ml-auto size-4 shrink-0', column.getIsVisible() ? 'opacity-100' : 'opacity-0')} />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
