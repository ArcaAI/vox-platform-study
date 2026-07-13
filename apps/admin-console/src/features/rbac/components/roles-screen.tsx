'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { IconLock, IconPlus, IconSearch, IconShieldCog, IconUsersGroup } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { cx } from '@/shared/cx';
import { useViewportTier } from '@/shared/layout/use-viewport-tier';
import { formatNumber } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateRole, useDeleteRole, useRoles } from '../api/hooks';
import type { Role } from '../api/types';
import { RoleDetailDrawer, RoleDetailPane } from './role-detail';

/** RBAC gateway page size — 100 covers the seeded role catalog (list is grouped, not paged). */
const LIST_LIMIT = 100;

/**
 * TASK-444 — accessible member-count chip for the role detail header (the
 * aria-hidden list-row count is a decorative duplicate of this badge).
 * Renders nothing when the read carried no count (mutation responses).
 */
export function MemberCountBadge({ role }: { role: Pick<Role, 'memberCount'> }) {
    if (typeof role.memberCount !== 'number') return null;
    return (
        <Badge variant="outline" className="tabular-nums">
            <IconUsersGroup aria-hidden />
            {formatNumber(role.memberCount)} {role.memberCount === 1 ? 'member' : 'members'}
        </Badge>
    );
}

/** System roles are seed-managed and locked (frame 21: lock icon + label). */
export function RoleTypeBadge({ role }: { role: Pick<Role, 'isSystemRole'> }) {
    return role.isSystemRole ? (
        <Badge variant="secondary">
            <IconLock aria-hidden />
            System (locked)
        </Badge>
    ) : (
        <Badge variant="outline">Custom</Badge>
    );
}

function CreateRoleDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (role: Role) => void }) {
    const createRole = useCreateRole();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');

    function handleOpenChange(next: boolean) {
        if (!next) {
            setName('');
            setDescription('');
            createRole.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        createRole.mutate(
            { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
            {
                onSuccess: (role) => {
                    toast.success('Role created');
                    handleOpenChange(false);
                    onCreated(role);
                },
                onError: (error) => toast.error(error.message),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>New role</DialogTitle>
                    <DialogDescription>Custom roles start without policies — attach them from the role detail.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-role-name">
                            Name{' '}
                            <span aria-hidden className="text-destructive">
                                *
                            </span>
                        </Label>
                        <Input
                            id="create-role-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Auditor"
                            autoComplete="off"
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="create-role-description">Description</Label>
                        <Textarea
                            id="create-role-description"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="What this role is for"
                            className="resize-none"
                            rows={3}
                        />
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={createRole.isPending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!name.trim() || createRole.isPending}>
                            {createRole.isPending ? <Spinner /> : null}
                            Create role
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RoleListItem({ role, selected, onSelect }: { role: Role; selected: boolean; onSelect: () => void }) {
    return (
        <li>
            <button
                type="button"
                aria-current={selected ? 'true' : undefined}
                onClick={onSelect}
                className={cx(
                    'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm',
                    'focus-visible:ring-ring outline-none focus-visible:ring-2',
                    selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                )}
            >
                {role.isSystemRole ? <IconLock aria-hidden className="text-muted-foreground size-3.5 shrink-0" /> : null}
                <span className="min-w-0 flex-1 truncate font-medium">{role.name}</span>
                {typeof role.memberCount === 'number' ? (
                    // Decorative duplicate of the detail-header MemberCountBadge
                    // (aria-hidden keeps the row's accessible name = the role name).
                    <span aria-hidden className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs tabular-nums">
                        <IconUsersGroup className="size-3.5" />
                        {formatNumber(role.memberCount)}
                    </span>
                ) : null}
            </button>
        </li>
    );
}

function RoleListGroup({ label, roles, selectedId, onSelect }: { label: string; roles: Role[]; selectedId: string | null; onSelect: (id: string) => void }) {
    if (roles.length === 0) return null;
    return (
        <div className="flex flex-col gap-1">
            <p className="text-muted-foreground px-3 pt-2 text-xs font-medium tracking-wide uppercase">
                {label} <span className="tabular-nums">({formatNumber(roles.length)})</span>
            </p>
            <ul className="flex flex-col">
                {roles.map((role) => (
                    <RoleListItem key={role.id} role={role} selected={role.id === selectedId} onSelect={() => onSelect(role.id)} />
                ))}
            </ul>
        </div>
    );
}

function RoleListSkeleton() {
    return (
        <div className="flex flex-col gap-2 p-2">
            {Array.from({ length: 6 }, (_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
            ))}
        </div>
    );
}

function RoleListPanel({
    roles,
    isLoading,
    error,
    onRetry,
    search,
    onSearchChange,
    selectedId,
    onSelect,
    onCreate,
    className,
}: {
    roles: Role[];
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    search: string;
    onSearchChange: (value: string) => void;
    selectedId: string | null;
    onSelect: (id: string) => void;
    onCreate: () => void;
    className?: string;
}) {
    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        return term ? roles.filter((role) => role.name.toLowerCase().includes(term)) : roles;
    }, [roles, search]);
    const system = filtered.filter((role) => role.isSystemRole);
    const custom = filtered.filter((role) => !role.isSystemRole);

    return (
        <div className={cx('flex min-h-0 flex-col', className)} aria-label="Roles">
            <div className="relative shrink-0 p-2">
                <IconSearch aria-hidden className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2" />
                <Input
                    type="search"
                    value={search}
                    onChange={(event) => onSearchChange(event.target.value)}
                    placeholder="Search roles…"
                    aria-label="Search roles"
                    className="pl-8"
                />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                {isLoading ? (
                    <RoleListSkeleton />
                ) : error ? (
                    <div className="p-3">
                        <ErrorState error={error} onRetry={onRetry} />
                    </div>
                ) : roles.length === 0 ? (
                    <div className="p-3">
                        <EmptyState
                            icon={IconUsersGroup}
                            title="No custom roles yet"
                            description="System roles are seed-managed and always present. Create a custom role to group policies."
                            action={
                                <Button onClick={onCreate}>
                                    <IconPlus aria-hidden />
                                    New role
                                </Button>
                            }
                        />
                    </div>
                ) : filtered.length === 0 ? (
                    <p className="text-muted-foreground p-3 text-sm">No roles match “{search}”.</p>
                ) : (
                    <div className="flex flex-col gap-2 pb-2">
                        <RoleListGroup label="System · locked" roles={system} selectedId={selectedId} onSelect={onSelect} />
                        <RoleListGroup label="Custom" roles={custom} selectedId={selectedId} onSelect={onSelect} />
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Frame 21 — RBAC Roles (/rbac/roles, shared tier 20-29). Two-pane redesign
 * (build spec §4): a grouped role list (System · locked / Custom) on the left,
 * a role detail with a derived permission matrix on the right. On tablet/mobile
 * the detail moves into the console-wide `DetailDrawer`. Selection lives in the
 * URL (`?role=`). Delete routes through the screen-level break-glass step-up
 * (DELETE body carries password + confirmationName = the ROLE's exact name).
 */
export function RolesScreen() {
    const tier = useViewportTier();
    const compact = tier !== 'desktop';
    const { data, isLoading, isFetching, error, refetch } = useRoles({ page: 1, pageSize: LIST_LIMIT });
    const roles = data?.data ?? [];
    const systemCount = roles.filter((role) => role.isSystemRole).length;

    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useQueryState('role', parseAsString);
    const [createOpen, setCreateOpen] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<Role | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const deleteRole = useDeleteRole();

    function closeDeleteDialog() {
        setDeleteTarget(null);
        setDeleteError(null);
        deleteRole.reset();
    }

    function handleDeleteConfirm(credentials: BreakGlassCredentials) {
        if (!deleteTarget) return;
        deleteRole.mutate(
            { id: deleteTarget.id, breakGlass: credentials },
            {
                onSuccess: () => {
                    toast.success('Role deleted');
                    if (deleteTarget.id === selectedId) void setSelectedId(null);
                    closeDeleteDialog();
                },
                // 401 wrong password / 400 name mismatch / 403 protected — in-dialog, not a toast.
                onError: (error) => setDeleteError(error.message),
            },
        );
    }

    return (
        <>
            <ScreenTemplate
                contentMode="fill"
                header={
                    <PageHeader
                        title="Roles"
                        meta={
                            data ? (
                                <span>
                                    {formatNumber(roles.length)} roles &middot; {formatNumber(systemCount)} system +{' '}
                                    {formatNumber(roles.length - systemCount)} custom
                                </span>
                            ) : (
                                <Skeleton className="h-4 w-40" />
                            )
                        }
                        actions={
                            <Button onClick={() => setCreateOpen(true)}>
                                <IconPlus aria-hidden />
                                New role
                            </Button>
                        }
                    />
                }
                footer={
                    <StatusFooter
                        start={<span>{isFetching && !isLoading ? 'Refreshing' : 'Up to date'}</span>}
                        end={
                            <span aria-hidden className="font-mono">
                                GET /admin/rbac/roles
                            </span>
                        }
                    />
                }
            >
                {compact ? (
                    <RoleListPanel
                        className="flex-1 rounded-lg border"
                        roles={roles}
                        isLoading={isLoading}
                        error={error}
                        onRetry={() => void refetch()}
                        search={search}
                        onSearchChange={setSearch}
                        selectedId={selectedId}
                        onSelect={(id) => void setSelectedId(id)}
                        onCreate={() => setCreateOpen(true)}
                    />
                ) : (
                    <div className="flex min-h-0 flex-1 gap-6">
                        <RoleListPanel
                            className="w-72 shrink-0 rounded-lg border"
                            roles={roles}
                            isLoading={isLoading}
                            error={error}
                            onRetry={() => void refetch()}
                            search={search}
                            onSearchChange={setSearch}
                            selectedId={selectedId}
                            onSelect={(id) => void setSelectedId(id)}
                            onCreate={() => setCreateOpen(true)}
                        />
                        <div className="flex min-h-0 flex-1 flex-col">
                            {selectedId ? (
                                <RoleDetailPane
                                    key={selectedId}
                                    roleId={selectedId}
                                    tier={tier}
                                    onRequestDelete={setDeleteTarget}
                                    onCloned={(role) => void setSelectedId(role.id)}
                                />
                            ) : (
                                <EmptyState
                                    icon={IconShieldCog}
                                    title="Select a role"
                                    description="Pick a role from the list to see its effective permissions, members and attached policies."
                                />
                            )}
                        </div>
                    </div>
                )}
            </ScreenTemplate>

            {compact ? (
                <RoleDetailDrawer
                    key={selectedId ?? 'no-role'}
                    roleId={selectedId}
                    tier={tier}
                    onOpenChange={(open) => !open && void setSelectedId(null)}
                    onRequestDelete={setDeleteTarget}
                    onCloned={(role) => void setSelectedId(role.id)}
                />
            ) : null}

            <CreateRoleDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(role) => void setSelectedId(role.id)} />

            <BreakGlassDialog
                key={deleteTarget?.id ?? 'delete-role'}
                open={deleteTarget !== null}
                onOpenChange={(open) => !open && closeDeleteDialog()}
                title="Delete role"
                description={
                    <>
                        Soft-deletes <span className="text-foreground font-medium">{deleteTarget?.name}</span>. Users assigned to it lose its
                        policies. Confirm with your password and the exact role name.
                    </>
                }
                confirmationName={deleteTarget?.name ?? ''}
                confirmLabel="Delete role"
                onConfirm={handleDeleteConfirm}
                isPending={deleteRole.isPending}
                error={deleteError}
            />
        </>
    );
}
