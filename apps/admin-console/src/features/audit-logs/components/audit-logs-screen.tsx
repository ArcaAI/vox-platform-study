'use client';

import { useState } from 'react';
import { IconChevronDown, IconDownload, IconFilterOff, IconShieldSearch } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useTenantNames } from '@/shared/catalog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { NameWithId } from '@/shared/data/name-with-id';
import { CursorPagination } from '@/shared/data/table-pagination';
import { formatDateTime, formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { useAuditLogs, useAuditLogsCursor, useExportAuditLogs } from '../api/hooks';
import type { AuditExportFormat, AuditLog, AuditLogCursorParams, AuditLogListParams } from '../api/types';
import { AuditLogDetailSheet } from './audit-log-detail-sheet';
import { AuditResultIndicator } from './audit-result-indicator';

const DEFAULT_LIMIT = 25;
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

/** datetime-local value ("2026-07-01T00:00") -> ISO-8601 instant (@IsISO8601). */
function toIsoInstant(local: string): string | undefined {
    if (!local) return undefined;
    const date = new Date(local);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** RFC 6266 attachment filename ('attachment; filename="x.csv"') when present. */
function filenameFromDisposition(disposition: string | null): string | undefined {
    const match = disposition?.match(/filename="?([^";]+)"?/i);
    return match?.[1];
}

function DateTimeFilter({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
    return (
        <div className="flex items-center gap-1.5">
            <Label htmlFor={id} className="text-muted-foreground text-sm font-normal">
                {label}:
            </Label>
            <Input id={id} type="datetime-local" value={value} onChange={(event) => onChange(event.target.value)} className="h-9 w-fit" />
        </div>
    );
}

/**
 * Frame 18 — Audit logs: read-only keyset-paginated event list with filters,
 * a JSON detail drawer and a csv/xlsx/pdf Blob export. Prev support comes
 * from a client-side cursor stack (push on advance, pop on prev).
 */
export function AuditLogsScreen() {
    const [{ action, resourceType, userId, from, to, limit }, setParams] = useQueryStates({
        action: parseAsString.withDefault(''),
        resourceType: parseAsString.withDefault(''),
        userId: parseAsString.withDefault(''),
        from: parseAsString.withDefault(''),
        to: parseAsString.withDefault(''),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
    });
    const [cursorStack, setCursorStack] = useState<string[]>([]);
    const [selected, setSelected] = useState<AuditLog | null>(null);

    /** Shared filter fields (cursor list, total count and export all take them). */
    const filterParams: AuditLogListParams = {
        ...(from ? { from: toIsoInstant(from) } : {}),
        ...(to ? { to: toIsoInstant(to) } : {}),
        ...(action ? { action: action as AuditLog['action'] } : {}),
        ...(resourceType ? { resourceType } : {}),
        ...(userId ? { userId } : {}),
    };
    const cursor = cursorStack.at(-1);
    const cursorParams: AuditLogCursorParams = { ...filterParams, limit, ...(cursor ? { cursor } : {}) };

    const tenantNames = useTenantNames();
    const logsQuery = useAuditLogsCursor(cursorParams);
    // Keyset envelopes carry no total; the offset list's count supplies the
    // frame's "n events" meta + "Showing x of y" without fetching rows.
    const countQuery = useAuditLogs({ ...filterParams, limit: 1 });
    const exportMutation = useExportAuditLogs();

    const rows = logsQuery.data?.data ?? [];
    const total = countQuery.data?.count;
    const hasFilters = Boolean(action || resourceType || userId || from || to);

    /** Any filter change restarts the keyset walk from the first page. */
    function updateFilters(patch: Parameters<typeof setParams>[0]) {
        setCursorStack([]);
        void setParams(patch);
    }

    function handleExport(format: AuditExportFormat) {
        exportMutation.mutate(
            { ...filterParams, format },
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

    const columns: DataTableColumn<AuditLog>[] = [
        {
            key: 'time',
            header: 'Time',
            cell: (row) => (
                <span className="whitespace-nowrap tabular-nums" title={`${row.createdAt} (UTC)`}>
                    {formatDateTime(row.createdAt)}
                </span>
            ),
        },
        {
            key: 'actor',
            header: 'Actor',
            mono: true,
            cell: (row) => row.responsibleUser?.email ?? row.responsibleUser?.displayName ?? row.responsibleUserId ?? 'system',
        },
        {
            key: 'action',
            header: 'Action',
            mono: true,
            cell: (row) => (
                <span className="inline-flex items-center gap-1.5">
                    {row.action}
                    {row.eventType ? <span className="text-muted-foreground">{row.eventType}</span> : null}
                </span>
            ),
        },
        {
            key: 'target',
            header: 'Target',
            cell: (row) => (
                <span className="inline-flex items-center gap-1.5">
                    <span>{row.resourceType}</span>
                    {row.resourceId ? <span className="text-muted-foreground font-mono text-xs">{row.resourceId}</span> : null}
                </span>
            ),
        },
        {
            key: 'tenant',
            header: 'Tenant',
            cell: (row) => (row.tenantId ? <NameWithId name={tenantNames.get(row.tenantId)} id={row.tenantId} /> : EM_DASH),
        },
        { key: 'result', header: 'Result', cell: (row) => <AuditResultIndicator success={row.success} /> },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No events match the filters"
            description="Widen the date range or relax the filters — audit rows are append-only, so nothing is created here."
            action={
                <Button
                    variant="outline"
                    onClick={() => updateFilters({ action: null, resourceType: null, userId: null, from: null, to: null })}
                >
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconShieldSearch}
            title="No audit events yet"
            description="Events appear as soon as administrative activity is recorded — empty is not an error."
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Audit logs"
                meta={
                    <>
                        {/* Keyset lists carry no total; if the count probe fails, omit it. */}
                        {countQuery.data ? <span>{formatNumber(total)} events</span> : countQuery.isError ? null : <Skeleton className="h-4 w-24" />}
                        <span aria-hidden>&middot;</span>
                        <span>read-only</span>
                        <span aria-hidden>&middot;</span>
                        <span className="font-mono text-xs">GET /admin/audit-logs/cursor</span>
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
            <FilterBar shown={countQuery.data ? rows.length : undefined} total={total}>
                <FilterSearch
                    label="Filter by actor user id"
                    placeholder={'Actor user id\u2026'}
                    value={userId}
                    onChange={(value) => updateFilters({ userId: value || null })}
                />
                <FilterSelect
                    id="audit-action-filter"
                    label="Action"
                    value={action}
                    onChange={(value) => updateFilters({ action: value || null })}
                    options={ACTION_OPTIONS}
                />
                <FilterSelect
                    id="audit-resource-type-filter"
                    label="Resource"
                    value={resourceType}
                    onChange={(value) => updateFilters({ resourceType: value || null })}
                    options={RESOURCE_TYPE_OPTIONS}
                />
                <DateTimeFilter id="audit-from-filter" label="From" value={from} onChange={(value) => updateFilters({ from: value || null })} />
                <DateTimeFilter id="audit-to-filter" label="To" value={to} onChange={(value) => updateFilters({ to: value || null })} />
            </FilterBar>
            <DataTable
                aria-label="Audit events"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={logsQuery.isLoading}
                error={logsQuery.error ?? undefined}
                onRetry={() => void logsQuery.refetch()}
                empty={empty}
                onRowClick={setSelected}
            />
            <CursorPagination
                hasPrev={cursorStack.length > 0}
                hasNext={Boolean(logsQuery.data?.hasMore && logsQuery.data.nextCursor)}
                onPrev={() => setCursorStack((stack) => stack.slice(0, -1))}
                onNext={() => {
                    const next = logsQuery.data?.nextCursor;
                    if (next) setCursorStack((stack) => [...stack, next]);
                }}
                shownCount={rows.length}
                limit={limit}
                onLimitChange={(next) => updateFilters({ limit: next === DEFAULT_LIMIT ? null : next })}
            />
            <AuditLogDetailSheet log={selected} onOpenChange={(open) => !open && setSelected(null)} />
        </div>
    );
}
