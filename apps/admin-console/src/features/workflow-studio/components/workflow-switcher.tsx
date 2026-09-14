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
 * combobox shows results immediately instead of a spinner on every click.
 *
 * TASK-973 RC-2: the list endpoint DOES take a search filter (`ListWorkflowDefinitionsQuery`
 * extends `PaginatedQuery`, which applies `search`/`searchFields` — see
 * `workflow-definition.service.ts#list`), so a tenant with more than one page of definitions is
 * searched server-side rather than only over the first `PAGE_SIZE` rows. `shouldFilter={false}`
 * turns off cmdk's own client-side re-filter so it never second-guesses (or hides) a server match.
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IconCheck, IconSelector } from '@tabler/icons-react';
import { Badge, Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, Popover, PopoverContent, PopoverTrigger, cn } from '@arcaai/ui';
import { useWorkflowDefinitions } from '../api';
import type { WorkflowDefinition, WorkflowDefinitionStatus } from '../api/types';

const PAGE_SIZE = 100;
/** `name` + `slug` — the two scalar `String` columns on `WorkflowDefinition`
 * (`packages/database/src/prisma/db_main/workflow-definition.prisma:66-67`) a
 * caller would plausibly type. `status` is an enum column, not `String` — Prisma's
 * `contains`/`mode:'insensitive'` OR-filter only applies to `String` fields. */
const WORKFLOW_SEARCH_FIELDS = 'name,slug';
/** House debounce for server-hitting free-text search (`departments-screen.tsx:60-70`). */
const SEARCH_DEBOUNCE_MS = 300;

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
  /** TASK-965 WF-7 — the editor's guarded navigation (asks about unsaved changes first). Default: a plain `router.push`. */
  onNavigate?: (href: string) => void;
}

export function WorkflowSwitcher({ current, className, onNavigate }: WorkflowSwitcherProps) {
  const router = useRouter();
  const navigate = onNavigate ?? ((href: string) => router.push(href));
  const [open, setOpen] = useState(false);
  // Debounced (300ms) draft over the search box; `search` is what actually hits the server.
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => setSearch(draft), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, search]);

  const trimmedSearch = search.trim();
  const definitionsQuery = useWorkflowDefinitions({
    page: 0,
    limit: PAGE_SIZE,
    ...(trimmedSearch ? { search: trimmedSearch, searchFields: WORKFLOW_SEARCH_FIELDS } : {}),
  });

  /**
   * The open row may not be in the page the list returned (a brand-new draft, or page 2 of a
   * long lineage), and a switcher that cannot show what you are looking at is worse than no
   * switcher — so it is merged in rather than assumed present. Only while UNfiltered: once the
   * admin is searching for something else, forcing the open row back in would defeat the search.
   */
  const rows = useMemo(() => {
    const fetched = definitionsQuery.data?.data ?? [];
    if (trimmedSearch) return fetched;
    return fetched.some((row) => row.id === current.id) ? fetched : [current, ...fetched];
  }, [definitionsQuery.data, current, trimmedSearch]);

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
        {/* `shouldFilter={false}` — the search is server-side (`search`/`searchFields` above);
            cmdk's own client-side re-filter would only fight it. */}
        <Command shouldFilter={false}>
          <CommandInput value={draft} onValueChange={setDraft} placeholder="Search workflows by name or slug…" />
          <CommandList>
            {definitionsQuery.isLoading ? (
              <div className="text-muted-foreground py-6 text-center text-sm">
                {trimmedSearch ? 'Searching…' : 'Loading workflows…'}
              </div>
            ) : (
              <>
                <CommandEmpty>No workflow matches.</CommandEmpty>
                <CommandGroup>
                  {rows.map((row) => (
                    <CommandItem
                      key={row.id}
                      value={row.id}
                      onSelect={() => {
                        setOpen(false);
                        if (row.id !== current.id) navigate(`/workflow-studio/${encodeURIComponent(row.id)}`);
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
