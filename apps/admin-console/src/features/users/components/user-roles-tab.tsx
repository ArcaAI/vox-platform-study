'use client';

import { useState, type FormEvent } from 'react';
import { IconPlus, IconShieldCheck, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { SYSTEM_TENANT_ID, useRoleOptions, useTenantCatalog, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useAssignRole, useRemoveRole, useUserRoles } from '../api/hooks';
import type { UserRoleAssignment } from '../api/types';

function roleLabel(assignment: UserRoleAssignment): string {
    return assignment.roleName ?? assignment.roleId;
}

/** Radix Select reserves '', so an omitted (global) tenant maps through a sentinel. */
const GLOBAL_TENANT = '__global__';

/**
 * Role-assignment dialog: the role and tenant scope come from the shared
 * catalogs (id → name), so assignment is a pick-by-name flow. A caller that
 * cannot list roles/tenants (e.g. a tenant admin) gets an empty catalog — the
 * field falls back to the free-text id input so the flow never dead-ends.
 */
function AssignRoleDialog({ userId, open, onOpenChange }: { userId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const assignRole = useAssignRole();
    const roles = useRoleOptions();
    const tenantCatalog = useTenantCatalog();
    const [roleId, setRoleId] = useState('');
    const [tenantChoice, setTenantChoice] = useState(GLOBAL_TENANT);
    const [tenantText, setTenantText] = useState('');

    const roleFallback = roles.isError || (!roles.isLoading && roles.options.length === 0);
    const tenants = tenantCatalog.data ?? [];
    const tenantFallback = tenantCatalog.isError || (!tenantCatalog.isLoading && tenants.length === 0);

    function handleOpenChange(next: boolean) {
        if (!next) {
            setRoleId('');
            setTenantChoice(GLOBAL_TENANT);
            setTenantText('');
            assignRole.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const role = roleId.trim();
        if (!role) return;
        const tenantId = tenantFallback ? tenantText.trim() : tenantChoice === GLOBAL_TENANT ? '' : tenantChoice;
        assignRole.mutate(
            { id: userId, body: { roleId: role, ...(tenantId ? { tenantId } : {}) } },
            {
                onSuccess: () => {
                    toast.success('Role assigned');
                    handleOpenChange(false);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not assign the role.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Assign role</DialogTitle>
                    <DialogDescription>Grants the role&apos;s permissions to this user. Pick a role and, optionally, a tenant to scope it to.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-role-id">
                            Role <span aria-hidden className="text-destructive">*</span>
                        </Label>
                        {roleFallback ? (
                            <Input
                                id="assign-role-id"
                                value={roleId}
                                onChange={(event) => setRoleId(event.target.value)}
                                autoComplete="off"
                                className="font-mono"
                                required
                            />
                        ) : (
                            <Select value={roleId} onValueChange={setRoleId}>
                                <SelectTrigger id="assign-role-id" className="w-full">
                                    <SelectValue placeholder="Select a role" />
                                </SelectTrigger>
                                <SelectContent>
                                    {roles.options.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-role-tenant-id">Tenant</Label>
                        {tenantFallback ? (
                            <>
                                <Input
                                    id="assign-role-tenant-id"
                                    value={tenantText}
                                    onChange={(event) => setTenantText(event.target.value)}
                                    autoComplete="off"
                                    className="font-mono"
                                />
                                <p className="text-muted-foreground text-xs">Leave empty for a global (cross-tenant) assignment.</p>
                            </>
                        ) : (
                            <Select value={tenantChoice} onValueChange={setTenantChoice}>
                                <SelectTrigger id="assign-role-tenant-id" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={GLOBAL_TENANT}>Global (cross-tenant)</SelectItem>
                                    {tenants.map((tenant) => (
                                        <SelectItem key={tenant.id} value={tenant.id}>
                                            {tenant.name || tenant.key || tenant.id}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!roleId.trim() || assignRole.isPending}>
                            {assignRole.isPending ? <Spinner /> : null}
                            Assign
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** Frame 20.1 roles tab: assignment list + assign/remove. */
export function UserRolesTab({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useUserRoles(id);
    const removeRole = useRemoveRole();
    const tenantNames = useTenantNames();
    const [assignOpen, setAssignOpen] = useState(false);
    const [removal, setRemoval] = useState<UserRoleAssignment | null>(null);
    const rows = data?.data ?? [];

    function handleRemove() {
        if (!removal) return;
        removeRole.mutate(
            { id, assignmentId: removal.id },
            {
                onSuccess: () => {
                    toast.success('Role removed');
                    setRemoval(null);
                },
                onError: (mutationError) => toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not remove the role.'),
            },
        );
    }

    const columns: DataTableColumn<UserRoleAssignment>[] = [
        { key: 'role', header: 'Role', cell: (row) => <NameWithId name={row.roleName} id={row.roleId} /> },
        {
            key: 'scope',
            header: 'Scope',
            cell: (row) =>
                !row.tenantId || row.tenantId === SYSTEM_TENANT_ID ? (
                    <Badge variant="outline">Global</Badge>
                ) : (
                    <NameWithId name={tenantNames.get(row.tenantId)} id={row.tenantId} />
                ),
        },
        { key: 'assigned', header: 'Assigned', cell: (row) => <span className="text-muted-foreground">{formatDateTime(row.createdAt)}</span> },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove role ${roleLabel(row)}`} onClick={() => setRemoval(row)}>
                    <IconTrash aria-hidden />
                </Button>
            ),
        },
    ];

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-end">
                <Button variant="outline" onClick={() => setAssignOpen(true)}>
                    <IconPlus aria-hidden />
                    Assign role
                </Button>
            </div>
            <DataTable
                aria-label="Role assignments"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                skeletonRows={3}
                empty={<EmptyState icon={IconShieldCheck} title="No roles assigned" description="Assign a role to grant this user permissions." />}
            />
            <AssignRoleDialog userId={id} open={assignOpen} onOpenChange={setAssignOpen} />
            {removal ? (
                <ConfirmDialog
                    open
                    onOpenChange={(open) => !open && setRemoval(null)}
                    title={`Remove ${roleLabel(removal)}?`}
                    description="The user loses this role's permissions immediately."
                    confirmLabel="Remove"
                    destructive
                    isPending={removeRole.isPending}
                    onConfirm={handleRemove}
                />
            ) : null}
        </div>
    );
}
