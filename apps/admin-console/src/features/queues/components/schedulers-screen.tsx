'use client';

import { useMemo, useState } from 'react';
import { IconCalendarTime, IconPencil } from '@tabler/icons-react';
import { toast } from 'sonner';
import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { useSchedulers, useToggleScheduler } from '../api/hooks';
import type { SchedulerInfo } from '../api/types';
import { EditCronDialog } from './edit-cron-dialog';
import { toastRequestError } from './toasts';

const STATUS_FILTERS = ['running', 'paused'] as const;
const TYPE_FILTERS = ['cron', 'interval', 'timeout'] as const;

const STATUS_OPTIONS = [
    { value: 'running', label: 'Running' },
    { value: 'paused', label: 'Paused' },
];

const TYPE_OPTIONS = TYPE_FILTERS.map((type) => ({ value: type, label: type.charAt(0).toUpperCase() + type.slice(1) }));

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

/** Frame 17.1 — Schedulers: cron table with enable toggle + cron editing. */
export function SchedulersScreen() {
    const schedulersQuery = useSchedulers();
    const toggleScheduler = useToggleScheduler();
    const [filters, setFilters] = useQueryStates({
        q: parseAsString.withDefault(''),
        status: parseAsStringLiteral(STATUS_FILTERS),
        type: parseAsStringLiteral(TYPE_FILTERS),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(25),
    });
    const [editTarget, setEditTarget] = useState<SchedulerInfo | null>(null);
    const [disableTarget, setDisableTarget] = useState<SchedulerInfo | null>(null);

    const schedulers = useMemo(() => schedulersQuery.data ?? [], [schedulersQuery.data]);

    const filtered = useMemo(() => {
        const query = filters.q.trim().toLowerCase();
        let rows = schedulers;
        if (query) rows = rows.filter((row) => row.name.toLowerCase().includes(query));
        if (filters.status) rows = rows.filter((row) => (filters.status === 'running') === row.running);
        if (filters.type) rows = rows.filter((row) => row.type === filters.type);
        return rows;
    }, [schedulers, filters.q, filters.status, filters.type]);

    const pageRows = filtered.slice(filters.page * filters.limit, (filters.page + 1) * filters.limit);

    function enableScheduler(row: SchedulerInfo) {
        toggleScheduler.mutate(
            { name: row.name, enabled: true },
            {
                onSuccess: () => toast.success(`Scheduler ${row.name} enabled`),
                onError: toastRequestError,
            },
        );
    }

    function confirmDisable() {
        if (!disableTarget) return;
        const target = disableTarget;
        toggleScheduler.mutate(
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

    const columns: DataTableColumn<SchedulerInfo>[] = [
        { key: 'name', header: 'Schedule', mono: true, cell: (row) => row.name },
        {
            key: 'type',
            header: 'Type',
            cell: (row) => (
                <Badge variant="outline" className="capitalize">
                    {row.type}
                </Badge>
            ),
        },
        { key: 'schedule', header: 'Cron / interval', mono: true, cell: (row) => scheduleExpression(row) },
        {
            key: 'status',
            header: 'Status',
            cell: (row) => <StatusDot colorRole={row.running ? 'success' : 'warning'} label={row.running ? 'Running' : 'Paused'} />,
        },
        { key: 'lastRun', header: 'Last run', cell: (row) => formatRelativeTime(row.lastExecution) },
        { key: 'nextRun', header: 'Next run', cell: (row) => formatDateTime(row.nextExecution) },
        {
            key: 'enabled',
            header: 'Enabled',
            cell: (row) => (
                <Switch
                    aria-label={`Toggle ${row.name}`}
                    checked={row.running}
                    onCheckedChange={(checked) => {
                        if (checked) enableScheduler(row);
                        else setDisableTarget(row);
                    }}
                />
            ),
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            cell: (row) =>
                row.type === 'cron' ? (
                    <span className="flex justify-end">
                        <Button variant="ghost" size="icon-sm" aria-label={`Edit cron for ${row.name}`} onClick={() => setEditTarget(row)}>
                            <IconPencil aria-hidden />
                        </Button>
                    </span>
                ) : null,
        },
    ];

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Schedulers"
                meta={
                    <>
                        <span>{formatNumber(schedulers.length)} schedules</span>
                        <span aria-hidden>&middot;</span>
                        <span className="font-mono text-xs">GET /admin/schedulers</span>
                    </>
                }
            />
            <FilterBar shown={filtered.length} total={schedulers.length}>
                <FilterSearch
                    label="Search schedules"
                    placeholder={'Search schedules\u2026'}
                    value={filters.q}
                    onChange={(value) => void setFilters({ q: value || null, page: null })}
                />
                <FilterSelect
                    id="schedulers-status-filter"
                    label="Status"
                    value={filters.status ?? ''}
                    onChange={(value) => void setFilters({ status: (value || null) as 'running' | 'paused' | null, page: null })}
                    options={STATUS_OPTIONS}
                />
                <FilterSelect
                    id="schedulers-type-filter"
                    label="Type"
                    value={filters.type ?? ''}
                    onChange={(value) => void setFilters({ type: (value || null) as 'cron' | 'interval' | 'timeout' | null, page: null })}
                    options={TYPE_OPTIONS}
                />
            </FilterBar>
            <DataTable
                aria-label="Schedulers"
                columns={columns}
                rows={pageRows}
                rowKey={(row) => row.name}
                isLoading={schedulersQuery.isLoading}
                error={schedulersQuery.error ?? undefined}
                onRetry={() => void schedulersQuery.refetch()}
                empty={
                    schedulers.length === 0 ? (
                        <EmptyState
                            icon={IconCalendarTime}
                            title="No schedules defined"
                            description="System crons ship with deployment defaults — dynamic schedules appear once registered."
                        />
                    ) : (
                        <EmptyState icon={IconCalendarTime} title="No schedules match the filters" description="Adjust the search or filters." />
                    )
                }
            />
            <TablePagination
                page={filters.page}
                limit={filters.limit}
                total={filtered.length}
                onPageChange={(page) => void setFilters({ page })}
                onLimitChange={(limit) => void setFilters({ limit, page: null })}
            />
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
        </div>
    );
}
