'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { IconBuilding, IconPlus, IconStar, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { type ColumnDef, VirtualizedDataGrid } from '@arcaai/ui';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useDepartmentOptions, useTenantNames } from '@/shared/catalog';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatDateTime } from '@/shared/format';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useAssignDepartment, useRemoveDepartment, useUpdateDepartment, useUserDepartments } from '../api/hooks';
import type { UserDepartment } from '../api/types';

/** Embedded detail-tab grids: no personalization, client-side only (rule #2). */
const EMBEDDED_GRID_FEATURES = {
    columnReorder: false,
    columnResize: false,
    columnPinning: false,
    columnVisibility: false,
    rowSelection: false,
    globalSearch: false,
    facetedFilters: false,
    sorting: true,
} as const;

/** Row label: "Name (CODE)" when the wire populated the department, else the raw id. */
function departmentLabel(row: UserDepartment): string {
    if (!row.departmentName) return row.departmentId;
    return row.departmentCode ? `${row.departmentName} (${row.departmentCode})` : row.departmentName;
}

function AssignDepartmentDialog({ userId, open, onOpenChange }: { userId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
    const assign = useAssignDepartment();
    const departments = useDepartmentOptions();
    const [departmentId, setDepartmentId] = useState('');
    const [isPrimary, setIsPrimary] = useState(false);

    const departmentFallback = departments.isError || (!departments.isLoading && departments.options.length === 0);

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
                    <DialogDescription>Adds a department membership to this user. Pick the department to assign.</DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                    <div className="flex flex-col gap-2">
                        <Label htmlFor="assign-department-id">
                            Department <span aria-hidden className="text-destructive">*</span>
                        </Label>
                        {departmentFallback ? (
                            <Input
                                id="assign-department-id"
                                value={departmentId}
                                onChange={(event) => setDepartmentId(event.target.value)}
                                autoComplete="off"
                                className="font-mono"
                                required
                            />
                        ) : (
                            <Select value={departmentId} onValueChange={setDepartmentId}>
                                <SelectTrigger id="assign-department-id" className="w-full">
                                    <SelectValue placeholder="Select a department" />
                                </SelectTrigger>
                                <SelectContent>
                                    {departments.options.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        )}
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
    // An unscoped GLOBAL_ADMIN sees CROSS-TENANT memberships, so
    // each row is attributed to its tenant (names degrade to raw ids).
    const tenantNames = useTenantNames();
    const update = useUpdateDepartment();
    const remove = useRemoveDepartment();
    const [assignOpen, setAssignOpen] = useState(false);
    const [removal, setRemoval] = useState<UserDepartment | null>(null);
    const rows = data ?? [];

    const handleMakePrimary = useCallback(
        (row: UserDepartment) => {
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
        },
        [id, update],
    );

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

    const columns = useMemo<ColumnDef<UserDepartment>[]>(
        () => [
            {
                id: 'department',
                header: 'Department',
                enableSorting: false,
                meta: { label: 'Department' },
                size: 240,
                minSize: 160,
                cell: ({ row }) => <NameWithId name={row.original.departmentName ? departmentLabel(row.original) : undefined} id={row.original.departmentId} />,
            },
            {
                id: 'tenant',
                header: 'Tenant',
                enableSorting: false,
                meta: { label: 'Tenant' },
                size: 180,
                cell: ({ row }) => <NameWithId name={tenantNames.get(row.original.tenantId)} id={row.original.tenantId} />,
            },
            {
                id: 'primary',
                header: 'Primary',
                enableSorting: false,
                meta: { label: 'Primary' },
                size: 150,
                cell: ({ row }) =>
                    row.original.isPrimary ? (
                        <Badge>
                            <IconStar aria-hidden />
                            Primary
                        </Badge>
                    ) : (
                        <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Make ${departmentLabel(row.original)} primary`}
                            disabled={update.isPending}
                            onClick={(event) => {
                                event.stopPropagation();
                                handleMakePrimary(row.original);
                            }}
                        >
                            Make primary
                        </Button>
                    ),
            },
            {
                id: 'status',
                header: 'Status',
                enableSorting: false,
                meta: { label: 'Status' },
                size: 130,
                cell: ({ row }) =>
                    row.original.resourceStatus ? <ResourceStatusBadge status={row.original.resourceStatus} /> : <span className="text-muted-foreground">{'\u2014'}</span>,
            },
            {
                accessorKey: 'createdAt',
                header: 'Assigned',
                meta: { label: 'Assigned' },
                size: 180,
                cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt)}</span>,
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
                        <Button variant="ghost" size="icon-sm" aria-label={`Remove department ${departmentLabel(row.original)}`} onClick={() => setRemoval(row.original)}>
                            <IconTrash aria-hidden />
                        </Button>
                    </div>
                ),
            },
        ],
        [handleMakePrimary, tenantNames, update.isPending],
    );

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
            <VirtualizedDataGrid<UserDepartment>
                aria-label="Department memberships"
                columns={columns}
                data={rows}
                getRowId={(row) => row.id}
                features={EMBEDDED_GRID_FEATURES}
                height={320}
                isLoading={isLoading}
                error={error}
                onRetry={() => refetch()}
                emptyState={<EmptyState icon={IconBuilding} title="No department memberships" description="Assign a department to scope this user's work." />}
            />
            <AssignDepartmentDialog userId={id} open={assignOpen} onOpenChange={setAssignOpen} />
            {removal ? (
                <ConfirmDialog
                    open
                    onOpenChange={(open) => !open && setRemoval(null)}
                    title={`Remove ${departmentLabel(removal)}?`}
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
