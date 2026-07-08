'use client';

import { useState } from 'react';
import { IconUsers } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { normalizeList } from '@/shared/data/envelopes';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDepartmentUsers } from '../api/hooks';
import type { DepartmentMember } from '../api/types';

const EM_DASH = '\u2014';

/** Embedded panel grid: fixed viewport, no toolbar/personalization (design-spec D2). */
const MEMBERS_GRID_HEIGHT = 360;

const COLUMNS: ColumnDef<DepartmentMember>[] = [
    {
        id: 'member',
        header: 'Member',
        enableSorting: false,
        enableHiding: false,
        size: 220,
        cell: ({ row }) => (
            <span className="flex items-center gap-2">
                <span className="font-medium">{row.original.username}</span>
                {row.original.isLead ? <Badge variant="secondary">Lead</Badge> : null}
                {row.original.isServiceAccount ? <Badge variant="outline">Service</Badge> : null}
            </span>
        ),
    },
    {
        id: 'role',
        header: 'Role',
        enableSorting: false,
        enableHiding: false,
        size: 220,
        cell: ({ row }) => {
            const roles = row.original.UserRoleAssignments ?? [];
            if (roles.length === 0) return <span className="text-muted-foreground">{EM_DASH}</span>;
            return (
                <span className="flex flex-wrap gap-1">
                    {roles.map((role) => (
                        <Badge key={role.id} variant="secondary">
                            {role.roleName ?? role.roleId}
                        </Badge>
                    ))}
                </span>
            );
        },
    },
    {
        accessorKey: 'resourceStatus',
        header: 'Status',
        enableSorting: false,
        enableHiding: false,
        size: 120,
        cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
    },
    {
        id: 'since',
        header: 'Since',
        enableSorting: false,
        enableHiding: false,
        size: 140,
        cell: ({ row }) => <span className="text-muted-foreground">{formatDateTime(row.original.createdAt, 'date')}</span>,
    },
];

/**
 * Frame 30 members grid: GET :id/users for the selected department, offset-
 * paginated. The frame's "Prim" column has no counterpart on the wire
 * (UserResponse carries no UserDepartment join), so Status stands in.
 * The parent remounts this panel per department (key=id), resetting the page.
 *
 * TASK-423: an embedded grid (design-spec D2) — `VirtualizedDataGrid` at a fixed
 * height with server pagination driven by local query-state; personalization,
 * omni search and the toolbar are off since the endpoint takes only page/limit.
 */
export function DepartmentMembersPanel({ departmentId, departmentName }: { departmentId: string; departmentName: string }) {
    const [queryState, setQueryState] = useState<DataQueryState>({
        pagination: { mode: 'offset', page: 0, limit: 25 },
        sorting: [],
        filters: [],
    });
    const page = queryState.pagination.mode === 'offset' ? queryState.pagination.page : 0;
    const limit = queryState.pagination.limit;

    const members = useDepartmentUsers(departmentId, { page, limit });
    const { rows, total } = normalizeList<DepartmentMember>(members.data);

    return (
        <Card className="gap-3 p-4">
            <div className="flex flex-col gap-0.5">
                <h2 className="text-sm font-semibold">Members of {departmentName}</h2>
                <p aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET :id/users
                </p>
            </div>
            <VirtualizedDataGrid<DepartmentMember>
                aria-label={`Members of ${departmentName}`}
                columns={COLUMNS}
                data={rows}
                getRowId={(row) => row.id}
                height={MEMBERS_GRID_HEIGHT}
                manual={{ pagination: true }}
                rowCount={total ?? 0}
                queryState={queryState}
                onQueryStateChange={setQueryState}
                toolbar={<></>}
                features={{
                    columnReorder: false,
                    columnResize: false,
                    columnPinning: false,
                    columnVisibility: false,
                    rowSelection: false,
                    globalSearch: false,
                    facetedFilters: false,
                    sorting: false,
                }}
                isLoading={members.isPending}
                isBusy={members.isFetching && !members.isPending}
                error={rows.length > 0 ? null : (members.error ?? null)}
                errorState={(error) => <ErrorState error={error} onRetry={() => void members.refetch()} />}
                onRetry={() => void members.refetch()}
                emptyState={
                    <EmptyState
                        icon={IconUsers}
                        title="No members yet"
                        description="Assign users to this department from the Users screen."
                    />
                }
            />
        </Card>
    );
}
