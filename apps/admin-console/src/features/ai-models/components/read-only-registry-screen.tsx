'use client';

import { IconCpu, IconFilterOff } from '@tabler/icons-react';
import { type ColumnDef, type SortRule } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import { CopyButton } from '@/shared/copy-button';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useRegistryPaginated } from '../api/hooks';
import type { RegistryModelRow } from '../api/types';
import { LifecycleBadge } from './lifecycle-badge';
import { humanizeEnum } from './model-meta';

const SEARCH_FIELDS = ['name', 'slug'];
const DEFAULT_SORT: SortRule[] = [{ id: 'name', desc: false }];

const COLUMNS: ColumnDef<RegistryModelRow>[] = [
  {
    accessorKey: 'name',
    header: 'Model',
    meta: { label: 'Model' },
    cell: ({ row }) => (
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium">{row.original.name}</span>
        <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs">
          {row.original.slug}
          <CopyButton value={row.original.slug} label={`Copy slug ${row.original.slug}`} />
        </span>
      </span>
    ),
    size: 260,
    minSize: 180,
  },
  {
    accessorKey: 'taskType',
    header: 'Task',
    enableSorting: false,
    meta: { label: 'Task' },
    cell: ({ row }) => <Badge variant="secondary">{humanizeEnum(row.original.taskType)}</Badge>,
    size: 230,
  },
  {
    accessorKey: 'libraryName',
    header: 'Library',
    enableSorting: false,
    meta: { label: 'Library' },
    cell: ({ row }) => (
      <Badge variant="outline" className="font-mono">
        {row.original.libraryName}
      </Badge>
    ),
    size: 150,
  },
  {
    accessorKey: 'servedBy',
    header: 'Served by',
    enableSorting: false,
    meta: { label: 'Served by' },
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.servedBy}</span>,
    size: 110,
  },
  {
    id: 'lifecycle',
    header: 'Lifecycle',
    enableSorting: false,
    meta: { label: 'Lifecycle' },
    // Badge only: a tenant admin sees WHETHER a model is usable, never progress, errors or per-service residency.
    cell: ({ row }) => <LifecycleBadge status={row.original.lifecycleStatus} />,
    size: 190,
  },
  {
    id: 'licence',
    header: 'Licence',
    enableSorting: false,
    meta: { label: 'Licence' },
    cell: ({ row }) => (
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs">{row.original.license ?? '—'}</span>
        {row.original.gated ? <Badge variant="outline">Gated</Badge> : null}
      </span>
    ),
    size: 150,
  },
  {
    id: 'languages',
    header: 'Languages',
    enableSorting: false,
    meta: { label: 'Languages' },
    cell: ({ row }) => (row.original.languages.length > 0 ? <span className="truncate">{row.original.languages.join(', ')}</span> : <span className="text-muted-foreground">—</span>),
    size: 150,
  },
  {
    accessorKey: 'updatedAt',
    header: 'Updated',
    meta: { label: 'Updated' },
    cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
    size: 150,
  },
];

/**
 * The AI-model registry as every non-platform admin sees it (TASK-1023 OD-1): the catalogue, read-only.
 * No header actions, no row actions, no bucket paths, no job progress or errors.
 */
export function ReadOnlyRegistryScreen() {
  const query = useAdminGridParams({ searchFields: SEARCH_FIELDS, defaultSort: DEFAULT_SORT });
  const { data, isLoading, isFetching, error, refetch } = useRegistryPaginated(query.listParams, true);
  const { rows, total } = normalizeList<RegistryModelRow>(data);
  const clearFilters = () => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] });

  return (
    <ScreenTemplate
      contentMode="fill"
      header={<PageHeader title="AI Model Registry" meta={data ? <span>{formatNumber(total ?? 0)} models in the platform catalogue</span> : null} />}
      footer={
        <StatusFooter
          start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
          end={
            <span aria-hidden className="font-mono">
              GET /admin/ai-models/registry
            </span>
          }
        />
      }
    >
      <AdminDataGrid<RegistryModelRow>
        gridId="ai-models-registry"
        aria-label="AI models"
        columns={COLUMNS}
        rows={rows}
        total={total ?? 0}
        queryState={query.queryState}
        onQueryStateChange={query.setQueryState}
        isLoading={isLoading}
        isBusy={isFetching && !isLoading}
        error={error}
        onRetry={() => void refetch()}
        emptyState={<EmptyState icon={IconCpu} title="No models registered yet" description="The platform has not registered any models." />}
        emptyFilteredState={
          <EmptyState
            icon={IconFilterOff}
            title="No models match your filters"
            description="Try a different search or clear the filters."
            action={
              <Button variant="outline" onClick={clearFilters} aria-label="Clear filters and show all rows">
                <IconFilterOff aria-hidden />
                Clear filters
              </Button>
            }
          />
        }
      />
    </ScreenTemplate>
  );
}
