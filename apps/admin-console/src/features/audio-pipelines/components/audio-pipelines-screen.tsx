'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconFilterOff, IconPlus, IconRoute, IconStarFilled } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
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
import { usePipelines } from '../api';
import type { Pipeline } from '../api';
import { PipelineDetailDrawer } from './pipeline-detail';
import { PipelineStatusBadge } from './pipeline-status-badge';
import { TemplateBadge } from './template-lock';

const EM_DASH = '—';

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'ENABLED', label: 'On' },
  { value: 'DISABLED', label: 'Off' },
];

/**
 * Display-level engine extraction: the API has no engine field/param — the
 * model id lives inside the YAML (`asr:`/`engine:`/`model:` keys), so the
 * frame's Engine filter works client-side over the loaded list.
 */
function pipelineEngine(configYaml: string): string | null {
  const match = /^\s*(?:asr|engine|model)\s*:\s*["']?([A-Za-z0-9._/-]+)["']?\s*$/m.exec(configYaml);
  return match ? match[1] : null;
}

/** Read a multi-select faceted filter's selected values out of the grid query-state. */
function selectValues(state: DataQueryState, id: string): string[] {
  const rule = state.filters.find((filter) => filter.id === id);
  if (!rule) return [];
  if (Array.isArray(rule.value)) return rule.value.map(String);
  return rule.value != null && rule.value !== '' ? [String(rule.value)] : [];
}

const ENDPOINT_HINT = (
  <span aria-hidden className="font-mono text-xs">
    GET /admin/audio/pipelines
  </span>
);

/** Frame 34 — Audio Pipelines (tier 30–49): fill-height grid + console-wide detail slide-over. */
export function AudioPipelinesScreen() {
  return (
    <WorkingTenantGate title="Audio Pipelines" meta={ENDPOINT_HINT}>
      <AudioPipelinesBody />
    </WorkingTenantGate>
  );
}

function AudioPipelinesBody() {
  const session = useSession();
  const pipelinesQuery = usePipelines();
  // The list is fetched whole (no server pagination), so the grid runs in
  // manual mode over a client slice: the toolbar's omni search + Status/Engine
  // faceted chips live in the URL (`f`), and this body owns the filtering. The
  // selected row that opens the detail slide-over is its own `pipeline` param.
  const query = useAdminGridParams();
  const [selectedParam, setSelectedParam] = useQueryState('pipeline', parseAsString.withDefault(''));
  const [creating, setCreating] = useState(false);

  const pipelines = useMemo(() => pipelinesQuery.data ?? [], [pipelinesQuery.data]);
  const search = query.queryState.globalSearch?.trim().toLowerCase() ?? '';
  const status = selectValues(query.queryState, 'resourceStatus');
  const engine = selectValues(query.queryState, 'engine');
  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;

  const engineOptions = useMemo<FilterOption[]>(
    () =>
      [...new Set(pipelines.map((pipeline) => pipelineEngine(pipeline.configYaml)).filter((value): value is string => !!value))]
        .sort()
        .map((value) => ({ value, label: value })),
    [pipelines],
  );

  const filtered = useMemo(
    () =>
      pipelines.filter((pipeline) => {
        if (status.length && !status.includes(pipeline.resourceStatus)) return false;
        if (engine.length && !engine.includes(pipelineEngine(pipeline.configYaml) ?? '')) return false;
        if (!search) return true;
        return pipeline.name.toLowerCase().includes(search) || pipeline.slug.toLowerCase().includes(search);
      }),
    [pipelines, status, engine, search],
  );
  const pageRows = filtered.slice(page * limit, (page + 1) * limit);
  const hasFilters = Boolean(search) || status.length > 0 || engine.length > 0;

  const clearFilters = useCallback(() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] }), [query]);

  const columns = useMemo<ColumnDef<Pipeline>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Pipeline',
        enableSorting: false,
        enableHiding: false,
        size: 220,
        minSize: 140,
        meta: { label: 'Pipeline' },
        cell: ({ row }) => (
          <span className={row.original.id === selectedParam ? 'font-medium' : 'font-normal'}>{row.original.name}</span>
        ),
      },
      {
        accessorKey: 'slug',
        header: 'Slug',
        enableSorting: false,
        enableHiding: false,
        size: 160,
        meta: { label: 'Slug' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.slug}</span>,
      },
      {
        id: 'engine',
        accessorFn: (row) => pipelineEngine(row.configYaml) ?? '',
        header: 'Engine',
        enableSorting: false,
        enableHiding: false,
        size: 160,
        meta: { label: 'Engine', variant: 'multiSelect', options: engineOptions },
        cell: ({ getValue }) => {
          const value = getValue<string>();
          return value ? (
            <span className="font-mono text-xs">{value}</span>
          ) : (
            <span aria-hidden className="text-muted-foreground">
              {EM_DASH}
            </span>
          );
        },
      },
      {
        id: 'default',
        header: 'Default',
        enableSorting: false,
        enableHiding: false,
        size: 90,
        meta: { label: 'Default' },
        cell: ({ row }) =>
          row.original.isDefault ? (
            <span className="inline-flex items-center">
              <IconStarFilled aria-hidden className="text-warning size-4" />
              <span className="sr-only">Tenant default</span>
            </span>
          ) : (
            <span aria-hidden className="text-muted-foreground">
              {EM_DASH}
            </span>
          ),
      },
      {
        // Locked SYSTEM template copies are read-only for
        // content edits; surfacing that in the grid stops an admin
        // opening a row expecting to edit it.
        id: 'template',
        header: 'Template',
        enableSorting: false,
        enableHiding: false,
        size: 120,
        meta: { label: 'Template' },
        cell: ({ row }) =>
          row.original.templateLocked ? (
            <TemplateBadge />
          ) : (
            <span aria-hidden className="text-muted-foreground">
              {EM_DASH}
            </span>
          ),
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        enableSorting: false,
        enableHiding: false,
        size: 120,
        meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
        cell: ({ row }) => <PipelineStatusBadge status={row.original.resourceStatus} />,
      },
    ],
    [selectedParam, engineOptions],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="Audio Pipelines"
            meta={
              <>
                {pipelinesQuery.data ? <span>{formatNumber(pipelines.length)} pipelines</span> : <Skeleton className="h-4 w-20" />}
                <span className="text-xs">public read GET /audio/pipelines feeds SDK pickers</span>
              </>
            }
            actions={
              <Button onClick={() => setCreating(true)}>
                <IconPlus aria-hidden />
                New pipeline
              </Button>
            }
          />
        }
        footer={
          <StatusFooter
            start={<span>{pipelinesQuery.isFetching && !pipelinesQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={ENDPOINT_HINT}
          />
        }
      >
        <VirtualizedDataGrid<Pipeline>
          aria-label="Audio pipelines"
          columns={columns}
          data={pageRows}
          getRowId={(row) => row.id}
          manual={{ filtering: true, pagination: true }}
          rowCount={filtered.length}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          persistence={gridPersistence('audio-pipelines')}
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
          isLoading={pipelinesQuery.isLoading}
          isBusy={pipelinesQuery.isFetching && !pipelinesQuery.isLoading}
          error={pipelinesQuery.error ?? null}
          errorState={(error) => <ErrorState error={error} onRetry={() => void pipelinesQuery.refetch()} />}
          onRetry={() => void pipelinesQuery.refetch()}
          emptyState={
            hasFilters ? (
              <EmptyState
                icon={IconFilterOff}
                title="No pipelines match your filters"
                description="Try a different search or clear the filters."
                action={
                  <Button variant="outline" onClick={clearFilters}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={IconRoute}
                title="No pipelines for this tenant"
                description="An ASR pipeline defines the models and preprocessing the SDK uses. Create the first one to feed the SDK pickers."
                action={
                  <Button onClick={() => setCreating(true)}>
                    <IconPlus aria-hidden />
                    New pipeline
                  </Button>
                }
              />
            )
          }
        />
      </ScreenTemplate>

      <PipelineDetailDrawer
        key={creating ? 'create' : selectedParam || 'none'}
        pipelineId={creating ? null : selectedParam || null}
        creating={creating}
        isElevated={session.data?.isElevated ?? false}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          void setSelectedParam(null);
        }}
        onCreated={(pipeline) => {
          setCreating(false);
          void setSelectedParam(pipeline.id);
        }}
      />
    </>
  );
}
