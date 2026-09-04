'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconFilterOff, IconPlus, IconRobot } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
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
import { AGENT_TASKS, AGENT_TASK_LABEL, useAgents, type Agent } from '../api';
import { AgentDetailDrawer } from './agent-detail';
import { AgentOwnerBadge, AgentStatusBadge, AgentTaskBadge, isPlatformAgent } from './agent-status-badge';
import { CreateAgentWizard } from './create-agent-wizard';

const TASK_OPTIONS: FilterOption[] = AGENT_TASKS.map((task) => ({ value: task, label: AGENT_TASK_LABEL[task] }));
const STATUS_OPTIONS: FilterOption[] = ['DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED'].map((status) => ({ value: status, label: status.charAt(0) + status.slice(1).toLowerCase() }));
const OWNER_OPTIONS: FilterOption[] = [
  { value: 'tenant', label: 'Tenant' },
  { value: 'platform', label: 'Platform' },
];

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
  const [creating, setCreating] = useState(false);

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const search = query.queryState.globalSearch?.trim().toLowerCase() ?? '';
  const task = selectValues(query.queryState, 'task');
  const status = selectValues(query.queryState, 'status');
  const owner = selectValues(query.queryState, 'owner');
  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;

  const filtered = useMemo(
    () =>
      agents.filter((agent) => {
        if (task.length && !task.includes(agent.task)) return false;
        if (status.length && !status.includes(agent.status)) return false;
        if (owner.length && !owner.includes(isPlatformAgent(agent.tenantId) ? 'platform' : 'tenant')) return false;
        if (!search) return true;
        return agent.name.toLowerCase().includes(search) || agent.slug.toLowerCase().includes(search) || (agent.modelSlug ?? '').toLowerCase().includes(search);
      }),
    [agents, task, status, owner, search],
  );
  const pageRows = filtered.slice(page * limit, (page + 1) * limit);
  const hasFilters = Boolean(search) || task.length > 0 || status.length > 0 || owner.length > 0;
  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

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
        accessorFn: (row) => (isPlatformAgent(row.tenantId) ? 'platform' : 'tenant'),
        header: 'Owner',
        enableSorting: false,
        size: 110,
        meta: { label: 'Owner', variant: 'multiSelect', options: OWNER_OPTIONS },
        cell: ({ row }) => <AgentOwnerBadge tenantId={row.original.tenantId} />,
      },
    ],
    [selectedParam],
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
              <Button onClick={() => setCreating(true)}>
                <IconPlus aria-hidden className="size-4" />
                New agent
              </Button>
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
                description="Create an agent: pick a task, bind a registry model, set its instruction and parameters, then publish it. Platform defaults appear here as read-only templates you can branch."
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
