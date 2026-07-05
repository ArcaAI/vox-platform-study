'use client';

import { useState, type FormEvent } from 'react';
import { IconBuilding, IconPlus, IconStar, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
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
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useAssignDepartment, useRemoveDepartment, useUpdateDepartment, useUserDepartments } from '../api/hooks';
import type { UserDepartment } from '../api/types';

function AssignDepartmentDialog({ userId, open, onOpenChange }: { userId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const assign = useAssignDepartment();
    const [departmentId, setDepartmentId] = useState('');
    const [isPrimary, setIsPrimary] = useState(false);

    function handleOpenChange(next: boolean) {
        if (!next) {
            setDepartmentId('');
            setIsPrimary(false);
            assign.reset();
        }
        onOpenChange(next);
    }

    function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!departmentId.trim()) return;
        assign.mutate(
            { id: userId, body: { departmentId: departmentId.trim(), ...(isPrimary ? { isPrimary: true } : {}) } },
            {
                onSuccess: () => {
                    toast.success('Department assigned');
                    handleOpenChange(false);
                },
                onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not assign the department.'),
            },
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>Assign department</DialogTitle>
                    <DialogDescription>Adds a department membership. Department ids come from the Departments screen.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-department-id">
                            Department ID <span aria-hidden className="text-destructive">*</span>
                        </Label>
                        <Input
                            id="assign-department-id"
                            value={departmentId}
                            onChange={(event) => setDepartmentId(event.target.value)}
                            autoComplete="off"
                            className="font-mono"
                            required
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <Checkbox id="assign-department-primary" checked={isPrimary} onCheckedChange={(checked) => setIsPrimary(checked === true)} />
                        <Label htmlFor="assign-department-primary">Primary department</Label>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={!departmentId.trim() || assign.isPending}>
                            {assign.isPending ? <Spinner /> : null}
                            Assign
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/**
 * Frame 20.1 departments tab: memberships + assign/make-primary/remove. The
 * make-primary PATCH is the screen's etag'd edit — the If-Match version comes
 * from the row's `version` (the list read carries no per-row ETag), and a 412
 * drift surfaces through the shared OCC alert.
 */
export function UserDepartmentsTab({ id }: { id: string }) {
    const { data, isLoading, error, refetch } = useUserDepartments(id);
    const update = useUpdateDepartment();
    const remove = useRemoveDepartment();
    const [assignOpen, setAssignOpen] = useState(false);
    const [removal, setRemoval] = useState<UserDepartment | null>(null);
    const rows = data ?? [];

    function handleMakePrimary(row: UserDepartment) {
        update.mutate(
            { id, assignmentId: row.id, patch: { isPrimary: true }, etag: `"${row.version}"` },
            {
                onSuccess: () => toast.success('Primary department updated'),
                onError: (mutationError) => {
                    // 412/428 render through the OCC alert below, not a toast.
                    if (mutationError instanceof GatewayError && (mutationError.isVersionConflict || mutationError.isMissingPrecondition)) return;
                    toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not update the department.');
                },
            },
        );
    }

    function handleRemove() {
        if (!removal) return;
        remove.mutate(
            { id, assignmentId: removal.id },
            {
                onSuccess: () => {
                    toast.success('Department removed');
                    setRemoval(null);
                },
                onError: (mutationError) =>
                    toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not remove the department.'),
            },
        );
    }

    const columns: DataTableColumn<UserDepartment>[] = [
        { key: 'department', header: 'Department ID', mono: true, cell: (row) => row.departmentId },
        {
            key: 'primary',
            header: 'Primary',
            cell: (row) =>
                row.isPrimary ? (
                    <Badge>
                        <IconStar aria-hidden />
                        Primary
                    </Badge>
                ) : (
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Make ${row.departmentId} primary`}
                        disabled={update.isPending}
                        onClick={(event) => {
                            event.stopPropagation();
                            handleMakePrimary(row);
                        }}
                    >
                        Make primary
                    </Button>
                ),
        },
        {
            key: 'status',
            header: 'Status',
            cell: (row) => (row.resourceStatus ? <ResourceStatusBadge status={row.resourceStatus} /> : <span className="text-muted-foreground">{'\u2014'}</span>),
        },
        { key: 'assigned', header: 'Assigned', cell: (row) => <span className="text-muted-foreground">{formatDateTime(row.createdAt)}</span> },
        {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'w-12 text-right',
            cell: (row) => (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove department ${row.departmentId}`} onClick={() => setRemoval(row)}>
                    <IconTrash aria-hidden />
                </Button>
            ),
        },
    ];

    return (
        <div className="flex flex-col gap-3">
            <OccConflictAlert
                error={update.error}
                onReload={() => {
                    update.reset();
                    void refetch();
                }}
            />
            <div className="flex items-center justify-end">
                <Button variant="outline" onClick={() => setAssignOpen(true)}>
                    <IconPlus aria-hidden />
                    Assign department
                </Button>
            </div>
            <DataTable
                aria-label="Department memberships"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                skeletonRows={3}
                empty={<EmptyState icon={IconBuilding} title="No department memberships" description="Assign a department to scope this user's work." />}
            />
            <AssignDepartmentDialog userId={id} open={assignOpen} onOpenChange={setAssignOpen} />
            {removal ? (
                <ConfirmDialog
                    open
                    onOpenChange={(open) => !open && setRemoval(null)}
                    title={`Remove ${removal.departmentId}?`}
                    description="The user loses this department membership immediately."
                    confirmLabel="Remove"
                    destructive
                    isPending={remove.isPending}
                    onConfirm={handleRemove}
                />
            ) : null}
        </div>
    );
}
