'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconCalendarTime, IconFilterOff, IconPencil } from '@tabler/icons-react';
import { toast } from 'sonner';
import { VirtualizedDataGrid, includesSomeFilter, type ColumnDef } from '@arcaai/ui';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useSchedulers, useToggleScheduler } from '../api/hooks';
import type { SchedulerInfo } from '../api/types';
import { EditCronDialog } from './edit-cron-dialog';
import { toastRequestError } from './toasts';

const TYPE_FILTERS = ['cron', 'interval', 'timeout'] as const;

const STATUS_OPTIONS: FilterOption[] = [
  { value: 'running', label: 'Running' },
  { value: 'paused', label: 'Paused' },
];

const TYPE_OPTIONS: FilterOption[] = TYPE_FILTERS.map((type) => ({ value: type, label: type.charAt(0).toUpperCase() + type.slice(1) }));

function formatIntervalMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function scheduleExpression(row: SchedulerInfo): string {
  if (row.cronExpression) return row.cronExpression;
  if (row.intervalMs !== null) return `every ${formatIntervalMs(row.intervalMs)}`;
  return '\u2014';
}

/**
 * Frame 17.1 — Schedulers: cron table with enable toggle + cron editing. The
 * gateway returns every schedule in one payload (no server pagination), so this
 * is a client-driven `VirtualizedDataGrid` (uncontrolled): omni search over the
 * name, Status + Type facets, client pager.
 */
export function SchedulersScreen() {
  const schedulersQuery = useSchedulers();
  const toggleScheduler = useToggleScheduler();
  // `mutate` is referentially stable (TanStack Query), so the memoized columns
  // that close over it stay stable too.
  const { mutate: mutateToggle } = toggleScheduler;
  const [editTarget, setEditTarget] = useState<SchedulerInfo | null>(null);
  const [disableTarget, setDisableTarget] = useState<SchedulerInfo | null>(null);

  const schedulers = useMemo(() => schedulersQuery.data ?? [], [schedulersQuery.data]);

  const enableScheduler = useCallback(
    (row: SchedulerInfo) => {
      mutateToggle(
        { name: row.name, enabled: true },
        {
          onSuccess: () => toast.success(`Scheduler ${row.name} enabled`),
          onError: toastRequestError,
        },
      );
    },
    [mutateToggle],
  );

  function confirmDisable() {
    if (!disableTarget) return;
    const target = disableTarget;
    mutateToggle(
      { name: target.name, enabled: false },
      {
        onSuccess: () => {
          toast.success(`Scheduler ${target.name} disabled`);
          setDisableTarget(null);
        },
        onError: toastRequestError,
      },
    );
  }

  const columns = useMemo<ColumnDef<SchedulerInfo>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Schedule',
        meta: { label: 'Schedule' },
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.name}</span>,
        size: 220,
        minSize: 160,
      },
      {
        id: 'type',
        accessorFn: (row) => row.type,
        header: 'Type',
        enableSorting: false,
        enableGlobalFilter: false,
        filterFn: includesSomeFilter,
        meta: { label: 'Type', variant: 'multiSelect', options: TYPE_OPTIONS },
        cell: ({ row }) => (
          <Badge variant="outline" className="capitalize">
            {row.original.type}
          </Badge>
        ),
        size: 120,
      },
      {
        id: 'schedule',
        header: 'Cron / interval',
        enableSorting: false,
        enableGlobalFilter: false,
        meta: { label: 'Cron / interval' },
        cell: ({ row }) => <span className="font-mono text-xs">{scheduleExpression(row.original)}</span>,
        size: 180,
      },
      {
        id: 'status',
        accessorFn: (row) => (row.running ? 'running' : 'paused'),
        header: 'Status',
        enableSorting: false,
        enableGlobalFilter: false,
        filterFn: includesSomeFilter,
        meta: { label: 'Status', variant: 'multiSelect', options: STATUS_OPTIONS },
        cell: ({ row }) => <StatusDot colorRole={row.original.running ? 'success' : 'warning'} label={row.original.running ? 'Running' : 'Paused'} />,
        size: 120,
      },
      {
        id: 'lastRun',
        header: 'Last run',
        enableSorting: false,
        enableGlobalFilter: false,
        meta: { label: 'Last run' },
        cell: ({ row }) => formatRelativeTime(row.original.lastExecution),
        size: 140,
      },
      {
        id: 'nextRun',
        header: 'Next run',
        enableSorting: false,
        enableGlobalFilter: false,
        meta: { label: 'Next run' },
        cell: ({ row }) => formatDateTime(row.original.nextExecution),
        size: 180,
      },
      {
        id: 'enabled',
        header: 'Enabled',
        enableSorting: false,
        enableGlobalFilter: false,
        enableResizing: false,
        meta: { label: 'Enabled' },
        cell: ({ row }) => (
          <Switch
            aria-label={`Toggle ${row.original.name}`}
            checked={row.original.running}
            onCheckedChange={(checked) => {
              if (checked) enableScheduler(row.original);
              else setDisableTarget(row.original);
            }}
          />
        ),
        size: 110,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        meta: { label: 'Actions' },
        enableSorting: false,
        enableHiding: false,
        enableResizing: false,
        enableGlobalFilter: false,
        size: 56,
        minSize: 56,
        cell: ({ row }) =>
          row.original.type === 'cron' ? (
            <span className="flex w-full justify-end">
              <Button variant="ghost" size="icon-sm" aria-label={`Edit cron for ${row.original.name}`} onClick={() => setEditTarget(row.original)}>
                <IconPencil aria-hidden />
              </Button>
            </span>
          ) : null,
      },
    ],
    [enableScheduler],
  );

  return (
    <>
      <ScreenTemplate
        contentMode="fill"
        header={<PageHeader title="Schedulers" meta={<span>{formatNumber(schedulers.length)} schedules</span>} />}
        footer={
          <StatusFooter
            start={<span>{schedulersQuery.isFetching && !schedulersQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/schedulers
              </span>
            }
          />
        }
      >
        <VirtualizedDataGrid<SchedulerInfo>
          aria-label="Schedulers"
          columns={columns}
          data={schedulers}
          getRowId={(row) => row.name}
          features={{
            globalSearch: true,
            facetedFilters: true,
            sorting: true,
            rowSelection: false,
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
          }}
          persistence={gridPersistence('schedulers')}
          isLoading={schedulersQuery.isLoading}
          isBusy={schedulersQuery.isFetching && !schedulersQuery.isLoading}
          error={schedulersQuery.error ?? undefined}
          onRetry={() => void schedulersQuery.refetch()}
          emptyState={
            schedulers.length === 0 ? (
              <EmptyState
                icon={IconCalendarTime}
                title="No schedules defined"
                description="System crons ship with deployment defaults — dynamic schedules appear once registered."
              />
            ) : (
              <EmptyState icon={IconFilterOff} title="No schedules match the filters" description="Adjust the search or filters." />
            )
          }
        />
      </ScreenTemplate>
      <EditCronDialog
        scheduler={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />
      <ConfirmDialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        title={`Disable scheduler ${disableTarget?.name ?? ''}?`}
        description="The schedule stops firing until it is enabled again. No runs are lost — the next enable resumes the cadence."
        confirmLabel="Disable scheduler"
        isPending={toggleScheduler.isPending}
        onConfirm={confirmDisable}
      />
    </>
  );
}
