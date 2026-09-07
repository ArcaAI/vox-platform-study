'use client';

/**
 * `WorkflowSwitcher` — TASK-893 OD-1/OD-3.
 *
 * The definitions GRID is deleted, so this is how an admin reaches another workflow without
 * leaving the studio: a searchable combobox over `GET admin/workflow-definitions`, each row
 * `name · v<n> · <status>`, selecting one navigating to its canonical deep link
 * `/workflow-studio/<id>`.
 *
 * Deliberately NOT deferred until open: the list is small, tenant-scoped and already in the
 * query cache when the `/workflow-studio` resolver route brought the admin here, so opening the
 * combobox shows results immediately instead of a spinner on every click. `shouldFilter` stays
 * on cmdk's default (client-side) — the list endpoint takes no search filter.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { Badge, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Popover, PopoverContent, PopoverTrigger, cn } from '@arcaai/ui';
import { useWorkflowDefinitions } from '../api';
import type { WorkflowDefinition, WorkflowDefinitionStatus } from '../api/types';

const PAGE_SIZE = 100;

export const STATUS_VARIANT: Record<WorkflowDefinitionStatus, 'default' | 'secondary' | 'outline'> = {
  DRAFT: 'outline',
  VALIDATED: 'secondary',
  PUBLISHED: 'default',
  DEPRECATED: 'outline',
};

export interface WorkflowSwitcherProps {
  /** The definition currently open in the editor — rendered on the trigger and ticked in the list. */
  current: WorkflowDefinition;
  className?: string;
}

export function WorkflowSwitcher({ current, className }: WorkflowSwitcherProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const definitionsQuery = useWorkflowDefinitions({ page: 0, limit: PAGE_SIZE });

  /**
   * The open row may not be in the page the list returned (a brand-new draft, or page 2 of a
   * long lineage), and a switcher that cannot show what you are looking at is worse than no
   * switcher — so it is merged in rather than assumed present.
   */
  const rows = useMemo(() => {
    const fetched = definitionsQuery.data?.data ?? [];
    return fetched.some((row) => row.id === current.id) ? fetched : [current, ...fetched];
  }, [definitionsQuery.data, current]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Switch workflow"
          className={cn(
            'border-input flex min-h-9 w-64 max-w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm outline-none',
            'hover:bg-accent/40 focus-visible:ring-ring focus-visible:ring-2',
            className,
          )}
        >
          <span className="truncate">
            {current.name} <span className="text-muted-foreground font-mono text-xs">v{current.versionNumber}</span>
          </span>
          <IconSelector aria-hidden="true" className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[--radix-popover-trigger-width] min-w-80 p-0">
        <Command>
          <CommandInput placeholder="Search workflows…" />
          <CommandList>
            {definitionsQuery.isLoading ? (
              <div className="text-muted-foreground py-6 text-center text-sm">Loading workflows…</div>
            ) : (
              <>
                <CommandEmpty>No workflow matches.</CommandEmpty>
                <CommandGroup>
                  {rows.map((row) => (
                    <CommandItem
                      key={row.id}
                      // cmdk filters on `value`, so the searchable text is the whole label, not the id.
                      value={`${row.name} ${row.slug} v${row.versionNumber} ${row.status}`}
                      onSelect={() => {
                        setOpen(false);
                        if (row.id !== current.id) router.push(`/workflow-studio/${encodeURIComponent(row.id)}`);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{row.name}</span>
                      <span className="text-muted-foreground shrink-0 font-mono text-xs">v{row.versionNumber}</span>
                      <Badge variant={STATUS_VARIANT[row.status]} className="shrink-0">
                        {row.status}
                      </Badge>
                      {row.id === current.id ? <IconCheck aria-hidden="true" className="text-foreground size-4 shrink-0" /> : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
