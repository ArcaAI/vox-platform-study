import { Button } from '@arcaai/ui/button';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { VirtualizedDataGrid } from '@arcaai/ui/components/data-grid';
import { useTenants, type Tenant } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef, FilterFn } from '@tanstack/react-table';
import { Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { multiSelectFilterFn, RESOURCE_STATUS_OPTIONS, resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { useGridLayoutPersistence } from '@/features/data-grid/use-grid-persistence';
import { TenantDetailSheet } from '@/features/tenants/tenant-detail-sheet';
import { TenantFormSheet, type TenantDraft } from '@/features/tenants/tenant-form-sheet';
import { GRID_LAYOUT_NAMESPACE } from '@/lib/constants';

export const Route = createFileRoute('/_authenticated/tenants')({
    component: TenantsPage,
});

type TenantRow = Tenant;

function isSystemTenant(t: TenantRow): boolean {
    const key = String(t.key ?? '').toLowerCase();
    return key === 'system' || t.isSystem === true;
}

function TenantsPage() {
    const { tenants, isLoading, error, list, create, update, enable, disable, getConfigs } = useTenants();
    const adapter = useGridLayoutPersistence();

    const [createOpen, setCreateOpen] = useState(false);
    const [editTarget, setEditTarget] = useState<Tenant | null>(null);
    const [detailTarget, setDetailTarget] = useState<Tenant | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isMutating, setIsMutating] = useState(false);

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const existingKeys = useMemo(() => tenants.map((t) => String(t.key ?? '').toLowerCase()).filter(Boolean), [tenants]);

    const handleCreate = async (draft: TenantDraft) => {
        setIsSaving(true);
        try {
            await create({ name: draft.name, key: draft.key || undefined, description: draft.description || undefined });
            toast.success('Tenant created');
            setCreateOpen(false);
            void list().catch(() => undefined);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create tenant');
        } finally {
            setIsSaving(false);
        }
    };

    const handleEdit = async (draft: TenantDraft) => {
        if (!editTarget) return;
        setIsSaving(true);
        try {
            await update(editTarget.id, { name: draft.name, description: draft.description || undefined });
            toast.success('Tenant updated');
            setEditTarget(null);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update tenant');
        } finally {
            setIsSaving(false);
        }
    };

    const handleToggleStatus = async (tenant: Tenant) => {
        const isEnabled = String(tenant.resourceStatus ?? '').toUpperCase() === 'ENABLED';
        setIsMutating(true);
        try {
            const updated = isEnabled ? await disable(tenant.id) : await enable(tenant.id);
            toast.success(isEnabled ? 'Tenant disabled' : 'Tenant enabled');
            setDetailTarget(updated);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update status');
        } finally {
            setIsMutating(false);
        }
    };

    const columns = useMemo<ColumnDef<TenantRow>[]>(
        () => [
            {
                accessorKey: 'name',
                header: 'Name',
                meta: { label: 'Name' },
                cell: ({ row }) => (
                    <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{row.original.name}</span>
                        {isSystemTenant(row.original) ? <StatusBadge label="System" colorRole="hope" icon={<ShieldCheck />} /> : null}
                    </div>
                ),
            },
            {
                accessorKey: 'key',
                header: 'Key',
                meta: { label: 'Key' },
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{(getValue() as string) ?? '—'}</span>,
            },
            {
                accessorKey: 'description',
                header: 'Description',
                enableSorting: false,
                meta: { label: 'Description' },
                cell: ({ getValue }) => <span className="truncate text-muted-foreground">{(getValue() as string) || '—'}</span>,
            },
            {
                accessorKey: 'resourceStatus',
                header: 'Status',
                meta: { label: 'Status', variant: 'multiSelect', options: RESOURCE_STATUS_OPTIONS },
                // `multiSelectFilterFn` is row-type-agnostic (FilterFn<unknown>); TanStack's
                // FilterFn is invariant in TData, so narrow it to this grid's row type here.
                filterFn: multiSelectFilterFn as FilterFn<TenantRow>,
                size: 140,
                cell: ({ getValue }) => {
                    const status = getValue() as string | undefined;
                    return <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} />;
                },
            },
            {
                accessorKey: 'id',
                header: 'ID',
                enableSorting: false,
                meta: { label: 'ID' },
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue() as string}</span>,
            },
        ],
        [],
    );

    return (
        <div>
            <PageHeader
                title="Tenants"
                description="Organizations on the HOPE platform. Select a row to view details; search, filter, sort, reorder and resize columns — your layout and density are saved to your profile."
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <Plus className="size-4" />
                        New tenant
                    </Button>
                }
            />
            <VirtualizedDataGrid<TenantRow>
                aria-label="Tenants"
                data={tenants}
                columns={columns}
                getRowId={(t) => t.id}
                onRowClick={(t) => setDetailTarget(t)}
                features={{ sorting: true, globalSearch: true, facetedFilters: true }}
                isLoading={isLoading && tenants.length === 0}
                error={error ?? undefined}
                onRetry={() => void list().catch(() => undefined)}
                height={560}
                pageSizeOptions={[10, 20, 50]}
                persistence={{ key: 'tenants', namespace: GRID_LAYOUT_NAMESPACE, adapter }}
            />

            <TenantFormSheet
                open={createOpen}
                onOpenChange={setCreateOpen}
                mode="create"
                existingKeys={existingKeys}
                isSaving={isSaving}
                onSave={handleCreate}
            />
            <TenantFormSheet
                open={editTarget !== null}
                onOpenChange={(o) => {
                    if (!o) setEditTarget(null);
                }}
                mode="edit"
                initial={editTarget}
                existingKeys={existingKeys}
                isSaving={isSaving}
                onSave={handleEdit}
            />
            <TenantDetailSheet
                tenant={detailTarget}
                open={detailTarget !== null}
                onOpenChange={(o) => {
                    if (!o) setDetailTarget(null);
                }}
                isSystem={detailTarget ? isSystemTenant(detailTarget) : false}
                isMutating={isMutating}
                onEdit={(t) => {
                    setDetailTarget(null);
                    setEditTarget(t);
                }}
                onToggleStatus={handleToggleStatus}
                loadConfigs={getConfigs}
            />
        </div>
    );
}
