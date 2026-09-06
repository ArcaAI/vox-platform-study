'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconFilterOff, IconPlus, IconRobot, IconUpload } from '@tabler/icons-react';
import { toast } from 'sonner';
import { parseAsString, useQueryState } from 'nuqs';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useAdminGridParams } from '@/shared/data/admin-data-grid';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { AGENT_TASKS, AGENT_TASK_LABEL, useAgents, useImportAgent, type Agent } from '../api';
import { AgentDetailDrawer, problemToast } from './agent-detail';
import { AgentOwnerBadge, AgentStatusBadge, AgentTaskBadge, isClonedFromPlatform } from './agent-status-badge';
import { CreateAgentWizard } from './create-agent-wizard';

const TASK_OPTIONS: FilterOption[] = AGENT_TASKS.map((task) => ({ value: task, label: AGENT_TASK_LABEL[task] }));
const STATUS_OPTIONS: FilterOption[] = ['DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED'].map((status) => ({ value: status, label: status.charAt(0) + status.slice(1).toLowerCase() }));
const OWNER_OPTIONS: FilterOption[] = [
  { value: 'tenant', label: 'Tenant' },
  { value: 'platform', label: 'Platform' },
];

/**
 * TASK-884 — the tag facet options, derived from what the loaded agents actually carry rather
 * than a fixed list. Tags are a tenant's OWN `key:value` vocabulary (owner decision #6), so the
 * platform cannot know them in advance; the facet is a view of the data, not a taxonomy.
 */
function tagOptions(agents: Agent[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const agent of agents) for (const tag of agent.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value]) => ({ value, label: value }));
}

function selectValues(state: DataQueryState, id: string): string[] {
  const rule = state.filters.find((filter) => filter.id === id);
  if (!rule) return [];
  if (Array.isArray(rule.value)) return rule.value.map(String);
  return rule.value != null && rule.value !== '' ? [String(rule.value)] : [];
}

const ENDPOINT_HINT = (
  <span aria-hidden className="font-mono text-xs">
    GET /admin/agents
  </span>
);

/** Agents (tier 30–49, `manage:Agent`) — TASK-863 §3.6: fill-height grid grouped/filtered by task + the console-wide detail slide-over. */
export function AgentsScreen() {
  return (
    <WorkingTenantGate title="Agents" meta={ENDPOINT_HINT}>
      <AgentsBody />
    </WorkingTenantGate>
  );
}

function AgentsBody() {
  const agentsQuery = useAgents();
  const query = useAdminGridParams();
  const [selectedParam, setSelectedParam] = useQueryState('agent', parseAsString.withDefault(''));
  // TASK-890 §3.10 — `?create=1` opens the wizard directly (the Studio's "Create a new agent"
  // deep link, `agent-picker-field.tsx`'s CREATE_AGENT_HREF). Read once as the lazy initial
  // state (the deep link is a fresh navigation, so this always runs at mount); the effect below
  // only clears the URL param — never local state — so a refresh or Back doesn't re-open it.
  const [createParam, setCreateParam] = useQueryState('create', parseAsString.withDefault(''));
  const [creating, setCreating] = useState(() => createParam === '1');
  useEffect(() => {
    if (createParam === '1') void setCreateParam(null);
  }, [createParam, setCreateParam]);

  const importAgent = useImportAgent();
  const importInputRef = useRef<HTMLInputElement>(null);

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const search = query.queryState.globalSearch?.trim().toLowerCase() ?? '';
  const task = selectValues(query.queryState, 'task');
  const status = selectValues(query.queryState, 'status');
  const owner = selectValues(query.queryState, 'owner');
  const tags = selectValues(query.queryState, 'tags');
  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;

  const filtered = useMemo(
    () =>
      agents.filter((agent) => {
        if (task.length && !task.includes(agent.task)) return false;
        if (status.length && !status.includes(agent.status)) return false;
        if (owner.length && !owner.includes(isClonedFromPlatform(agent.sourceTenantId) ? 'platform' : 'tenant')) return false;
        // AND-joined, matching how a selector narrows the assignment cascade: picking two tags
        // asks for the agents carrying BOTH, not either.
        if (tags.length && !tags.every((tag) => (agent.tags ?? []).includes(tag))) return false;
        if (!search) return true;
        return (
          agent.name.toLowerCase().includes(search) ||
          agent.slug.toLowerCase().includes(search) ||
          (agent.modelSlug ?? '').toLowerCase().includes(search) ||
          (agent.tags ?? []).some((tag) => tag.toLowerCase().includes(search))
        );
      }),
    [agents, task, status, owner, tags, search],
  );
  const pageRows = filtered.slice(page * limit, (page + 1) * limit);
  const hasFilters = Boolean(search) || task.length > 0 || status.length > 0 || owner.length > 0 || tags.length > 0;
  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  /**
   * Import a bundle file. The gateway is the authority on whether a bundle is valid and on
   * whether its references resolve HERE, so the browser only parses the JSON — a client-side
   * pre-check would be a second, weaker copy of a rule that must hold at the server anyway.
   */
  const handleImport = useCallback(
    async (file: File) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        toast.error(`${file.name} is not valid JSON.`);
        return;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        toast.error(`${file.name} does not contain an agent bundle.`);
        return;
      }
      try {
        const imported = await importAgent.mutateAsync({ bundle: parsed as Record<string, unknown> });
        toast.success(`Imported ${imported.name} as a draft (v${imported.versionNumber}).`);
        void setSelectedParam(imported.id);
      } catch (error) {
        problemToast(error, 'Could not import that bundle.');
      }
    },
    [importAgent, setSelectedParam],
  );

  const tagFacets = useMemo(() => tagOptions(agents), [agents]);

  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Agent',
        enableSorting: false,
        enableHiding: false,
        size: 220,
        minSize: 140,
        meta: { label: 'Agent' },
        cell: ({ row }) => <span className={row.original.id === selectedParam ? 'font-medium' : 'font-normal'}>{row.original.name}</span>,
      },
      {
        accessorKey: 'slug',
        header: 'Slug',
        enableSorting: false,
        size: 180,
        meta: { label: 'Slug' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.slug}</span>,
      },
      {
        accessorKey: 'task',
        header: 'Task',
        enableSorting: false,
        enableHiding: false,
        size: 150,
        meta: { label: 'Task', variant: 'multiSelect', options: TASK_OPTIONS },
        cell: ({ row }) => <AgentTaskBadge task={row.original.task} />,
      },
      {
        id: 'model',
        accessorFn: (row) => row.modelSlug ?? row.modelId,
        header: 'Model',
        enableSorting: false,
        size: 220,
        meta: { label: 'Model' },
        cell: ({ getValue }) => <span className="font-mono text-xs">{getValue<string>()}</span>,
      },
      {
        accessorKey: 'versionNumber',
        header: 'Version',
        enableSorting: false,
        size: 90,
        meta: { label: 'Version' },
        cell: ({ row }) => <span className="font-mono text-xs">v{row.original.versionNumber}</span>,
      },
      {
        accessorKey: 'status',
        header: 'Status',
        enableSorting: false,
        enableHiding: false,
        size: 170,
        meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
        cell: ({ row }) => <AgentStatusBadge status={row.original.status} isActive={row.original.isActive} />,
      },
      {
        id: 'owner',
        accessorFn: (row) => (isClonedFromPlatform(row.sourceTenantId) ? 'platform' : 'tenant'),
        header: 'Owner',
        enableSorting: false,
        size: 110,
        meta: { label: 'Owner', variant: 'multiSelect', options: OWNER_OPTIONS },
        cell: ({ row }) => <AgentOwnerBadge sourceTenantId={row.original.sourceTenantId} />,
      },
      {
        id: 'tags',
        accessorFn: (row) => (row.tags ?? []).join(' '),
        header: 'Tags',
        enableSorting: false,
        size: 220,
        meta: { label: 'Tags', variant: 'multiSelect', options: tagFacets },
        cell: ({ row }) =>
          (row.original.tags ?? []).length === 0 ? (
            <span className="text-muted-foreground text-xs">—</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1">
              {(row.original.tags ?? []).map((tag) => (
                <Badge key={tag} variant="outline" className="font-mono text-[10px]">
                  {tag}
                </Badge>
              ))}
            </span>
          ),
      },
    ],
    [selectedParam, tagFacets],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Agents"
            meta={
              <>
                {agentsQuery.data ? <span>{formatNumber(agents.length)} agent versions</span> : <Skeleton className="h-4 w-24" />}
                <span className="text-xs">one task · one registry model · published like a workflow</span>
              </>
            }
            actions={
              <>
                {/* The file input is the control; the button is its visible label — the
                    workflow-studio toolbar pattern. */}
                <input
                  ref={importInputRef}
                  type="file"
                  accept="application/json,.json"
                  className="sr-only"
                  aria-label="Agent bundle to import"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void handleImport(file);
                  }}
                />
                <Button variant="outline" disabled={importAgent.isPending} onClick={() => importInputRef.current?.click()}>
                  <IconUpload aria-hidden className="size-4" />
                  Import
                </Button>
                <Button onClick={() => setCreating(true)}>
                  <IconPlus aria-hidden className="size-4" />
                  New agent
                </Button>
              </>
            }
          />
        }
        footer={
          <StatusFooter start={agentsQuery.data ? `${formatNumber(filtered.length)} of ${formatNumber(agents.length)} shown` : 'Loading…'} end={ENDPOINT_HINT} />
        }
      >
        <VirtualizedDataGrid<Agent>
          aria-label="Agents"
          columns={columns}
          data={pageRows}
          getRowId={(row) => row.id}
          manual={{ filtering: true, pagination: true }}
          rowCount={filtered.length}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          persistence={gridPersistence('agents')}
          features={{
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
            rowSelection: false,
            globalSearch: true,
            facetedFilters: true,
            sorting: false,
          }}
          onRowClick={(row) => void setSelectedParam(row.id)}
          isLoading={agentsQuery.isLoading}
          isBusy={agentsQuery.isFetching && !agentsQuery.isLoading}
          error={agentsQuery.error ?? null}
          errorState={(error) => <ErrorState error={error} onRetry={() => void agentsQuery.refetch()} />}
          onRetry={() => void agentsQuery.refetch()}
          emptyState={
            hasFilters ? (
              <EmptyState icon={IconFilterOff} title="No agents match your filters" description="Clear the search and filters to see every agent version." action={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>} />
            ) : (
              <EmptyState
                icon={IconRobot}
                title="No agents yet"
                description="Create an agent: pick a task, bind a catalogue model, set its instruction and parameters, then publish it. A new tenant starts with the platform's default agents already cloned in — editable like any other."
                action={
                  <Button onClick={() => setCreating(true)}>
                    <IconPlus aria-hidden className="size-4" />
                    New agent
                  </Button>
                }
              />
            )
          }
        />
      </ScreenTemplate>

      <CreateAgentWizard
        open={creating}
        onOpenChange={setCreating}
        onCreated={(agent) => {
          setCreating(false);
          void setSelectedParam(agent.id);
        }}
      />
      <AgentDetailDrawer agentId={selectedParam || null} onOpenChange={(open) => !open && void setSelectedParam('')} onSelect={(id) => void setSelectedParam(id)} />
    </>
  );
}
