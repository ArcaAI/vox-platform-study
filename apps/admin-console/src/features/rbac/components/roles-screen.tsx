'use client';

import { useState, type FormEvent } from 'react';
import { IconDots, IconEye, IconFilterOff, IconLock, IconPlus, IconTrash, IconUsersGroup } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
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
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useCreateRole, useDeleteRole, useRoles } from '../api/hooks';
import type { Role } from '../api/types';
import { RoleDetailSheet } from './role-detail-sheet';

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
 * Frame 21 — RBAC Roles (/rbac/roles, shared tier 20-29). Paginated list
 * (the RBAC surface uses a one-based page + pageSize envelope), row click ->
 * role detail sheet, create dialog, and break-glass delete (DELETE body
 * carries password + confirmationName = the ROLE's exact name).
 */
export function RolesScreen() {
    const [{ search, page, limit }, setParams] = useQueryStates({
        search: parseAsString.withDefault(''),
        page: parseAsInteger.withDefault(0),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
    });

    const query = useRoles({
        // TablePagination is zero-based; the RBAC gateway pages from 1.
        page: page + 1,
        pageSize: limit,
        ...(search ? { search } : {}),
    });
    const rows = query.data?.data ?? [];
    const total = query.data?.total ?? 0;
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

    const columns: DataTableColumn<Role>[] = [
        { key: 'name', header: 'Role', cell: (row) => <span className="font-medium">{row.name}</span> },
        { key: 'type', header: 'Type', cell: (row) => <RoleTypeBadge role={row} /> },
        {
            key: 'policies',
            header: 'Policies',
            cell: (row) => <span className="tabular-nums">{formatNumber(row.policies?.length ?? 0)}</span>,
        },
        { key: 'status', header: 'Status', cell: (row) => <ResourceStatusBadge status={row.resourceStatus} /> },
        {
            key: 'updated',
            header: 'Updated',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.updatedAt)}</span>,
        },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => <RowActions role={row} onView={() => setDetailId(row.id)} onDelete={() => setDeleteTarget(row)} />,
        },
    ];

    const empty = search ? (
        <EmptyState
            icon={IconFilterOff}
            title="No roles match your search"
            description="Try a different search term."
            action={
                <Button variant="outline" onClick={() => setParams({ search: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear search
                </Button>
            }
        />
    ) : (
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
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="Roles"
                meta={
                    <>
                        {query.data ? (
                            <span>
                                {formatNumber(total)} roles &middot; {formatNumber(systemCount)} system + {formatNumber(rows.length - systemCount)}{' '}
                                custom
                            </span>
                        ) : (
                            <Skeleton className="h-4 w-40" />
                        )}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/rbac/roles
                        </span>
                    </>
                }
                actions={
                    <Button onClick={() => setCreateOpen(true)}>
                        <IconPlus aria-hidden />
                        New role
                    </Button>
                }
            />
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Search roles"
                    placeholder={'Search roles\u2026'}
                    value={search}
                    onChange={(value) => setParams({ search: value || null, page: null })}
                />
            </FilterBar>
            <DataTable
                aria-label="Roles"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={query.isPending}
                error={query.error}
                onRetry={() => void query.refetch()}
                empty={empty}
                onRowClick={(row) => setDetailId(row.id)}
            />
            <TablePagination
                page={page}
                limit={limit}
                total={total}
                onPageChange={(next) => setParams({ page: next || null })}
                onLimitChange={(next) => setParams({ limit: next === DEFAULT_LIMIT ? null : next, page: null })}
            />
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
        </div>
    );
}
