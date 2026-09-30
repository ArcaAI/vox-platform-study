'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { IconChevronDown } from '@tabler/icons-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@arcaai/ui/components/shadcn/collapsible';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { cx } from '@/shared/cx';

/** How long typing must pause before the Hub is asked (the preview is a network round-trip to huggingface.co). */
export const PREVIEW_DEBOUNCE_MS = 300;

/** Radix SelectItem forbids the empty string; sentinel for "let the gateway decide". */
export const AUTO = 'auto';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function Field({ id, label, hint, className, children }: { id: string; label: string; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/** Read-only facts about the model being registered — what the gateway derived, never typed. */
export function ModelSummaryCard({ title, rows }: { title: ReactNode; rows: { label: string; value: ReactNode }[] }) {
  return (
    <div role="group" aria-label="Model summary" className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">{title}</div>
      <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="col-span-2 grid grid-cols-subgrid">
            <dt className="font-medium">{row.label}</dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function SummarySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 rounded-md border p-3">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

/** Collapsed-by-default disclosure for the optional overrides. */
export function AdvancedDisclosure({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="flex flex-col gap-3">
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex w-fit items-center gap-1 rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:outline-none">
        <IconChevronDown aria-hidden className={cx('size-4 transition-transform', open ? '' : '-rotate-90')} />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
