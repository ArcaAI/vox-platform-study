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
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useAssignRole, useRemoveRole, useUserRoles } from '../api/hooks';
import type { UserRoleAssignment } from '../api/types';

function roleLabel(assignment: UserRoleAssignment): string {
    return assignment.roleName ?? assignment.roleId;
}

/**
 * Role-assignment dialog: the users surface has no roles catalog (the rbac
 * domain owns it and features do not cross-import), so the AssignRoleRequest
 * fields are plain inputs — role id required, tenant id optional (empty =
 * global assignment).
 */
function AssignRoleDialog({ userId, open, onOpenChange }: { userId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const assignRole = useAssignRole();
    const [roleId, setRoleId] = useState('');
    const [tenantId, setTenantId] = useState('');

    function handleOpenChange(next: boolean) {
        if (!next) {
            setRoleId('');
            setTenantId('');
            assignRole.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!roleId.trim()) return;
        assignRole.mutate(
            { id: userId, body: { roleId: roleId.trim(), ...(tenantId.trim() ? { tenantId: tenantId.trim() } : {}) } },
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
                    <DialogDescription>Grants the role&apos;s permissions to this user. Role ids come from the Roles screen.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-role-id">
                            Role ID <span aria-hidden className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="assign-role-id"
                            value={roleId}
                            onChange={(event) => setRoleId(event.target.value)}
                            autoComplete="off"
                            className="font-mono"
                            required
                        />
                    </div>
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-role-tenant-id">Tenant ID</Label>
                        <Input
                            id="assign-role-tenant-id"
                            value={tenantId}
                            onChange={(event) => setTenantId(event.target.value)}
                            autoComplete="off"
                            className="font-mono"
                        />
                        <p className="text-muted-foreground text-xs">Leave empty for a global (cross-tenant) assignment.</p>
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
        { key: 'role', header: 'Role', cell: (row) => <span className="font-medium">{roleLabel(row)}</span> },
        { key: 'roleId', header: 'Role ID', mono: true, cell: (row) => row.roleId },
        {
            key: 'scope',
            header: 'Scope',
            cell: (row) =>
                row.tenantId ? <span className="font-mono text-xs">{row.tenantId}</span> : <Badge variant="outline">Global</Badge>,
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
