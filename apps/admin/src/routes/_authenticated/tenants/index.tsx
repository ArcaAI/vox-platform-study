import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useTenants, type Tenant } from '@arcaai/vox';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { ColumnDef, FilterFn } from '@tanstack/react-table';
import { Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { ResponsiveDataGrid } from '@/features/data-grid/responsive-data-grid';
import { multiSelectFilterFn, RESOURCE_STATUS_OPTIONS, resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { useGridLayoutPersistence } from '@/features/data-grid/use-grid-persistence';
import { canManageTenantLifecycle, isSystemTenant } from '@/features/tenants/permissions';
import { TenantFormDialog, type TenantDraft } from '@/features/tenants/tenant-form-dialog';
import { TenantLifecycleMenu } from '@/features/tenants/tenant-lifecycle-menu';
import { TenantPlanBadge } from '@/features/tenants/tenant-plan';
import { GRID_LAYOUT_NAMESPACE } from '@/lib/constants';
import { initialsOf } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';

export const Route = createFileRoute('/_authenticated/tenants/')({
    component: TenantsListPage,
});

function TenantsListPage() {
    const { tenants, isLoading, error, list, create } = useTenants();
    const adapter = useGridLayoutPersistence();
    const navigate = useNavigate();
    const roles = useAuthStore((s) => s.user?.roles);

    const [createOpen, setCreateOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        void list().catch(() => undefined);
    }, [list]);

    const existingKeys = useMemo(() => tenants.map((t) => String(t.key ?? '').toLowerCase()).filter(Boolean), [tenants]);

    const handleCreate = async (draft: TenantDraft) => {
        setIsSaving(true);
        try {
            await create({
                name: draft.name,
                key: draft.key || undefined,
                description: draft.description || undefined,
                plan: draft.plan ?? undefined,
            });
            toast.success('Tenant created');
            setCreateOpen(false);
            void list().catch(() => undefined);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create tenant');
        } finally {
            setIsSaving(false);
        }
    };

    const columns = useMemo<ColumnDef<Tenant>[]>(
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
                filterFn: multiSelectFilterFn as FilterFn<Tenant>,
                size: 140,
                cell: ({ getValue }) => {
                    const status = getValue() as string | undefined;
                    return <StatusBadge label={resourceStatusLabel(status)} colorRole={resourceStatusRole(status)} />;
                },
            },
            {
                accessorKey: 'plan',
                header: 'Plan',
                meta: { label: 'Plan' },
                size: 120,
                cell: ({ getValue }) => <TenantPlanBadge plan={getValue() as Tenant['plan']} />,
            },
            {
                accessorKey: 'id',
                header: 'ID',
                enableSorting: false,
                meta: { label: 'ID' },
                cell: ({ getValue }) => <span className="font-mono text-xs text-muted-foreground">{getValue() as string}</span>,
            },
            {
                id: 'actions',
                header: '',
                enableSorting: false,
                enableHiding: false,
                size: 56,
                cell: ({ row }) =>
                    canManageTenantLifecycle(row.original, roles) ? (
                        // Stop row-navigation when interacting with the lifecycle menu (portalled dialog is unaffected).
                        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                            <TenantLifecycleMenu tenant={row.original} onChanged={() => void list().catch(() => undefined)} />
                        </div>
                    ) : null,
            },
        ],
        [roles, list],
    );

    return (
        <div>
            <PageHeader
                title="Tenants"
                description="Organizations on the HOPE platform. Select a row to open its detail; search, filter, sort, reorder and resize columns — your layout and density are saved to your profile."
                actions={
                    <Button className="max-md:hidden" onClick={() => setCreateOpen(true)}>
                        <Plus className="size-4" />
                        New tenant
                    </Button>
                }
            />
            <ResponsiveDataGrid<Tenant>
                aria-label="Tenants"
                data={tenants}
                columns={columns}
                getRowId={(t) => t.id}
                onRowClick={(t) => void navigate({ to: '/tenants/$tenantId', params: { tenantId: t.id } })}
                features={{ sorting: true, globalSearch: true, facetedFilters: true }}
                isLoading={isLoading && tenants.length === 0}
                error={error ?? undefined}
                onRetry={() => void list().catch(() => undefined)}
                height={560}
                pageSizeOptions={[10, 20, 50]}
                persistence={{ key: 'tenants', namespace: GRID_LAYOUT_NAMESPACE, adapter }}
                condensedColumnIds={['name', 'key', 'resourceStatus', 'plan', 'actions']}
                mobileSearchPlaceholder="Search tenants…"
                mobileFilter={(t, q) =>
                    [t.name, String(t.key ?? ''), String(t.description ?? '')].some((f) => f.toLowerCase().includes(q.toLowerCase()))
                }
                mobilePrimaryAction={{ label: 'New tenant', icon: <Plus className="size-6" />, onClick: () => setCreateOpen(true) }}
                mobileCard={(t) => ({
                    id: t.id,
                    avatar: (
                        <Avatar className="size-10">
                            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initialsOf(t.name)}</AvatarFallback>
                        </Avatar>
                    ),
                    title: (
                        <span className="flex items-center gap-1.5 truncate">
                            <span className="truncate">{t.name}</span>
                            {isSystemTenant(t) ? <StatusBadge label="System" colorRole="hope" icon={<ShieldCheck />} /> : null}
                        </span>
                    ),
                    subtitle: <span className="font-mono">{String(t.key ?? '—')}</span>,
                    badge: <StatusBadge label={resourceStatusLabel(t.resourceStatus)} colorRole={resourceStatusRole(t.resourceStatus)} />,
                    meta: <TenantPlanBadge plan={t.plan} />,
                    actions: canManageTenantLifecycle(t, roles) ? (
                        <TenantLifecycleMenu tenant={t} onChanged={() => void list().catch(() => undefined)} />
                    ) : undefined,
                    onClick: () => void navigate({ to: '/tenants/$tenantId', params: { tenantId: t.id } }),
                })}
            />

            <TenantFormDialog
                open={createOpen}
                onOpenChange={setCreateOpen}
                mode="create"
                existingKeys={existingKeys}
                isSaving={isSaving}
                onSave={handleCreate}
            />
        </div>
    );
}
