'use client';

import { IconHistory } from '@tabler/icons-react';
import type { ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import { formatDateTime, formatRelativeTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useRestores } from '../api/hooks';
import { RESTORE_CATEGORY_LABELS, type TenantCheckpointRestore } from '../api/types';
import { RestoreStatusBadge } from './status-badges';

const COLUMNS: ColumnDef<TenantCheckpointRestore>[] = [
  {
    id: 'status',
    header: 'Status',
    enableSorting: false,
    meta: { label: 'Status' },
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <RestoreStatusBadge status={row.original.status} />
        {row.original.warnings.length > 0 ? <Badge variant="outline">{row.original.warnings.length} warnings</Badge> : null}
      </span>
    ),
    size: 240,
  },
  {
    id: 'categories',
    header: 'Categories',
    enableSorting: false,
    meta: { label: 'Categories' },
    cell: ({ row }) => <span className="truncate">{row.original.categories.map((category) => RESTORE_CATEGORY_LABELS[category].label).join(', ')}</span>,
    size: 280,
  },
  {
    id: 'reason',
    header: 'Reason',
    enableSorting: false,
    meta: { label: 'Reason' },
    cell: ({ row }) => <span className="truncate" title={row.original.reason}>{row.original.reason}</span>,
    size: 320,
  },
  {
    id: 'failure',
    header: 'Outcome',
    enableSorting: false,
    meta: { label: 'Outcome' },
    cell: ({ row }) => {
      const { status, failureReason, counts } = row.original;
      if (status === 'FAILED') return <span className="text-destructive truncate">{failureReason ?? 'Failed'}</span>;
      if (!counts) return <span className="text-muted-foreground">&mdash;</span>;
      const inserted = counts.reduce((sum, entry) => sum + entry.inserted, 0);
      const updated = counts.reduce((sum, entry) => sum + entry.updated, 0);
      const retired = counts.reduce((sum, entry) => sum + entry.retired, 0);
      return <span className="text-muted-foreground">{`${inserted} added, ${updated} updated, ${retired} retired`}</span>;
    },
    size: 260,
  },
  {
    id: 'createdAt',
    header: 'Started',
    enableSorting: false,
    meta: { label: 'Started' },
    cell: ({ row }) => (
      <span className="text-muted-foreground" title={formatDateTime(row.original.createdAt)}>
        {formatRelativeTime(row.original.createdAt)}
      </span>
    ),
    size: 140,
  },
];

export function RestoreHistory({ tenantId }: { tenantId: string }) {
  const query = useAdminGridParams();
  const { data, isLoading, isFetching, error, refetch } = useRestores(tenantId, query.listParams);
  const { rows, total } = normalizeList<TenantCheckpointRestore>(data);

  return (
    <AdminDataGrid<TenantCheckpointRestore>
      gridId="tenant-checkpoint-restores"
      aria-label="Restore history"
      columns={COLUMNS}
      rows={rows}
      total={total ?? 0}
      queryState={query.queryState}
      onQueryStateChange={query.setQueryState}
      isLoading={isLoading}
      isBusy={isFetching && !isLoading}
      error={error}
      onRetry={() => refetch()}
      emptyState={<EmptyState icon={IconHistory} title="No restores yet" description="Restores of this tenant's checkpoints are listed here with their outcome." />}
      emptyFilteredState={<EmptyState icon={IconHistory} title="No restores match" />}
    />
  );
}
