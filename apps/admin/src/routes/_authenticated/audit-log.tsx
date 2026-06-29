import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { VirtualizedDataGrid } from '@arcaai/ui/components/data-grid';
import type { DataQueryState } from '@arcaai/ui/lib/shared';
import { useAuditLog, type AuditLogEntry } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { CheckCircle2, Download, RotateCcw, XCircle } from 'lucide-react';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import type { AuditCursorFilters } from '@/features/audit-log/audit-cursor-query';
import { useAuditLogCursor } from '@/features/audit-log/use-audit-log-cursor';
import { useGridLayoutPersistence } from '@/features/data-grid/use-grid-persistence';
import { GRID_LAYOUT_NAMESPACE } from '@/lib/constants';

export const Route = createFileRoute('/_authenticated/audit-log')({
    component: AuditLogPage,
});

const PAGE_SIZE_OPTIONS = [20, 50];

function formatTime(value?: string): string {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function userLabel(entry: AuditLogEntry): string {
    return entry.responsibleUser?.displayName || entry.responsibleUser?.email || entry.responsibleUserId || '—';
}

function downloadCsv(filename: string, csv: string): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}

function FilterField({
    id,
    label,
    value,
    placeholder,
    onChange,
}: {
    id: string;
    label: string;
    value: string;
    placeholder?: string;
    onChange: (value: string) => void;
}) {
    return (
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
            <Label htmlFor={id} className="text-xs text-muted-foreground">
                {label}
            </Label>
            <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-9" />
        </div>
    );
}

function AuditLogPage() {
    const adapter = useGridLayoutPersistence();
    const { exportCsv } = useAuditLog();

    const [draft, setDraft] = useState<AuditCursorFilters>({});
    const [filters, setFilters] = useState<AuditCursorFilters>({});
    const [limit, setLimit] = useState(20);
    const [isExporting, setIsExporting] = useState(false);

    const collection = useAuditLogCursor(filters, limit);

    const [queryState, setQueryState] = useState<DataQueryState>({
        pagination: { mode: 'cursor', cursor: null, limit: 20 },
        sorting: [],
        filters: [],
    });
    const currentCursor = queryState.pagination.mode === 'cursor' ? queryState.pagination.cursor : null;

    // The grid's cursor pager commits the next cursor through `onQueryStateChange`
    // (not `onPaginate`), so the forward-paging request is detected here and the
    // collection appends the next page (infinite scroll).
    const onQueryStateChange = useCallback(
        (next: DataQueryState) => {
            if (next.pagination.mode === 'cursor') {
                if (next.pagination.limit !== limit) {
                    setLimit(next.pagination.limit);
                    setQueryState({ ...next, pagination: { mode: 'cursor', cursor: null, limit: next.pagination.limit } });
                    return;
                }
                if (next.pagination.cursor && next.pagination.cursor !== currentCursor) {
                    collection.fetchNextPage?.();
                }
            }
            setQueryState(next);
        },
        [limit, currentCursor, collection],
    );

    const resetPaging = useCallback(() => {
        setQueryState((s) => ({ ...s, pagination: { mode: 'cursor', cursor: null, limit } }));
    }, [limit]);

    const applyFilters = (e: FormEvent) => {
        e.preventDefault();
        setFilters({
            action: draft.action?.trim() || undefined,
            resourceType: draft.resourceType?.trim() || undefined,
            userId: draft.userId?.trim() || undefined,
        });
        resetPaging();
    };

    const clearFilters = () => {
        setDraft({});
        setFilters({});
        resetPaging();
    };

    const onExport = async () => {
        setIsExporting(true);
        try {
            const csv = await exportCsv(filters);
            downloadCsv(`audit-logs-${new Date().toISOString().slice(0, 10)}.csv`, csv);
            toast.success('Audit log exported');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Export failed');
        } finally {
            setIsExporting(false);
        }
    };

    const columns = useMemo<ColumnDef<AuditLogEntry>[]>(
        () => [
            {
                accessorKey: 'createdAt',
                header: 'Time',
                size: 180,
                enableSorting: false,
                meta: { label: 'Time' },
                cell: ({ getValue }) => <span className="whitespace-nowrap text-sm text-muted-foreground">{formatTime(getValue() as string)}</span>,
            },
            {
                accessorKey: 'action',
                header: 'Action',
                size: 150,
                enableSorting: false,
                meta: { label: 'Action' },
                cell: ({ getValue }) => {
                    const action = getValue() as string | undefined;
                    return action ? <StatusBadge label={action} colorRole="info" /> : <span className="text-muted-foreground">—</span>;
                },
            },
            {
                accessorKey: 'resourceType',
                header: 'Resource type',
                size: 150,
                enableSorting: false,
                meta: { label: 'Resource type' },
                cell: ({ getValue }) => <span className="truncate">{(getValue() as string) || '—'}</span>,
            },
            {
                accessorKey: 'resourceId',
                header: 'Resource',
                enableSorting: false,
                meta: { label: 'Resource' },
                cell: ({ getValue }) => <span className="truncate font-mono text-xs text-muted-foreground">{(getValue() as string) || '—'}</span>,
            },
            {
                id: 'user',
                header: 'User',
                enableSorting: false,
                meta: { label: 'User' },
                cell: ({ row }) => <span className="truncate">{userLabel(row.original)}</span>,
            },
            {
                accessorKey: 'responsibleIp',
                header: 'IP',
                size: 140,
                enableSorting: false,
                meta: { label: 'IP' },
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{(getValue() as string) || '—'}</span>,
            },
            {
                accessorKey: 'success',
                header: 'Result',
                size: 120,
                enableSorting: false,
                meta: { label: 'Result' },
                cell: ({ getValue }) =>
                    getValue() === false ? (
                        <StatusBadge label="Failed" colorRole="destructive" icon={<XCircle />} />
                    ) : (
                        <StatusBadge label="Success" colorRole="success" icon={<CheckCircle2 />} />
                    ),
            },
        ],
        [],
    );

    return (
        <div>
            <PageHeader
                title="Audit Log"
                description="Tenant compliance trail with keyset (cursor) pagination — page forward to load more entries. Filter by action, resource or user, then export to CSV."
                actions={
                    <Button variant="outline" onClick={onExport} disabled={isExporting}>
                        <Download className="size-4" />
                        Export CSV
                    </Button>
                }
            />

            <form onSubmit={applyFilters} className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3">
                <FilterField id="f-action" label="Action" value={draft.action ?? ''} placeholder="e.g. CREATE" onChange={(v) => setDraft((d) => ({ ...d, action: v }))} />
                <FilterField id="f-resourceType" label="Resource type" value={draft.resourceType ?? ''} placeholder="e.g. User" onChange={(v) => setDraft((d) => ({ ...d, resourceType: v }))} />
                <FilterField id="f-userId" label="User ID" value={draft.userId ?? ''} placeholder="user id" onChange={(v) => setDraft((d) => ({ ...d, userId: v }))} />
                <div className="flex items-center gap-2">
                    <Button type="submit" size="sm">
                        Apply
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                        <RotateCcw className="size-4" />
                        Clear
                    </Button>
                </div>
            </form>

            <VirtualizedDataGrid<AuditLogEntry>
                aria-label="Audit log"
                data={collection.data}
                columns={columns}
                getRowId={(entry, index) => entry.id ?? String(index)}
                pageMode="cursor"
                manual={{ pagination: true }}
                cursor={{ hasMore: collection.hasNextPage, nextCursor: collection.nextCursor }}
                queryState={queryState}
                onQueryStateChange={onQueryStateChange}
                features={{ sorting: false, globalSearch: false, facetedFilters: false, rowSelection: false }}
                isLoading={collection.isLoading && collection.data.length === 0}
                error={collection.error ?? undefined}
                onRetry={collection.refetch}
                height={560}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                persistence={{ key: 'audit-log', namespace: GRID_LAYOUT_NAMESPACE, adapter }}
            />
        </div>
    );
}
