'use client';

import { Check, RotateCcw, Rows2, Rows3, Search, Settings2, SlidersHorizontal, X } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/shadcn/command';
import { Input } from '@/components/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Separator } from '@/components/shadcn/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/shadcn/sheet';
import { ToggleGroup, ToggleGroupItem } from '@/components/shadcn/toggle-group';
import type { Density } from '@/lib/shared/surface';
import { cn } from '@/lib/utils';

import { DataGridFacetedFilter, FilterControlBody } from './data-grid-faceted-filter';
import { useContainerBreakpoint } from './use-container-breakpoint';
import type { RowData } from '@tanstack/react-table';
import type { UseDataGridResult } from './use-data-grid';

export interface DataGridToolbarProps<TData extends RowData> {
  grid: UseDataGridResult<TData>;
  searchPlaceholder?: string;
  className?: string;
  children?: React.ReactNode;
}

function columnLabel(column: { id: string; columnDef: { meta?: { label?: string } } }): string {
  return column.columnDef.meta?.label ?? column.id;
}

export function DataGridToolbar<TData extends RowData>({ grid, searchPlaceholder = 'Search…', className, children }: DataGridToolbarProps<TData>) {
  const { table, features, density, setDensity, queryState } = grid;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const { bp } = useContainerBreakpoint(rootRef);
  const inline = bp === 'lg' || bp === 'xl'; // ≥1024: everything inline
  const useSheet = bp === 'base' || bp === 'sm'; // <768: collapse into a bottom Sheet

  const [search, setSearch] = React.useState(queryState.globalSearch ?? '');

  const filterableColumns = features.facetedFilters ? table.getAllColumns().filter((c) => c.getCanFilter() && c.columnDef.meta?.variant) : [];
  const activeCount = queryState.filters.length;
  const hasActiveFilters = activeCount > 0 || (queryState.globalSearch ?? '') !== '';

  const clearAll = () => {
    setSearch('');
    grid.setQueryState({ ...queryState, filters: [], globalSearch: '' });
  };

  return (
    <div ref={rootRef} className={cn('flex flex-wrap items-center gap-2', className)}>
      {features.globalSearch && (
        <div className={cn('relative', inline ? 'w-64' : bp === 'md' ? 'min-w-40 flex-1' : 'w-full')}>
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              grid.setGlobalSearch(e.target.value);
            }}
            placeholder={searchPlaceholder}
            className="h-8 w-full pl-8"
          />
        </div>
      )}

      {inline ? (
        <>
          {filterableColumns.map((column) => (
            <DataGridFacetedFilter key={column.id} column={column} grid={grid} title={columnLabel(column)} />
          ))}
          {hasActiveFilters && <ClearFiltersButton onClick={clearAll} />}
        </>
      ) : (
        filterableColumns.length > 0 && (
          <CollapsedFilters
            grid={grid}
            useSheet={useSheet}
            columns={filterableColumns}
            activeCount={activeCount}
            hasActiveFilters={hasActiveFilters}
            onClear={clearAll}
          />
        )
      )}
      {!inline && !useSheet && hasActiveFilters && <ClearFiltersButton onClick={clearAll} />}

      <div className="ml-auto flex items-center gap-2">
        {children}
        {!useSheet && (
          <>
            <DensityToggle density={density} setDensity={setDensity} />
            {features.columnVisibility && <ViewOptions grid={grid} inline={inline} />}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The CANONICAL clear control — the one in the toolbar row. It keeps the bare
 * accessible name "Clear filters"; its two siblings (the copy inside the filter
 * panel below, and each screen's empty-state action) extend that name so the
 * three are distinguishable to a screen reader when they coexist on a page.
 *
 * They extend rather than replace it because WCAG 2.5.3 (Label in Name) requires
 * the accessible name to CONTAIN the visible label — so speech-input users can
 * say what they see.
 */
function ClearFiltersButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="h-8 px-2" onClick={onClick}>
      Clear filters
      <X className="size-4" />
    </Button>
  );
}

function DensityToggle({ density, setDensity }: { density: Density; setDensity: (d: Density) => void }) {
  return (
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
  );
}

function CollapsedFilters<TData extends RowData>({
  grid,
  useSheet,
  columns,
  activeCount,
  hasActiveFilters,
  onClear,
}: {
  grid: UseDataGridResult<TData>;
  useSheet: boolean;
  columns: ReturnType<UseDataGridResult<TData>['table']['getAllColumns']>;
  activeCount: number;
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  const trigger = (
    <Button variant="outline" size="sm" className="h-8">
      <SlidersHorizontal className="size-4" />
      Filters
      {activeCount > 0 && (
        <Badge variant="secondary" className="ml-0.5 rounded-sm px-1 font-normal">
          {activeCount}
        </Badge>
      )}
    </Button>
  );

  const filters = (
    <div className="flex flex-col gap-3">
      {columns.map((column) => (
        <div key={column.id} className="flex flex-col gap-1">
          <span className="px-1 font-medium text-muted-foreground text-xs">{columnLabel(column)}</span>
          <div className="rounded-md border">
            <FilterControlBody column={column} grid={grid} title={columnLabel(column)} />
          </div>
        </div>
      ))}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" className="justify-start" onClick={onClear} aria-label="Clear filters in the filter panel">
          <X className="size-4" />
          Clear filters
        </Button>
      )}
    </div>
  );

  if (useSheet) {
    return (
      <Sheet>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent side="bottom" className="max-h-[85svh] overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Filters &amp; view</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-4 p-4 pt-0">
            {filters}
            <Separator />
            <div className="flex flex-col gap-2">
              <span className="px-1 font-medium text-muted-foreground text-xs">Density</span>
              <ToggleGroup
                type="single"
                variant="outline"
                value={grid.density}
                onValueChange={(v) => v && grid.setDensity(v as Density)}
                className="w-full"
              >
                <ToggleGroupItem value="comfortable" className="flex-1">
                  Comfortable
                </ToggleGroupItem>
                <ToggleGroupItem value="compact" className="flex-1">
                  Compact
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
            {grid.features.columnVisibility && (
              <div className="flex flex-col gap-2">
                <span className="px-1 font-medium text-muted-foreground text-xs">Columns</span>
                <ColumnVisibilityList grid={grid} />
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        {filters}
      </PopoverContent>
    </Popover>
  );
}

function ColumnVisibilityList<TData extends RowData>({ grid }: { grid: UseDataGridResult<TData> }) {
  // Filter-only virtual columns are forced hidden; never offer them.
  const columns = grid.table.getAllColumns().filter((c) => typeof c.accessorFn !== 'undefined' && c.getCanHide() && !c.columnDef.meta?.filterOnly);
  return (
    <Command>
      <CommandInput placeholder="Search columns…" />
      <CommandList>
        <CommandEmpty>No columns found.</CommandEmpty>
        <CommandGroup>
          {columns.map((column) => (
            <CommandItem key={column.id} onSelect={() => column.toggleVisibility(!column.getIsVisible())}>
              <span className="truncate">{columnLabel(column)}</span>
              <Check className={cn('ml-auto size-4 shrink-0', column.getIsVisible() ? 'opacity-100' : 'opacity-0')} />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup>
          <CommandItem onSelect={() => grid.resetLayout()}>
            <RotateCcw className="size-4" />
            Reset to default layout
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function ViewOptions<TData extends RowData>({ grid, inline }: { grid: UseDataGridResult<TData>; inline: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label="Toggle columns" role="combobox" variant="outline" size={inline ? 'sm' : 'icon'} className={inline ? 'h-8' : 'size-8'}>
          <Settings2 className="text-muted-foreground" />
          {inline && 'View'}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="end">
        <ColumnVisibilityList grid={grid} />
      </PopoverContent>
    </Popover>
  );
}
