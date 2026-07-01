import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { CardGrid, EntityCard } from '@arcaai/ui/components/collection';
import { useDepartments } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRight, FolderTree, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { toCreateDepartmentRequest, type DepartmentDraft } from '@/features/tenants/department-draft';
import { DepartmentFormDialog } from '@/features/tenants/department-form-dialog';
import { isSuperAdmin, isSystemTenant } from '@/features/tenants/permissions';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { isAdminRole } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/')({
    component: TenantDepartmentsPage,
});

function TenantDepartmentsPage() {
    const { tenantId } = Route.useParams();
    const navigate = useNavigate();
    const tenant = useTenantDetailStore((s) => s.tenant);
    const roles = useAuthStore((s) => s.user?.roles);
    const superAdmin = isSuperAdmin(roles);
    const system = isSystemTenant(tenant);
    const canManage = !system && isAdminRole(roles ?? undefined);

    const { departments, isLoading, error, list, create } = useDepartments();
    const [search, setSearch] = useState('');
    const [createOpen, setCreateOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    useEffect(() => {
        void list().catch(() => undefined);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return departments;
        return departments.filter((d) => d.name.toLowerCase().includes(q) || String(d.code ?? '').toLowerCase().includes(q));
    }, [departments, search]);

    const handleCreate = async (draft: DepartmentDraft) => {
        setIsSaving(true);
        try {
            await create(toCreateDepartmentRequest(draft));
            toast.success('Department created');
            setCreateOpen(false);
            void list().catch(() => undefined);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to create department');
        } finally {
            setIsSaving(false);
        }
    };

    const openDetail = (id: string) => void navigate({ to: '/tenants/$tenantId/departments/$departmentId', params: { tenantId, departmentId: id } });

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-muted-foreground">{departments.length} departments</p>
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search departments…"
                            className="w-56 pl-8"
                            aria-label="Search departments"
                        />
                    </div>
                    {canManage ? (
                        <Button onClick={() => setCreateOpen(true)}>
                            <Plus className="size-4" />
                            New department
                        </Button>
                    ) : null}
                </div>
            </div>

            <CardGrid<Department>
                aria-label="Departments"
                items={filtered}
                getItemId={(d) => d.id}
                isLoading={isLoading && departments.length === 0}
                error={error ?? undefined}
                minColumnWidth={320}
                renderCard={(d) => {
                    const status = d.resourceStatus as string | undefined;
                    return (
                        <EntityCard
                            title={d.name}
                            icon={FolderTree}
                            status={status ? { label: resourceStatusLabel(status), colorRole: resourceStatusRole(status) } : undefined}
                            meta={
                                <span className="flex flex-col gap-0.5">
                                    {d.code ? <span className="font-mono">{String(d.code)}</span> : null}
                                    {/* TARGET: per-department member / instruction counts + lead have no SDK source. */}
                                    <span className="text-muted-foreground/70">Members & instruction counts not yet available</span>
                                </span>
                            }
                            actions={
                                <Button variant="ghost" size="sm" className="-ml-2 h-7 text-primary" onClick={() => openDetail(d.id)}>
                                    Manage <ArrowRight className="size-3.5" />
                                </Button>
                            }
                        />
                    );
                }}
            />

            {superAdmin && tenant ? (
                <ActingOnBanner
                    tenantName={tenant.name}
                    description="Each department owns its members and PromptTemplate agent instructions. Manage → opens the department detail page; New department opens as a dialog."
                />
            ) : null}

            <DepartmentFormDialog open={createOpen} onOpenChange={setCreateOpen} tenantName={tenant?.name} isSaving={isSaving} onSave={handleCreate} />
        </div>
    );
}
