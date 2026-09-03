'use client';

import * as React from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';

import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/shadcn/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/shadcn/popover';
import { Skeleton } from '@/components/shadcn/skeleton';
import { cn } from '@/lib/utils';

export interface TenantOption {
  id: string;
  name: string;
  key: string;
}

export interface TenantFilterProps {
  tenants: TenantOption[];
  /** Selected tenant id, or `null` for the cross-tenant "All tenants" scope. */
  value: string | null;
  onChange: (tenantId: string | null) => void;
  /** Super-admin only — surfaces the "All tenants" cross-tenant option. */
  allowAll?: boolean;
  /** Tenant-admin: control is locked to its own tenant (404-over-403 isolation). */
  disabled?: boolean;
  isLoading?: boolean;
  className?: string;
  'aria-label'?: string;
}

const ALL_TENANTS_LABEL = 'All tenants';
const ALL_TENANTS_VALUE = '__all__';

/**
 * Tenant scope switcher (PHASE-2-PLAN A searchable combobox (`Command` in a
 * `Popover`) over the caller's tenant list. Super-admins (`allowAll`) get the
 * cross-tenant "All tenants" option; tenant-admins pass `disabled` to pin the
 * control to their own tenant. Filtering is controlled (`shouldFilter={false}`) so
 * it stays deterministic. Presentational — the app supplies `tenants`/`value`
 * (e.g. from `useTenants`) and reacts to `onChange`.
 */
export function TenantFilter({
  tenants,
  value,
  onChange,
  allowAll = false,
  disabled = false,
  isLoading = false,
  className,
  ...props
}: TenantFilterProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const listId = React.useId();
  const ariaLabel = props['aria-label'] ?? 'Filter by tenant';

  if (isLoading) {
    return <Skeleton data-slot="tenant-filter" data-testid="tenant-filter-skeleton" className={cn('h-11 w-48', className)} />;
  }

  const selected = value != null ? tenants.find((t) => t.id === value) : undefined;
  const triggerLabel = selected ? selected.name : allowAll ? ALL_TENANTS_LABEL : 'Select tenant';

  const needle = query.trim().toLowerCase();
  const showAll = allowAll && (needle === '' || ALL_TENANTS_LABEL.toLowerCase().includes(needle));
  const filtered = tenants.filter((t) => `${t.name} ${t.key}`.toLowerCase().includes(needle));
  const isEmpty = !showAll && filtered.length === 0;

  const select = (tenantId: string | null) => {
    onChange(tenantId);
    setQuery('');
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          data-slot="tenant-filter"
          data-testid="tenant-filter-trigger"
          aria-label={ariaLabel}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          disabled={disabled}
          className={cn(
            'inline-flex min-h-11 w-48 items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm outline-none',
            'hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
            className,
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent id={listId} align="start" className="w-[--radix-popover-trigger-width] min-w-56 p-0">
        <Command shouldFilter={false} aria-label={ariaLabel}>
          <CommandInput value={query} onValueChange={setQuery} placeholder="Search tenants…" />
          <CommandList>
            {isEmpty ? (
              <div data-slot="tenant-filter-empty" className="py-6 text-center text-sm text-muted-foreground">
                No tenant found.
              </div>
            ) : (
              <CommandGroup>
                {showAll ? (
                  <CommandItem value={ALL_TENANTS_VALUE} data-tenant-all="true" data-active={value === null} onSelect={() => select(null)}>
                    <span className="flex-1 truncate">{ALL_TENANTS_LABEL}</span>
                    {value === null ? <SelectedMark /> : null}
                  </CommandItem>
                ) : null}
                {filtered.map((tenant) => {
                  const active = tenant.id === value;
                  return (
                    <CommandItem key={tenant.id} value={tenant.id} data-tenant-id={tenant.id} data-active={active} onSelect={() => select(tenant.id)}>
                      <span className="flex-1 truncate">{tenant.name}</span>
                      <span data-slot="tenant-filter-key" className="font-mono text-xs text-muted-foreground">
                        {tenant.key}
                      </span>
                      {active ? <SelectedMark /> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Selected-row indicator — visible check (decorative) plus an sr-only label so the
 * current selection is never conveyed by the icon alone. */
function SelectedMark() {
  return (
    <>
      <Check data-slot="tenant-filter-check" aria-hidden="true" className="size-4 text-foreground" />
      <span className="sr-only">Current selection</span>
    </>
  );
}
