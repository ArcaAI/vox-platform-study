'use client';

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { IconClearAll, IconDots, IconPlayerPause, IconPlayerPlay, IconStack2 } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { useQueues } from '../api/hooks';
import type { QueueStats } from '../api/types';
import { CleanQueueDialog } from './clean-queue-dialog';
import { PauseResumeDialog } from './pause-resume-dialog';

const QUEUE_STATUS_FILTERS = ['running', 'paused'] as const;

const QUEUE_STATUS_OPTIONS = [
    { value: 'running', label: 'Running' },
    { value: 'paused', label: 'Paused' },
];

type RowAction = { action: 'pause' | 'resume' | 'clean'; queueName: string };

const stopClick = (event: MouseEvent) => event.stopPropagation();
const stopKey = (event: KeyboardEvent) => event.stopPropagation();

function QueueRowActions({ queue, onAction }: { queue: QueueStats; onAction: (action: RowAction['action']) => void }) {
    return (
        <span className="flex justify-end" onClick={stopClick} onKeyDown={stopKey}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${queue.name}`}>
                        <IconDots aria-hidden />
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    {queue.isPaused ? (
                        <DropdownMenuItem onSelect={() => onAction('resume')}>
                            <IconPlayerPlay aria-hidden />
                            Resume
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem onSelect={() => onAction('pause')}>
                            <IconPlayerPause aria-hidden />
                            Pause
                        </DropdownMenuItem>
                    )}
                    <DropdownMenuItem variant="destructive" onSelect={() => onAction('clean')}>
                        <IconClearAll aria-hidden />
                        Clean jobs
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </span>
    );
}

/** Frame 17 — Queues & Jobs list. Row click -> /queues/[name]. */
export function QueuesScreen() {
    const router = useRouter();
    const queuesQuery = useQueues();
    const [filters, setFilters] = useQueryStates({
        q: parseAsString.withDefault(''),
        status: parseAsStringLiteral(QUEUE_STATUS_FILTERS),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(25),
    });
    const [sort, setSort] = useState('name:asc');
    const [rowAction, setRowAction] = useState<RowAction | null>(null);

    const queues = useMemo(() => queuesQuery.data ?? [], [queuesQuery.data]);

    const filtered = useMemo(() => {
        const query = filters.q.trim().toLowerCase();
        let rows = queues;
        if (query) rows = rows.filter((row) => row.name.toLowerCase().includes(query));
        if (filters.status) rows = rows.filter((row) => (filters.status === 'paused') === row.isPaused);
        const direction = sort === 'name:desc' ? -1 : 1;
        return [...rows].sort((a, b) => a.name.localeCompare(b.name) * direction);
    }, [queues, filters.q, filters.status, sort]);

    const pageRows = filtered.slice(filters.page * filters.limit, (filters.page + 1) * filters.limit);

    const columns: DataTableColumn<QueueStats>[] = [
        { key: 'name', header: 'Queue', sortKey: 'name', mono: true, cell: (row) => row.name },
        {
            key: 'status',
            header: 'Status',
            cell: (row) => (
                <StatusDot colorRole={row.isPaused ? 'warning' : 'success'} label={row.isPaused ? 'Paused' : 'Running'} />
            ),
        },
        { key: 'waiting', header: 'Waiting', className: 'tabular-nums', cell: (row) => formatNumber(row.counts.waiting) },
        { key: 'active', header: 'Active', className: 'tabular-nums', cell: (row) => formatNumber(row.counts.active) },
        {
            key: 'failed',
            header: 'Failed',
            className: 'tabular-nums',
            cell: (row) => (
                <span className={row.counts.failed > 0 ? 'text-destructive font-medium' : undefined}>
                    {formatNumber(row.counts.failed)}
                </span>
            ),
        },
        { key: 'delayed', header: 'Delayed', className: 'tabular-nums', cell: (row) => formatNumber(row.counts.delayed) },
        { key: 'completed', header: 'Completed', className: 'tabular-nums', cell: (row) => formatNumber(row.counts.completed) },
        { key: 'workers', header: 'Workers', className: 'tabular-nums', cell: (row) => formatNumber(row.workerCount) },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            cell: (row) => <QueueRowActions queue={row} onAction={(action) => setRowAction({ action, queueName: row.name })} />,
        },
    ];

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Queues & Jobs"
                meta={
                    <>
                        <span>{formatNumber(queues.length)} queues</span>
                        <span aria-hidden>&middot;</span>
                        <span className="font-mono text-xs">GET /admin/queues</span>
                        <span aria-hidden>&middot;</span>
                        <span>auto-refresh 15s</span>
                    </>
                }
            />
            <FilterBar shown={filtered.length} total={queues.length}>
                <FilterSearch
                    label="Search queues"
                    placeholder={'Search queues\u2026'}
                    value={filters.q}
                    onChange={(value) => void setFilters({ q: value || null, page: null })}
                />
                <FilterSelect
                    id="queues-status-filter"
                    label="Status"
                    value={filters.status ?? ''}
                    onChange={(value) => void setFilters({ status: (value || null) as 'running' | 'paused' | null, page: null })}
                    options={QUEUE_STATUS_OPTIONS}
                />
            </FilterBar>
            <DataTable
                aria-label="Queues"
                columns={columns}
                rows={pageRows}
                rowKey={(row) => row.name}
                isLoading={queuesQuery.isLoading}
                error={queuesQuery.error ?? undefined}
                onRetry={() => void queuesQuery.refetch()}
                empty={
                    queues.length === 0 ? (
                        <EmptyState
                            icon={IconStack2}
                            title="No queues registered"
                            description="Queues appear once workers connect and register with Redis — empty is not an error."
                        />
                    ) : (
                        <EmptyState icon={IconStack2} title="No queues match the filters" description="Adjust the search or status filter." />
                    )
                }
                onRowClick={(row) => router.push(`/queues/${encodeURIComponent(row.name)}`)}
                sort={sort}
                onSortChange={setSort}
            />
            <TablePagination
                page={filters.page}
                limit={filters.limit}
                total={filtered.length}
                onPageChange={(page) => void setFilters({ page })}
                onLimitChange={(limit) => void setFilters({ limit, page: null })}
            />
            <PauseResumeDialog
                queueName={rowAction?.queueName ?? ''}
                action={rowAction?.action === 'resume' ? 'resume' : 'pause'}
                open={rowAction?.action === 'pause' || rowAction?.action === 'resume'}
                onOpenChange={(open) => {
                    if (!open) setRowAction(null);
                }}
            />
            <CleanQueueDialog
                queueName={rowAction?.queueName ?? ''}
                open={rowAction?.action === 'clean'}
                onOpenChange={(open) => {
                    if (!open) setRowAction(null);
                }}
            />
        </div>
    );
}
