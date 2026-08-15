'use client';

import type { Column, RowData } from '@tanstack/react-table';
import type { DataGridFeatures } from './table-features';
import { Check, PlusCircle } from 'lucide-react';
import * as React from 'react';
import type { DateRange } from 'react-day-picker';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Calendar } from '@/components/shadcn/calendar';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/shadcn/command';
import { Input } from '@/components/shadcn/input';
import { Label } from '@/components/shadcn/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/shadcn/select';
import { Separator } from '@/components/shadcn/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/shadcn/toggle-group';
import { getDefaultFilterOperator, getFilterOperators } from '@/lib/data-table';
import type { FilterOperator, FilterVariant } from '@/types/data-table';
import { cn } from '@/lib/utils';

import {
  booleanFilterRule,
  booleanStateFromRule,
  relativePresetToRange,
  RELATIVE_DATE_PRESETS,
  toISODate,
  type BooleanFilterState,
} from './filter-controls';
import type { UseDataGridResult } from './use-data-grid';

const TEXT_FILTER_DEBOUNCE_MS = 300;

interface FacetedFilterProps<TData extends RowData, TValue> {
  column: Column<DataGridFeatures, TData, TValue>;
  grid: UseDataGridResult<TData>;
  title: string;
}

/** Human-readable summary of the active filter for the chip badge. */
export function describeFilterValue(value: unknown, variant: FilterVariant): string {
  if (Array.isArray(value)) {
    if (variant === 'date' || variant === 'dateRange' || variant === 'range') {
      return value.filter(Boolean).join(' – ');
    }
    return `${value.length}`;
  }
  return String(value ?? '');
}

/**
 * The interactive filter control body — shared by the toolbar chip Popover, the
 * collapsed Filters Popover/Sheet, and the column-header "Filter…" entry (Δ6).
 * Reads/writes the single filter state via `grid.setFilter`.
 */
export function FilterControlBody<TData extends RowData, TValue>({ column, grid, title }: FacetedFilterProps<TData, TValue>) {
  const variant = (column.columnDef.meta?.variant ?? 'text') as FilterVariant;
  const options = column.columnDef.meta?.options ?? [];
  const current = grid.queryState.filters.find((f) => f.id === column.id);

  if (variant === 'select' || variant === 'multiSelect') {
    return <OptionChecklist column={column} grid={grid} title={title} variant={variant} options={options} />;
  }
  if (variant === 'boolean') {
    return <BooleanControl column={column} grid={grid} options={options} />;
  }
  if (variant === 'date' || variant === 'dateRange') {
    return <DateControl column={column} grid={grid} variant={variant} />;
  }
  // text / number / range
  return <ScalarControl column={column} grid={grid} title={title} variant={variant} initial={current} />;
}

function OptionChecklist<TData extends RowData, TValue>({
  column,
  grid,
  title,
  variant,
  options,
}: FacetedFilterProps<TData, TValue> & { variant: FilterVariant; options: { label: string; value: string }[] }) {
  const current = grid.queryState.filters.find((f) => f.id === column.id);
  const isMulti = variant === 'multiSelect';
  const selected = new Set<string>(Array.isArray(current?.value) ? (current?.value as string[]) : current?.value ? [String(current?.value)] : []);

  const apply = (next: Set<string>) => {
    if (next.size === 0) {
      grid.setFilter(null, column.id);
      return;
    }
    grid.setFilter(
      { id: column.id, variant, operator: isMulti ? 'inArray' : 'eq', value: isMulti ? Array.from(next) : Array.from(next)[0] },
      column.id,
    );
  };

  return (
    <Command>
      <CommandInput placeholder={title} />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup>
          {options.map((option) => {
            const isChecked = selected.has(option.value);
            return (
              <CommandItem
                key={option.value}
                onSelect={() => {
                  const next = new Set(isMulti ? selected : []);
                  if (isChecked) next.delete(option.value);
                  else next.add(option.value);
                  apply(next);
                }}
              >
                <div
                  className={cn(
                    'flex size-4 items-center justify-center rounded-sm border border-primary',
                    isChecked ? 'bg-primary text-primary-foreground' : 'opacity-50 [&_svg]:invisible',
                  )}
                >
                  <Check className="size-3" />
                </div>
                <span>{option.label}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
        {selected.size > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem onSelect={() => grid.setFilter(null, column.id)} className="justify-center text-center">
                Clear filter
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}

function BooleanControl<TData extends RowData, TValue>({
  column,
  grid,
  options,
}: {
  column: Column<DataGridFeatures, TData, TValue>;
  grid: UseDataGridResult<TData>;
  options: { label: string; value: string }[];
}) {
  const current = grid.queryState.filters.find((f) => f.id === column.id);
  const state = booleanStateFromRule(current);
  const yesLabel = options.find((o) => o.value === 'true')?.label ?? 'Yes';
  const noLabel = options.find((o) => o.value === 'false')?.label ?? 'No';

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <ToggleGroup
        type="single"
        variant="outline"
        value={state}
        onValueChange={(v) => grid.setFilter(booleanFilterRule((v || 'any') as BooleanFilterState, column.id), column.id)}
        className="w-full"
      >
        <ToggleGroupItem value="any" className="flex-1" aria-label="Any">
          Any
        </ToggleGroupItem>
        <ToggleGroupItem value="yes" className="flex-1" aria-label={yesLabel}>
          {yesLabel}
        </ToggleGroupItem>
        <ToggleGroupItem value="no" className="flex-1" aria-label={noLabel}>
          {noLabel}
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

const DATE_OPERATOR_OPTIONS: { value: FilterOperator; label: string }[] = [
  { value: 'eq', label: 'On' },
  { value: 'lt', label: 'Before' },
  { value: 'gt', label: 'After' },
  { value: 'isBetween', label: 'Between' },
  { value: 'isRelativeToToday', label: 'Relative to today' },
];

function DateControl<TData extends RowData, TValue>({
  column,
  grid,
  variant,
}: {
  column: Column<DataGridFeatures, TData, TValue>;
  grid: UseDataGridResult<TData>;
  variant: FilterVariant;
}) {
  const current = grid.queryState.filters.find((f) => f.id === column.id);
  const [operator, setOperator] = React.useState<FilterOperator>(current?.operator ?? (variant === 'dateRange' ? 'isBetween' : 'eq'));

  const commitSingle = (op: FilterOperator, date: Date | undefined) => {
    if (!date) return grid.setFilter(null, column.id);
    grid.setFilter({ id: column.id, variant, operator: op, value: toISODate(date) }, column.id);
  };
  const commitRange = (range: DateRange | undefined) => {
    const from = range?.from ? toISODate(range.from) : '';
    const to = range?.to ? toISODate(range.to) : '';
    if (!from && !to) return grid.setFilter(null, column.id);
    grid.setFilter({ id: column.id, variant, operator: 'isBetween', value: [from, to] }, column.id);
  };

  const selectedSingle = current && !Array.isArray(current.value) ? new Date(String(current.value)) : undefined;
  const selectedRange: DateRange | undefined =
    current && Array.isArray(current.value)
      ? {
          from: current.value[0] ? new Date(String(current.value[0])) : undefined,
          to: current.value[1] ? new Date(String(current.value[1])) : undefined,
        }
      : undefined;

  return (
    <div className="flex flex-col gap-2 p-2">
      <Select
        value={operator}
        onValueChange={(v) => {
          const op = v as FilterOperator;
          setOperator(op);
          if (op !== 'isRelativeToToday') grid.setFilter(null, column.id);
        }}
      >
        <SelectTrigger className="h-8" aria-label="Date filter operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DATE_OPERATOR_OPTIONS.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {operator === 'isRelativeToToday' ? (
        <div className="grid grid-cols-2 gap-1.5">
          {RELATIVE_DATE_PRESETS.map((preset) => (
            <Button
              key={preset.value}
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() =>
                grid.setFilter({ id: column.id, variant, operator: 'isRelativeToToday', value: relativePresetToRange(preset.value) }, column.id)
              }
            >
              {preset.label}
            </Button>
          ))}
        </div>
      ) : operator === 'isBetween' ? (
        <Calendar mode="range" selected={selectedRange} onSelect={commitRange} autoFocus />
      ) : (
        <Calendar mode="single" selected={selectedSingle} onSelect={(d) => commitSingle(operator, d)} autoFocus />
      )}
    </div>
  );
}

function ScalarControl<TData extends RowData, TValue>({
  column,
  grid,
  title,
  variant,
  initial,
}: FacetedFilterProps<TData, TValue> & { variant: FilterVariant; initial: { operator: FilterOperator; value: unknown } | undefined }) {
  const operators = getFilterOperators(variant);
  const [operator, setOperator] = React.useState<FilterOperator>(initial?.operator ?? getDefaultFilterOperator(variant));
  const isBetween = operator === 'isBetween';

  const initialArr = Array.isArray(initial?.value) ? (initial?.value as string[]) : [];
  const [value, setValue] = React.useState<string>(!Array.isArray(initial?.value) && initial?.value != null ? String(initial?.value) : '');
  const [min, setMin] = React.useState<string>(initialArr[0] ?? '');
  const [max, setMax] = React.useState<string>(initialArr[1] ?? '');

  // Debounce the free-text/number input so each keystroke doesn't refetch (Δ6).
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const commit = (op: FilterOperator, next: { value?: string; min?: string; max?: string }) => {
    if (op === 'isBetween') {
      const lo = next.min ?? min;
      const hi = next.max ?? max;
      if (lo.trim() === '' && hi.trim() === '') return grid.setFilter(null, column.id);
      grid.setFilter({ id: column.id, variant, operator: op, value: [lo, hi] }, column.id);
      return;
    }
    const v = next.value ?? value;
    if (v.trim() === '') return grid.setFilter(null, column.id);
    grid.setFilter({ id: column.id, variant, operator: op, value: v }, column.id);
  };

  const debouncedCommit = (op: FilterOperator, next: { value?: string; min?: string; max?: string }) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(op, next), TEXT_FILTER_DEBOUNCE_MS);
  };

  const inputType = variant === 'number' || variant === 'range' ? 'number' : 'text';

  return (
    <div className="flex flex-col gap-2 p-2">
      <Select
        value={operator}
        onValueChange={(v) => {
          const op = v as FilterOperator;
          setOperator(op);
          commit(op, {});
        }}
      >
        <SelectTrigger className="h-8" aria-label={`${title} operator`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {operators.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isBetween ? (
        <div className="flex items-center gap-1.5">
          <Input
            aria-label={`${title} minimum`}
            type={inputType}
            value={min}
            onChange={(e) => {
              setMin(e.target.value);
              debouncedCommit(operator, { min: e.target.value });
            }}
            placeholder="Min"
            className="h-8"
          />
          <span className="text-muted-foreground text-xs">–</span>
          <Input
            aria-label={`${title} maximum`}
            type={inputType}
            value={max}
            onChange={(e) => {
              setMax(e.target.value);
              debouncedCommit(operator, { max: e.target.value });
            }}
            placeholder="Max"
            className="h-8"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Label className="sr-only">{title} value</Label>
          <Input
            aria-label={`${title} value`}
            type={inputType}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              debouncedCommit(operator, { value: e.target.value });
            }}
            placeholder="Value…"
            className="h-8"
          />
        </div>
      )}
    </div>
  );
}

/** Toolbar chip: a dashed `+ Field` trigger + Popover wrapping the shared body. */
export function DataGridFacetedFilter<TData extends RowData, TValue>({ column, grid, title }: FacetedFilterProps<TData, TValue>) {
  const variant = (column.columnDef.meta?.variant ?? 'text') as FilterVariant;
  const current = grid.queryState.filters.find((f) => f.id === column.id);
  const count = Array.isArray(current?.value) ? current?.value.length : current?.value != null && String(current?.value) !== '' ? 1 : 0;
  const optionVariant = variant === 'select' || variant === 'multiSelect';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <PlusCircle className="size-4" />
          {title}
          {count > 0 && (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              {optionVariant ? (
                <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                  {count}
                </Badge>
              ) : (
                <Badge variant="secondary" className="max-w-32 truncate rounded-sm px-1 font-normal">
                  {describeFilterValue(current?.value, variant)}
                </Badge>
              )}
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className={cn('p-0', optionVariant ? 'w-56' : 'w-auto min-w-64')} align="start">
        <FilterControlBody column={column} grid={grid} title={title} />
      </PopoverContent>
    </Popover>
  );
}
