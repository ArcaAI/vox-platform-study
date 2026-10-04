'use client';

/**
 * TASK-1036 §10.1 — "Choose a field": the ONE picker every data-taking field opens.
 *
 * Four groups, always in this order — Earlier steps (ancestors only, by label), Context (the
 * schema and its version), Consultation, Run & variables — from `lib/picker-model.ts`, which is
 * the contract's `bindingSourcePaths`. Each item shows its path, type, PHI badge, sample and how
 * it fits: the best match first ("Best match"), a convertible item says how ("Formatted as
 * text"), a blocked one stays listed — `aria-disabled`, still readable — with its reason, so the
 * author learns the model rather than guessing. Typing filters path, stored path and description;
 * an emptied group says why. The stored id is each item's tooltip (OD-20).
 */
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Badge, Button, Input, Popover, PopoverContent, PopoverTrigger, cn } from '@arcaai/ui';
import { IconSearch } from '@tabler/icons-react';
import { filterPickerGroups, type PickerGroup, type PickerItem } from '../../lib/picker-model';
import { ioTypeLabel } from '../../lib/composer-io';
import { SCOPE_CLASS } from './scope-style';

export interface FieldPickerProps {
  groups: readonly PickerGroup[];
  onPick: (item: PickerItem) => void;
  /** Accessible name / visible text of the trigger button. */
  triggerLabel: ReactNode;
  /** The type being filled — named in the header ("showing what fits text first"). */
  targetType?: string;
  /** Offered as "Use a fixed value" when given. */
  onFixedValue?: () => void;
  disabled?: boolean;
  triggerVariant?: 'outline' | 'ghost' | 'secondary' | 'link';
  triggerClassName?: string;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function FitNote({ item }: { item: PickerItem }) {
  if (item.disabledReason) return <span className="text-muted-foreground text-xs italic">{item.disabledReason}</span>;
  if (item.bestMatch) return <span className="text-primary text-xs font-medium">Best match</span>;
  if (item.convertNote) return <span className="text-muted-foreground text-xs">{item.convertNote}</span>;
  return null;
}

export function FieldPicker({
  groups,
  onPick,
  triggerLabel,
  targetType,
  onFixedValue,
  disabled,
  triggerVariant = 'outline',
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
}: FieldPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [query, setQuery] = useState('');
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
    if (!next) setQuery('');
  };
  const searchId = useId();
  const filtered = useMemo(() => filterPickerGroups(groups, query), [groups, query]);
  const count = filtered.reduce((total, group) => total + group.items.length, 0);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant={triggerVariant} size="sm" disabled={disabled} className={triggerClassName}>
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[min(28rem,70vh)] w-[min(26rem,90vw)] flex-col gap-2 p-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={searchId} className="text-muted-foreground text-xs font-medium">
            Find a field{targetType ? ` · showing what fits ${ioTypeLabel(targetType)} first` : ''}
          </label>
          <div className="relative">
            <IconSearch aria-hidden="true" className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <Input id={searchId} type="search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields" className="pl-8" />
          </div>
          <p aria-live="polite" className="sr-only">
            {count} field{count === 1 ? '' : 's'} shown
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto" data-slot="field-picker-groups">
          {filtered.map((group) => {
            const headingId = `${searchId}-${group.key}`;
            return (
              <section key={group.key} role="group" aria-labelledby={headingId} className="flex flex-col gap-0.5 pb-2">
                <div className="flex items-baseline justify-between gap-2 px-1 pt-1">
                  <h3 id={headingId} className={cn('rounded-sm border px-1 text-xs font-semibold', SCOPE_CLASS[group.key])}>
                    {group.label}
                  </h3>
                  {group.subtitle ? <span className="text-muted-foreground truncate text-xs">{group.subtitle}</span> : null}
                </div>
                {group.items.length === 0 ? <p className="text-muted-foreground px-1 text-xs">{group.emptyReason ?? 'Nothing here.'}</p> : null}
                {group.items.map((item) => (
                  <button
                    key={item.raw}
                    type="button"
                    title={item.raw}
                    aria-disabled={item.disabledReason ? true : undefined}
                    onClick={() => {
                      if (item.disabledReason) return;
                      onPick(item);
                      setOpen(false);
                    }}
                    className={cn(
                      'hover:bg-accent focus-visible:ring-ring flex min-h-8 w-full flex-col items-start gap-0.5 rounded-md px-2 py-1 text-left focus-visible:ring-2 focus-visible:outline-none',
                      item.disabledReason && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                      item.bestMatch && !item.disabledReason && 'bg-primary/5',
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{item.path}</span>
                      <Badge variant="outline" className="shrink-0 px-1 font-mono text-[10px]">
                        {item.type}
                      </Badge>
                      {item.phiClass === 'PHI' ? (
                        <Badge variant="outline" className="border-destructive text-destructive shrink-0 px-1 text-[10px]">
                          PHI
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex w-full items-center gap-2">
                      <FitNote item={item} />
                      {item.sample ? <span className="text-muted-foreground truncate text-xs">{item.sample}</span> : item.description ? <span className="text-muted-foreground truncate text-xs">{item.description}</span> : null}
                    </span>
                  </button>
                ))}
              </section>
            );
          })}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t pt-2">
          {onFixedValue ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                onFixedValue();
              }}
            >
              Use a fixed value
            </Button>
          ) : (
            <span />
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
