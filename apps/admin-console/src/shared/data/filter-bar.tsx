'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { IconSearch } from '@tabler/icons-react';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { formatNumber } from '@/shared/format';

/**
 * Filter bar (frame 08): search + selects left, "Showing x of y" right.
 * Screens own the filter state (nuqs URL-sync); these are controlled inputs.
 */
export function FilterBar({ children, shown, total }: { children: ReactNode; shown?: number; total?: number }) {
  return (
    <div className="bg-card flex flex-wrap items-center gap-3 rounded-md border p-2">
      {children}
      {shown !== undefined && total !== undefined ? (
        <span aria-live="polite" className="text-muted-foreground ml-auto pr-2 text-sm">
          Showing {formatNumber(shown)} of {formatNumber(total)}
        </span>
      ) : null}
    </div>
  );
}

/** Debounced (300ms per frame 08) controlled search input with a visible label for AT. */
export function FilterSearch({
  label,
  placeholder,
  value,
  onChange,
  debounceMs = 300,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  debounceMs?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [lastValue, setLastValue] = useState(value);

  // Re-sync when the URL state changes externally (back/forward, clear
  // all) — the render-time derived-state reset pattern, not an effect.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), debounceMs);
    return () => clearTimeout(timer);
  }, [draft, value, onChange, debounceMs]);

  return (
    <div className="relative w-64 max-w-full">
      <IconSearch aria-hidden className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      <Input aria-label={label} placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} className="h-9 pl-8" />
    </div>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Labelled select filter ("Status: All"). `value=''` represents "All" —
 * Radix Select reserves the empty string, so a sentinel maps in and out.
 */
const ALL_SENTINEL = '__all__';

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel = 'All',
  id,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  allLabel?: string;
  id: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground text-sm font-normal">
        {label}:
      </Label>
      <Select value={value === '' ? ALL_SENTINEL : value} onValueChange={(next) => onChange(next === ALL_SENTINEL ? '' : next)}>
        <SelectTrigger id={id} size="sm" className="min-w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SENTINEL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
