import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@arcaai/ui/dropdown-menu';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useDepartments, useRoles, useUsers, type User } from '@arcaai/vox';
import { createFileRoute, Link } from '@tanstack/react-router';
import { MoreHorizontal, Pencil, Power, PowerOff, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { reduceOccConflict } from '@/features/common/occ';
import { isSuperAdmin, isSystemTenant } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { ActivityPanel } from '@/features/users/detail/activity-panel';
import { DepartmentsPanel } from '@/features/users/detail/departments-panel';
import { DnaReportsPanel } from '@/features/users/detail/dna-reports-panel';
import { DnaStylePanel } from '@/features/users/detail/dna-style-panel';
import { InstructionsPanel } from '@/features/users/detail/instructions-panel';
import { PreferencesPanel } from '@/features/users/detail/preferences-panel';
import { ProfilePanel } from '@/features/users/detail/profile-panel';
import { UserEditDialog } from '@/features/users/user-edit-dialog';
import { toUpdateUserInput, type ProfileDraft } from '@/features/users/user-draft';
import { deriveUserStatus } from '@/features/users/user-query';
import { cn, initialsOf } from '@/lib/utils';
import { isAdminRole } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/users/$userId')({
    staticData: { crumb: [{ label: 'Users', to: '/tenants/$tenantId/users' }, { label: { from: 'user' } }] },
    component: UserDetailPage,
});

const TABS = [
    { key: 'profile', label: 'Profile' },
    { key: 'preferences', label: 'Preferences' },
    { key: 'instructions', label: 'Agent instructions' },
    { key: 'dna-style', label: 'DNA Style' },
    { key: 'departments', label: 'Departments' },
    { key: 'dna-reports', label: 'DNA Reports' },
    { key: 'activity', label: 'Activity' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function UserDetailPage() {
    const { tenantId, userId } = Route.useParams();
    const tenant = useTenantDetailStore((s) => s.tenant);
    const setUser = useTenantDetailStore((s) => s.setUser);
    const authRoles = useAuthStore((s) => s.user?.roles);
    const authUserId = useAuthStore((s) => s.user?.id);
    const superAdmin = isSuperAdmin(authRoles);
    const system = isSystemTenant(tenant);
    const canManage = !system && isAdminRole(authRoles ?? undefined);

    const { get, update, enable, disable } = useUsers();
    const { listUserRoleAssignments } = useRoles();
    const { departments, list: listDepartments } = useDepartments();

    const [user, setLocalUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [roleNames, setRoleNames] = useState<string[]>([]);
    const [tab, setTab] = useState<TabKey>('profile');
    const [editOpen, setEditOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isMutating, setIsMutating] = useState(false);

    const load = () => {
        setLoading(true);
        setError(null);
        get(userId)
            .then((u) => {
                setLocalUser(u);
                setUser(u);
            })
            .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
            .finally(() => setLoading(false));
        listUserRoleAssignments(userId)
            .then((items) => setRoleNames(items.map((a) => a.roleName ?? a.roleId).filter(Boolean)))
            .catch(() => setRoleNames([]));
    };

    useEffect(() => {
        load();
        void listDepartments().catch(() => undefined);
        return () => setUser(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId]);

    const deptList = useMemo(() => departments.map((d) => ({ id: d.id, name: d.name })), [departments]);
    const isSelf = !!authUserId && authUserId === userId;

    const handleEdit = async (draft: ProfileDraft) => {
        if (!user) return;
        setIsSaving(true);
        try {
            const updated = await update(user.id, toUpdateUserInput(draft));
            setLocalUser(updated);
            setUser(updated);
            toast.success('Profile updated');
            setEditOpen(false);
        } catch (err) {
            const occ = reduceOccConflict(err);
            if (occ.conflict) {
                toast.error(occ.message);
                load();
            } else {
                toast.error(err instanceof Error ? err.message : 'Failed to update profile');
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleToggleStatus = async () => {
        if (!user) return;
        const enabled = String(user.resourceStatus ?? '').toUpperCase() === 'ENABLED';
        setIsMutating(true);
        try {
            const updated = enabled ? await disable(user.id) : await enable(user.id);
            setLocalUser(updated);
            setUser(updated);
            toast.success(enabled ? 'User disabled' : 'User enabled');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update status');
        } finally {
            setIsMutating(false);
        }
    };

    if (loading && !user) {
        return (
            <div className="space-y-6">
                <div className="flex items-center gap-3">
                    <Skeleton className="size-12 rounded-full" />
                    <div className="space-y-2">
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-4 w-64" />
                    </div>
                </div>
                <Skeleton className="h-9 w-full max-w-xl" />
                <Skeleton className="h-64 w-full" />
            </div>
        );
    }

    if (error || !user) {
        return (
            <Empty>
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <UserRound />
                    </EmptyMedia>
                    <EmptyTitle>User not found</EmptyTitle>
                    <EmptyDescription>This user doesn’t exist or you don’t have access to them.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                    <Button asChild variant="outline">
                        <Link to="/tenants/$tenantId/users" params={{ tenantId }}>
                            Back to users
                        </Link>
                    </Button>
                </EmptyContent>
            </Empty>
        );
    }

    const status = deriveUserStatus(user);
    const enabled = String(user.resourceStatus ?? '').toUpperCase() === 'ENABLED';

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                    <Avatar className="size-12">
                        <AvatarFallback className="bg-primary/10 text-base font-semibold text-primary">{initialsOf(user.username)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <h1 className="truncate text-xl font-semibold">{user.username}</h1>
                            <StatusBadge label={status.label} colorRole={status.colorRole} />
                        </div>
                        <p className="truncate text-sm text-muted-foreground">
                            {user.email ? `${user.email} · ` : ''}
                            <span className="font-mono">@{user.username}</span>
                            {roleNames.length ? ` · ${roleNames.join(', ')}` : ''}
                        </p>
                    </div>
                </div>
                {canManage ? (
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={() => setEditOpen(true)}>
                            <Pencil className="size-4" />
                            Edit profile
                        </Button>
                        {/* TARGET: no reset-password endpoint. */}
                        <Button variant="outline" disabled title="Target · password reset ships later">
                            Reset password
                            <span className="ml-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning">Target</span>
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="outline" size="icon" aria-label="More actions">
                                    <MoreHorizontal className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    onClick={() => void handleToggleStatus()}
                                    disabled={isMutating}
                                    className={enabled ? 'text-destructive focus:text-destructive' : undefined}
                                >
                                    {enabled ? <PowerOff className="size-4" /> : <Power className="size-4" />}
                                    {enabled ? 'Disable user' : 'Enable user'}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                ) : null}
            </div>

            {/* Mobile → Select; tablet/desktop → scrollable underline tabs (07 · Responsive). */}
            <div className="md:hidden">
                <Select value={tab} onValueChange={(v) => setTab(v as TabKey)}>
                    <SelectTrigger className="h-11 w-full" aria-label="User section">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TABS.map((t) => (
                            <SelectItem key={t.key} value={t.key}>
                                {t.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
            <nav aria-label="User sections" className="hidden gap-1 overflow-x-auto border-b border-border md:flex">
                {TABS.map((t) => (
                    <button
                        key={t.key}
                        type="button"
                        onClick={() => setTab(t.key)}
                        data-status={tab === t.key ? 'active' : undefined}
                        className={cn(
                            '-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            'data-[status=active]:border-primary data-[status=active]:text-foreground',
                        )}
                    >
                        {t.label}
                    </button>
                ))}
            </nav>

            {tab === 'profile' ? <ProfilePanel user={user} roleNames={roleNames} canManage={canManage} onEdit={() => setEditOpen(true)} /> : null}
            {tab === 'preferences' ? <PreferencesPanel /> : null}
            {tab === 'instructions' ? <InstructionsPanel user={user} departments={deptList} tenantId={tenantId} /> : null}
            {tab === 'dna-style' ? <DnaStylePanel user={user} /> : null}
            {tab === 'departments' ? <DepartmentsPanel userId={user.id} departments={deptList} canManage={canManage} /> : null}
            {tab === 'dna-reports' ? <DnaReportsPanel user={user} isSelf={isSelf} /> : null}
            {tab === 'activity' ? <ActivityPanel userId={user.id} /> : null}

            {superAdmin && tenant ? (
                <ActingOnBanner
                    tenantName={tenant.name}
                    description="Users aren’t tenant-scoped — membership derives from role and department assignments. Profile, department assignment, agent instructions, DNA reports and activity are live. Editing another user’s preferences and password reset are planned (Target)."
                />
            ) : null}

            <UserEditDialog open={editOpen} onOpenChange={setEditOpen} user={user} isSaving={isSaving} onSave={handleEdit} />
        </div>
    );
}
