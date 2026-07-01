import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useTenants, type Tenant } from '@arcaai/vox';
import { createFileRoute, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { Building2, MoreHorizontal, Pencil, Power, PowerOff, ShieldCheck, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { reduceOccConflict } from '@/features/common/occ';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { canManageTenantLifecycle, canModifyTenant, isSuperAdmin, isSystemTenant } from '@/features/tenants/permissions';
import { TenantFormDialog, type TenantDraft } from '@/features/tenants/tenant-form-dialog';
import { TenantLifecycleMenu } from '@/features/tenants/tenant-lifecycle-menu';
import { TenantPlanBadge } from '@/features/tenants/tenant-plan';
import { TenantTagsDialog } from '@/features/tenants/tenant-tags-dialog';
import { initialsOf } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId')({
    staticData: { crumb: { label: { from: 'tenant' } } },
    component: TenantDetailLayout,
});

const TABS = [
    { label: 'Overview', to: '/tenants/$tenantId/overview' },
    { label: 'Users', to: '/tenants/$tenantId/users' },
    { label: 'Configuration', to: '/tenants/$tenantId/configuration' },
    { label: 'Storage', to: '/tenants/$tenantId/storage' },
    { label: 'Departments', to: '/tenants/$tenantId/departments' },
] as const;

function TenantDetailLayout() {
    const { tenantId } = Route.useParams();
    const navigate = useNavigate();
    const location = useLocation();
    const activeTab = TABS.find((t) => location.pathname.includes(`/${t.to.split('/').pop()}`)) ?? TABS[0];
    const { get, update, enable, disable } = useTenants();
    const roles = useAuthStore((s) => s.user?.roles);
    const workingTenantId = useAuthStore((s) => s.tenantId);
    const setWorkingTenant = useAuthStore((s) => s.setTenant);
    const setTenant = useTenantDetailStore((s) => s.setTenant);
    const clear = useTenantDetailStore((s) => s.clear);

    const [tenant, setLocalTenant] = useState<Tenant | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const [tagsOpen, setTagsOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isMutating, setIsMutating] = useState(false);

    const load = () => {
        setLoading(true);
        setError(null);
        get(tenantId)
            .then((t) => {
                setLocalTenant(t);
                setTenant(t);
                // Page-based model: viewing a tenant makes it the working tenant so
                // tenant-scoped tabs (Users/Departments/Audit) and the SDK X-Tenant-Id
                // header target the viewed tenant — i.e. you are "Acting on" it.
                // Tenant-admins are already scoped to their own tenant.
                if (isSuperAdmin(roles) && workingTenantId !== t.id) {
                    setWorkingTenant(t.id, String(t.key ?? ''));
                }
            })
            .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
            .finally(() => setLoading(false));
    };

    useEffect(() => {
        load();
        return () => clear();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    const handleEdit = async (draft: TenantDraft) => {
        if (!tenant) return;
        setIsSaving(true);
        try {
            // `plan` can be cleared to null; the SDK's UpdateTenantInput types it as
            // non-null, but the API + its index signature accept null → cast the payload.
            const payload = { name: draft.name, description: draft.description || undefined, plan: draft.plan } as Parameters<typeof update>[1];
            const updated = await update(tenant.id, payload);
            setLocalTenant(updated);
            setTenant(updated);
            toast.success('Tenant updated');
            setEditOpen(false);
        } catch (err) {
            const occ = reduceOccConflict(err);
            if (occ.conflict) {
                toast.error(occ.message);
                load();
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to update tenant');
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleToggleStatus = async () => {
        if (!tenant) return;
        const enabled = String(tenant.resourceStatus ?? '').toUpperCase() === 'ENABLED';
        setIsMutating(true);
        try {
            const updated = enabled ? await disable(tenant.id) : await enable(tenant.id);
            setLocalTenant(updated);
            setTenant(updated);
            toast.success(enabled ? 'Tenant disabled' : 'Tenant enabled');
        } catch (err) {
            const occ = reduceOccConflict(err);
            if (occ.conflict) {
                toast.error(occ.message);
                load();
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to update status');
            }
        } finally {
            setIsMutating(false);
        }
    };

    if (loading && !tenant) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-3">
                    <Skeleton className="size-12 rounded-lg" />
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-4 w-64" />
                    </div>
                </div>
                <Skeleton className="h-9 w-full max-w-md" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    // 404-over-403: never disclose whether the tenant exists-but-forbidden.
    if (error || !tenant) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Building2 />
                    </EmptyMedia>
                    <EmptyTitle>Tenant not found</EmptyTitle>
                    <EmptyDescription>This tenant doesn’t exist or you don’t have access to it.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button asChild variant="outline">
                        <Link to="/tenants">Back to tenants</Link>
                    </Button>
                </EmptyContent>
            </Empty>
        );
    }

    const system = isSystemTenant(tenant);
    const canModify = canModifyTenant(tenant, roles);
    const canLifecycle = canManageTenantLifecycle(tenant, roles);
    const enabled = String(tenant.resourceStatus ?? '').toUpperCase() === 'ENABLED';
    const tags = Array.isArray(tenant.tags) ? tenant.tags : [];

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Avatar className="size-12">
                        <AvatarFallback className="rounded-lg bg-primary/10 text-base font-semibold text-primary">{initialsOf(tenant.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <h1 className="truncate text-xl font-semibold">{tenant.name}</h1>
                            <StatusBadge label={resourceStatusLabel(tenant.resourceStatus)} colorRole={resourceStatusRole(tenant.resourceStatus)} />
                            {system ? <StatusBadge label="System" colorRole="hope" icon={<ShieldCheck />} /> : null}
                        </div>
                        <p className="truncate text-sm text-muted-foreground">
                            <span className="font-mono">{String(tenant.key ?? '—')}</span>
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                            <span className="inline-flex items-center gap-1.5">
                                <span className="text-muted-foreground">Plan</span>
                                <TenantPlanBadge plan={tenant.plan} />
                            </span>
                            <span className="hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
                            <span className="inline-flex flex-wrap items-center gap-1.5">
                                <span className="text-muted-foreground">Tags</span>
                                {tags.length === 0 ? (
                                    <span className="text-muted-foreground">—</span>
                                ) : (
                                    tags.map((t) => (
                                        <Badge key={t} variant="secondary" className="font-normal">
                                            {t}
                                        </Badge>
                                    ))
                                )}
                                {canModify ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                                        onClick={() => setTagsOpen(true)}
                                    >
                                        <Tag className="size-3.5" />
                                        Edit tags
                                    </Button>
                                ) : null}
                            </span>
                        </div>
                    </div>
                </div>
                {canModify ? (
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={() => setEditOpen(true)}>
                            <Pencil className="size-4" />
                            Edit tenant
                        </Button>
                        {enabled ? (
                            <ConfirmDelete
                                trigger={
                                    <Button variant="outline" disabled={isMutating}>
                                        <PowerOff className="size-4" />
                                        Disable
                                    </Button>
                                }
                                title={`Disable ${tenant.name}?`}
                                description="Disabling archives the tenant and suspends its users — active sessions end immediately. This is recoverable: you can re-enable it any time from the Tenants list."
                                confirmLabel="Disable tenant"
                                onConfirm={handleToggleStatus}
                            />
                        ) : (
                            <Button variant="default" onClick={() => void handleToggleStatus()} disabled={isMutating}>
                                <Power className="size-4" />
                                Enable
                            </Button>
                        )}
                        {canLifecycle ? (
                            <TenantLifecycleMenu
                                tenant={tenant}
                                onChanged={(updated) => {
                                    setLocalTenant(updated);
                                    setTenant(updated);
                                }}
                                trigger={
                                    <Button variant="outline" size="icon" aria-label="More lifecycle actions">
                                        <MoreHorizontal className="size-4" />
                                    </Button>
                                }
                            />
                        ) : null}
                    </div>
                ) : system ? (
                    <p className="text-sm text-muted-foreground">The system tenant is protected.</p>
                ) : null}
            </div>

            {/* Mobile → Select; tablet/desktop → scrollable underline tabs (07 · Responsive). */}
            <div className="md:hidden">
                <Select value={activeTab.to} onValueChange={(to) => void navigate({ to, params: { tenantId } })}>
                    <SelectTrigger className="h-11 w-full" aria-label="Tenant section">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TABS.map((tab) => (
                            <SelectItem key={tab.to} value={tab.to}>
                                {tab.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <nav aria-label="Tenant sections" className="hidden gap-1 overflow-x-auto border-b border-border md:flex">
                {TABS.map((tab) => (
                    <Link
                        key={tab.to}
                        to={tab.to}
                        params={{ tenantId }}
                        className={cn(
                            '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            'data-[status=active]:border-primary data-[status=active]:text-foreground',
                        )}
                        activeProps={{ 'data-status': 'active' }}
                    >
                        {tab.label}
                    </Link>
                ))}
            </nav>

            <Outlet />

            <TenantFormDialog
                open={editOpen}
                onOpenChange={setEditOpen}
                mode="edit"
                initial={tenant}
                existingKeys={[]}
                isSaving={isSaving}
                onSave={handleEdit}
            />

            <TenantTagsDialog
                open={tagsOpen}
                onOpenChange={setTagsOpen}
                tenant={tenant}
                onSaved={(updated) => {
                    setLocalTenant(updated);
                    setTenant(updated);
                }}
            />
        </div>
    );
}
