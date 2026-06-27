'use client';

import type { Column } from '@tanstack/react-table';
import { Check, PlusCircle } from 'lucide-react';
import * as React from 'react';

import { Badge } from '@/components/shadcn/badge';
import { Button } from '@/components/shadcn/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/shadcn/command';
import { Input } from '@/components/shadcn/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/shadcn/select';
import { Separator } from '@/components/shadcn/separator';
import { getDefaultFilterOperator, getFilterOperators } from '@/lib/data-table';
import type { FilterOperator, FilterVariant } from '@/types/data-table';
import { cn } from '@/lib/utils';

import type { UseDataGridResult } from './use-data-grid';

interface DataGridFacetedFilterProps<TData, TValue> {
  column: Column<TData, TValue>;
  grid: UseDataGridResult<TData>;
  title: string;
}

export function DataGridFacetedFilter<TData, TValue>({ column, grid, title }: DataGridFacetedFilterProps<TData, TValue>) {
  const variant = (column.columnDef.meta?.variant ?? 'text') as FilterVariant;
  const options = column.columnDef.meta?.options ?? [];
  const current = grid.queryState.filters.find((f) => f.id === column.id);

  const isOptionVariant = variant === 'select' || variant === 'multiSelect';

  if (isOptionVariant) {
    const selected = new Set<string>(Array.isArray(current?.value) ? (current?.value as string[]) : current?.value ? [String(current?.value)] : []);
    const isMulti = variant === 'multiSelect';

    const apply = (next: Set<string>) => {
      if (next.size === 0) {
        grid.setFilter(null, column.id);
        return;
      }
      grid.setFilter(
        {
          id: column.id,
          variant,
          operator: isMulti ? 'inArray' : 'eq',
          value: isMulti ? Array.from(next) : Array.from(next)[0],
        },
        column.id,
      );
    };

    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 border-dashed">
            <PlusCircle className="size-4" />
            {title}
            {selected.size > 0 && (
              <>
                <Separator orientation="vertical" className="mx-0.5 h-4" />
                <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                  {selected.size}
                </Badge>
              </>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
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
        </PopoverContent>
      </Popover>
    );
  }

  // text / number / date variants: operator + value input.
  const operators = getFilterOperators(variant);
  const [operator, setOperator] = React.useState<FilterOperator>(current?.operator ?? getDefaultFilterOperator(variant));
  const [value, setValue] = React.useState<string>(current?.value != null ? String(current?.value) : '');

  const apply = (nextOperator: FilterOperator, nextValue: string) => {
    const empties = nextOperator === 'isEmpty' || nextOperator === 'isNotEmpty';
    if (!empties && nextValue.trim() === '') {
      grid.setFilter(null, column.id);
      return;
    }
    grid.setFilter({ id: column.id, variant, operator: nextOperator, value: empties ? '' : nextValue }, column.id);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 border-dashed">
          <PlusCircle className="size-4" />
          {title}
          {current && (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              <Badge variant="secondary" className="max-w-32 truncate rounded-sm px-1 font-normal">
                {String(current.value) || operator}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-2" align="start">
        <Select
          value={operator}
          onValueChange={(v) => {
            const op = v as FilterOperator;
            setOperator(op);
            apply(op, value);
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
        <Input
          aria-label={`${title} value`}
          type={variant === 'number' ? 'number' : variant === 'date' ? 'date' : 'text'}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            apply(operator, e.target.value);
          }}
          placeholder="Value…"
          className="h-8"
        />
      </PopoverContent>
    </Popover>
  );
}
