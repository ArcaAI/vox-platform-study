'use client';

import { useCallback, useMemo, useState } from 'react';
import { IconChevronDown, IconDownload, IconFilterOff, IconShieldSearch } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef } from '@arcaai/ui';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useTenantNames } from '@/shared/catalog';
import { AdminDataGrid } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatDateTime, formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { useAuditLogs, useAuditLogsCursor, useExportAuditLogs } from '../api/hooks';
import type { AuditExportFormat, AuditLog } from '../api/types';
import { useAuditGridParams } from '../hooks/use-audit-grid-params';
import { AuditLogDetailSheet } from './audit-log-detail-sheet';
import { AuditResultIndicator } from './audit-result-indicator';

const EM_DASH = '\u2014';

/** AuditAction gateway enum — the cursor DTO validates against exactly these. */
const ACTION_OPTIONS: FilterOption[] = [
    { value: 'CREATE', label: 'Create' },
    { value: 'READ', label: 'Read' },
    { value: 'UPDATE', label: 'Update' },
    { value: 'DELETE', label: 'Delete' },
    { value: 'ARCHIVE', label: 'Archive' },
    { value: 'LOGIN', label: 'Login' },
    { value: 'LOGOUT', label: 'Logout' },
    { value: 'IMPERSONATED_ACTION', label: 'Impersonated action' },
];

/** Gateway ResourceType enum (packages/domains) — values pass through as-is. */
const RESOURCE_TYPE_VALUES = [
    'AuditLog', 'ApiKey', 'Department', 'GlobalSetting', 'IntegrationPackage', 'IntegrationItem', 'Media',
    'Notification', 'ResourceSubscription', 'Role', 'Permission', 'RolePermission', 'Tag', 'Tenant',
    'UserRoleAssignment', 'User', 'UserSettings', 'UserProfile', 'UserMedia', 'Webhook', 'WebhookRunHistory',
    'Consultation', 'ContextItem', 'ContextItemVersion', 'AudioRecording', 'SummaryMeta', 'NamedEntity',
    'AsrPipeline', 'AiModel', 'TranscriptionJob', 'PromptTemplate', 'DnaWritingStyleReport', 'TenantBucket',
    'StorageAccessKey', 'TenantStorageConfig', 'Highlight', 'AsrPipelineVersion', 'UserVoiceProfile',
    'UserDepartment', 'TenantFrontendConfig',
] as const;

const RESOURCE_TYPE_OPTIONS: FilterOption[] = RESOURCE_TYPE_VALUES.map((value) => ({ value, label: value }));

const EXPORT_FORMATS: AuditExportFormat[] = ['csv', 'xlsx', 'pdf'];

/** RFC 6266 attachment filename ('attachment; filename="x.csv"') when present. */
function filenameFromDisposition(disposition: string | null): string | undefined {
    const match = disposition?.match(/filename="?([^";]+)"?/i);
    return match?.[1];
}

/**
 * Frame 18 — Audit logs: read-only keyset-paginated event list on the
 * server-driven AdminDataGrid (cursor pager). Omni search targets the actor id;
 * Action / Resource type / Time are typed column filters. Prev/Next walk the
 * grid's internal cursor stack; a JSON detail drawer opens on row click and the
 * header exports a csv/xlsx/pdf Blob under the active filters.
 */
export function AuditLogsScreen() {
    const grid = useAuditGridParams();
    const [selected, setSelected] = useState<AuditLog | null>(null);

    const tenantNames = useTenantNames();
    const logsQuery = useAuditLogsCursor(grid.listParams);
    // Keyset envelopes carry no total; the offset list's count supplies the
    // frame's "n events" meta without fetching rows.
    const countQuery = useAuditLogs({ ...grid.filterParams, limit: 1 });
    const exportMutation = useExportAuditLogs();

    const { rows } = normalizeList<AuditLog>(logsQuery.data);
    const total = countQuery.data?.count;

    const clearFilters = useCallback(
        () => grid.setQueryState({ ...grid.queryState, globalSearch: undefined, filters: [] }),
        [grid],
    );

    function handleExport(format: AuditExportFormat) {
        exportMutation.mutate(
            { ...grid.filterParams, format },
            {
                onSuccess: ({ blob, contentDisposition }) => {
                    const filename = filenameFromDisposition(contentDisposition) ?? `audit-logs.${format}`;
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = filename;
                    anchor.click();
                    URL.revokeObjectURL(url);
                    toast.success(`Export ready \u2014 ${filename}`);
                },
                onError: (error) => toast.error(error instanceof Error ? error.message : 'Export failed'),
            },
        );
    }

    const columns = useMemo<ColumnDef<AuditLog>[]>(
        () => [
            {
                accessorKey: 'createdAt',
                header: 'Time',
                enableSorting: false,
                enableHiding: false,
                meta: { label: 'Time', variant: 'dateRange' },
                cell: ({ row }) => (
                    <span className="whitespace-nowrap tabular-nums" title={`${row.original.createdAt} (UTC)`}>
                        {formatDateTime(row.original.createdAt)}
                    </span>
                ),
                size: 180,
            },
            {
                accessorKey: 'responsibleUserId',
                header: 'Actor',
                enableSorting: false,
                meta: { label: 'Actor' },
                cell: ({ row }) => (
                    <span className="font-mono text-xs">
                        {row.original.responsibleUser?.email ?? row.original.responsibleUser?.displayName ?? row.original.responsibleUserId ?? 'system'}
                    </span>
                ),
                size: 200,
            },
            {
                accessorKey: 'action',
                header: 'Action',
                enableSorting: false,
                meta: { label: 'Action', variant: 'multiSelect', options: ACTION_OPTIONS },
                cell: ({ row }) => (
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                        {row.original.action}
                        {row.original.eventType ? <span className="text-muted-foreground">{row.original.eventType}</span> : null}
                    </span>
                ),
                size: 160,
            },
            {
                accessorKey: 'resourceType',
                header: 'Resource type',
                enableSorting: false,
                meta: { label: 'Resource type', variant: 'multiSelect', options: RESOURCE_TYPE_OPTIONS },
                cell: ({ row }) => (
                    <span className="inline-flex items-center gap-1.5">
                        <span>{row.original.resourceType}</span>
                        {row.original.resourceId ? <span className="text-muted-foreground font-mono text-xs">{row.original.resourceId}</span> : null}
                    </span>
                ),
                size: 220,
            },
            {
                accessorKey: 'tenantId',
                header: 'Tenant',
                enableSorting: false,
                meta: { label: 'Tenant' },
                cell: ({ row }) => (row.original.tenantId ? <NameWithId name={tenantNames.get(row.original.tenantId)} id={row.original.tenantId} /> : EM_DASH),
                size: 200,
            },
            {
                id: 'result',
                header: 'Result',
                enableSorting: false,
                enableResizing: false,
                meta: { label: 'Result' },
                cell: ({ row }) => <AuditResultIndicator success={row.original.success} />,
                size: 100,
            },
        ],
        [tenantNames],
    );

    return (
        <>
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="Audit logs"
                        meta={
                            <>
                                {/* Keyset lists carry no total; if the count probe fails, omit it. */}
                                {countQuery.data ? <span>{formatNumber(total)} events</span> : countQuery.isError ? null : <Skeleton className="h-4 w-24" />}
                                <span aria-hidden>&middot;</span>
                                <span>read-only</span>
                            </>
                        }
                        actions={
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button disabled={exportMutation.isPending}>
                                        {exportMutation.isPending ? <Spinner /> : <IconDownload aria-hidden />}
                                        Export
                                        <IconChevronDown aria-hidden />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    {EXPORT_FORMATS.map((format) => (
                                        <DropdownMenuItem key={format} onSelect={() => handleExport(format)}>
                                            {format.toUpperCase()}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        }
                    />
                }
                footer={
                    <StatusFooter
                        start={<span>{logsQuery.isFetching && !logsQuery.isLoading ? 'Refreshing' : 'Up to date'}</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/audit-logs/cursor
                            </span>
                        }
                    />
                }
            >
                <AdminDataGrid<AuditLog>
                    gridId="audit-logs"
                    aria-label="Audit events"
                    columns={columns}
                    rows={rows}
                    total={total ?? 0}
                    queryState={grid.queryState}
                    onQueryStateChange={grid.setQueryState}
                    pageMode="cursor"
                    cursor={{ hasMore: logsQuery.data?.hasMore, nextCursor: logsQuery.data?.nextCursor }}
                    isLoading={logsQuery.isLoading}
                    isBusy={logsQuery.isFetching && !logsQuery.isLoading}
                    error={logsQuery.error ?? undefined}
                    onRetry={() => void logsQuery.refetch()}
                    onRowClick={setSelected}
                    emptyState={
                        <EmptyState
                            icon={IconShieldSearch}
                            title="No audit events yet"
                            description="Events appear as soon as administrative activity is recorded — empty is not an error."
                        />
                    }
                    emptyFilteredState={
                        <EmptyState
                            icon={IconFilterOff}
                            title="No events match the filters"
                            description="Widen the date range or relax the filters — audit rows are append-only, so nothing is created here."
                            action={
                                <Button variant="outline" onClick={clearFilters}>
                                    <IconFilterOff aria-hidden />
                                    Clear filters
                                </Button>
                            }
                        />
                    }
                />
            </ScreenTemplate>
            <AuditLogDetailSheet log={selected} onOpenChange={(open) => !open && setSelected(null)} />
        </>
    );
}
