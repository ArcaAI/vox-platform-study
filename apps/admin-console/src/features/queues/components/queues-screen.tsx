'use client';

import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { IconClearAll, IconDots, IconFilterOff, IconPlayerPause, IconPlayerPlay, IconStack2 } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useQueues } from '../api/hooks';
import type { QueueStats } from '../api/types';
import { CleanQueueDialog } from './clean-queue-dialog';
import { PauseResumeDialog } from './pause-resume-dialog';

const QUEUE_STATUS_OPTIONS: FilterOption[] = [
    { value: 'running', label: 'Running' },
    { value: 'paused', label: 'Paused' },
];

/** Client-side list (GET /admin/queues returns every queue): the grid runs uncontrolled. */
const QUEUE_DEFAULT_QUERY_STATE: Partial<DataQueryState> = { sorting: [{ id: 'name', desc: false }] };

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

/**
 * Frame 17 — Queues & Jobs list. The gateway returns every queue in one payload
 * (no server pagination), so this is a client-driven `VirtualizedDataGrid`
 * (uncontrolled): omni search over the queue name, a Status facet, client sort +
 * pager. Row click → /queues/[name].
 */
export function QueuesScreen() {
    const router = useRouter();
    const queuesQuery = useQueues();
    const [rowAction, setRowAction] = useState<RowAction | null>(null);

    const queues = useMemo(() => queuesQuery.data ?? [], [queuesQuery.data]);

    const columns = useMemo<ColumnDef<QueueStats>[]>(
        () => [
            {
                accessorKey: 'name',
                header: 'Queue',
                meta: { label: 'Queue' },
                cell: ({ row }) => <span className="font-mono text-xs">{row.original.name}</span>,
                size: 220,
                minSize: 160,
            },
            {
                id: 'status',
                accessorFn: (row) => (row.isPaused ? 'paused' : 'running'),
                header: 'Status',
                enableSorting: false,
                enableGlobalFilter: false,
                filterFn: 'equalsString',
                meta: { label: 'Status', variant: 'select', options: QUEUE_STATUS_OPTIONS },
                cell: ({ row }) => (
                    <StatusDot colorRole={row.original.isPaused ? 'warning' : 'success'} label={row.original.isPaused ? 'Paused' : 'Running'} />
                ),
                size: 130,
            },
            {
                id: 'waiting',
                accessorFn: (row) => row.counts.waiting,
                header: 'Waiting',
                enableGlobalFilter: false,
                meta: { label: 'Waiting' },
                cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.counts.waiting)}</span>,
                size: 100,
            },
            {
                id: 'active',
                accessorFn: (row) => row.counts.active,
                header: 'Active',
                enableGlobalFilter: false,
                meta: { label: 'Active' },
                cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.counts.active)}</span>,
                size: 100,
            },
            {
                id: 'failed',
                accessorFn: (row) => row.counts.failed,
                header: 'Failed',
                enableGlobalFilter: false,
                meta: { label: 'Failed' },
                cell: ({ row }) => (
                    <span className={row.original.counts.failed > 0 ? 'text-destructive font-medium tabular-nums' : 'tabular-nums'}>
                        {formatNumber(row.original.counts.failed)}
                    </span>
                ),
                size: 100,
            },
            {
                id: 'delayed',
                accessorFn: (row) => row.counts.delayed,
                header: 'Delayed',
                enableGlobalFilter: false,
                meta: { label: 'Delayed' },
                cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.counts.delayed)}</span>,
                size: 100,
            },
            {
                id: 'completed',
                accessorFn: (row) => row.counts.completed,
                header: 'Completed',
                enableGlobalFilter: false,
                meta: { label: 'Completed' },
                cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.counts.completed)}</span>,
                size: 110,
            },
            {
                id: 'workers',
                accessorFn: (row) => row.workerCount,
                header: 'Workers',
                enableGlobalFilter: false,
                meta: { label: 'Workers' },
                cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.workerCount)}</span>,
                size: 100,
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
                cell: ({ row }) => (
                    <QueueRowActions queue={row.original} onAction={(action) => setRowAction({ action, queueName: row.original.name })} />
                ),
            },
        ],
        [],
    );

    return (
        <>
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="Queues & Jobs"
                        meta={<span>{formatNumber(queues.length)} queues</span>}
                    />
                }
                footer={
                    <StatusFooter
                        start={<span>auto-refresh 15s</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/queues
                            </span>
                        }
                    />
                }
            >
                <VirtualizedDataGrid<QueueStats>
                    aria-label="Queues"
                    columns={columns}
                    data={queues}
                    getRowId={(row) => row.name}
                    defaultQueryState={QUEUE_DEFAULT_QUERY_STATE}
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
                    persistence={gridPersistence('queues')}
                    isLoading={queuesQuery.isLoading}
                    isBusy={queuesQuery.isFetching && !queuesQuery.isLoading}
                    error={queuesQuery.error ?? undefined}
                    onRetry={() => void queuesQuery.refetch()}
                    onRowClick={(row) => router.push(`/queues/${encodeURIComponent(row.name)}`)}
                    emptyState={
                        queues.length === 0 ? (
                            <EmptyState
                                icon={IconStack2}
                                title="No queues registered"
                                description="Queues appear once workers connect and register with Redis — empty is not an error."
                            />
                        ) : (
                            <EmptyState icon={IconFilterOff} title="No queues match the filters" description="Adjust the search or status filter." />
                        )
                    }
                />
            </ScreenTemplate>
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
        </>
    );
}
