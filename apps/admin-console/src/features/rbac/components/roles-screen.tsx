'use client';

import { useState, type FormEvent } from 'react';
import { IconDots, IconEye, IconFilterOff, IconLock, IconPlus, IconTrash, IconUsersGroup } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@arcaai/ui/components/shadcn/dropdown-menu';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { BreakGlassDialog, type BreakGlassCredentials } from '@/shared/confirm/break-glass-dialog';
import { AdminDataGrid, useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useCreateRole, useDeleteRole, useRoles } from '../api/hooks';
import type { Role } from '../api/types';
import { RoleDetailSheet } from './role-detail-sheet';

/** RBAC gateway page size default (the surface pages one-based with `pageSize`). */
const DEFAULT_LIMIT = 25;

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

function RowActions({ role, onView, onDelete }: { role: Role; onView: () => void; onDelete: () => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Open actions for ${role.name}`} onClick={(event) => event.stopPropagation()}>
                    <IconDots aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            {/* The portal content still bubbles through the React tree to the row's onClick. */}
            <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={onView}>
                    <IconEye aria-hidden />
                    View details
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={role.isSystemRole} onSelect={onDelete}>
                    <IconTrash aria-hidden />
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function CreateRoleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
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
            {
                name: name.trim(),
                ...(description.trim() ? { description: description.trim() } : {}),
            },
            {
                onSuccess: () => {
                    toast.success('Role created');
                    handleOpenChange(false);
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

/**
 * Frame 21 — RBAC Roles (/rbac/roles, shared tier 20-29). AdminDataGrid over
 * the RBAC surface's one-based `{ data, total, page, pageSize }` envelope: the
 * grid's zero-based URL page/limit is bridged to the gateway's page/pageSize,
 * and the omni search maps to the RBAC `search` param. The surface has no
 * server sort, so every column opts out of sorting. Row click -> role detail
 * sheet; create dialog; break-glass delete (DELETE body carries password +
 * confirmationName = the ROLE's exact name).
 */
export function RolesScreen() {
    const query = useAdminGridParams();
    // The RBAC gateway uses `pageSize` (not `limit`); `listParams.page` is already
    // 1-based from the grid seam (`toListParams`), so pass it through unchanged.
    const { data, isLoading, isFetching, error, refetch } = useRoles({
        page: query.listParams.page ?? 1,
        pageSize: query.listParams.limit ?? DEFAULT_LIMIT,
        ...(query.listParams.search ? { search: query.listParams.search } : {}),
    });
    const { rows, total } = normalizeList<Role>(data, { pageBase: 1 });
    const totalCount = total ?? 0;
    const systemCount = rows.filter((row) => row.isSystemRole).length;

    const [createOpen, setCreateOpen] = useState(false);
    const [detailId, setDetailId] = useState<string | null>(null);
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
                    closeDeleteDialog();
                    setDetailId(null);
                },
                // 401 wrong password / 400 name mismatch / 403 protected —
                // surfaced inside the dialog, not as a toast.
                onError: (error) => setDeleteError(error.message),
            },
        );
    }

    const columns: ColumnDef<Role>[] = [
        {
            accessorKey: 'name',
            header: 'Role',
            enableSorting: false,
            meta: { label: 'Role' },
            cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
            size: 220,
            minSize: 160,
        },
        {
            id: 'type',
            header: 'Type',
            enableSorting: false,
            meta: { label: 'Type' },
            cell: ({ row }) => <RoleTypeBadge role={row.original} />,
            size: 160,
        },
        {
            id: 'policies',
            header: 'Policies',
            enableSorting: false,
            meta: { label: 'Policies' },
            cell: ({ row }) => <span className="tabular-nums">{formatNumber(row.original.policies?.length ?? 0)}</span>,
            size: 110,
        },
        {
            accessorKey: 'resourceStatus',
            header: 'Status',
            enableSorting: false,
            meta: { label: 'Status' },
            cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
            size: 140,
        },
        {
            accessorKey: 'updatedAt',
            header: 'Updated',
            enableSorting: false,
            meta: { label: 'Updated' },
            cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
            size: 160,
        },
        {
            id: 'actions',
            header: () => <span className="sr-only">Actions</span>,
            meta: { label: 'Actions' },
            enableSorting: false,
            enableHiding: false,
            enableResizing: false,
            size: 56,
            minSize: 56,
            cell: ({ row }) => (
                <div className="flex w-full justify-end">
                    <RowActions role={row.original} onView={() => setDetailId(row.original.id)} onDelete={() => setDeleteTarget(row.original)} />
                </div>
            ),
        },
    ];

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
                                    {formatNumber(totalCount)} roles &middot; {formatNumber(systemCount)} system +{' '}
                                    {formatNumber(rows.length - systemCount)} custom
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
                <AdminDataGrid<Role>
                    gridId="rbac-roles"
                    aria-label="Roles"
                    columns={columns}
                    rows={rows}
                    total={totalCount}
                    queryState={query.queryState}
                    onQueryStateChange={query.setQueryState}
                    isLoading={isLoading}
                    isBusy={isFetching && !isLoading}
                    error={error}
                    onRetry={() => refetch()}
                    onRowClick={(row) => setDetailId(row.id)}
                    emptyState={
                        <EmptyState
                            icon={IconUsersGroup}
                            title="No custom roles yet"
                            description="System roles are seed-managed and always present. Create a custom role to group policies."
                            action={
                                <Button onClick={() => setCreateOpen(true)}>
                                    <IconPlus aria-hidden />
                                    New role
                                </Button>
                            }
                        />
                    }
                    emptyFilteredState={
                        <EmptyState
                            icon={IconFilterOff}
                            title="No roles match your search"
                            description="Try a different search term."
                            action={
                                <Button variant="outline" onClick={() => query.setQueryState({ ...query.queryState, globalSearch: undefined, filters: [] })}>
                                    <IconFilterOff aria-hidden />
                                    Clear search
                                </Button>
                            }
                        />
                    }
                />
            </ScreenTemplate>
            <CreateRoleDialog open={createOpen} onOpenChange={setCreateOpen} />
            <RoleDetailSheet roleId={detailId} onOpenChange={(open) => !open && setDetailId(null)} onDelete={(role) => setDeleteTarget(role)} />
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
