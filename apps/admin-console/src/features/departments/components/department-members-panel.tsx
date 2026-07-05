'use client';

import { useState } from 'react';
import { IconUsers } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatDateTime } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useDepartmentUsers } from '../api/hooks';
import type { DepartmentMember } from '../api/types';

const EM_DASH = '\u2014';

const COLUMNS: DataTableColumn<DepartmentMember>[] = [
    {
        key: 'member',
        header: 'Member',
        cell: (row) => (
            <span className="flex items-center gap-2">
                <span className="font-medium">{row.username}</span>
                {row.isServiceAccount ? <Badge variant="outline">Service</Badge> : null}
            </span>
        ),
    },
    {
        key: 'role',
        header: 'Role',
        cell: (row) => {
            const roles = row.UserRoleAssignments ?? [];
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
        key: 'status',
        header: 'Status',
        cell: (row) => <ResourceStatusBadge status={row.resourceStatus} />,
    },
    {
        key: 'since',
        header: 'Since',
        cell: (row) => <span className="text-muted-foreground">{formatDateTime(row.createdAt, 'date')}</span>,
    },
];

/**
 * Frame 30 members grid: GET :id/users for the selected department, offset-
 * paginated. The frame's "Prim" column has no counterpart on the wire
 * (UserResponse carries no UserDepartment join), so Status stands in.
 * The parent remounts this panel per department (key=id), resetting the page.
 */
export function DepartmentMembersPanel({ departmentId, departmentName }: { departmentId: string; departmentName: string }) {
    const [page, setPage] = useState(0);
    const [limit, setLimit] = useState(25);
    const members = useDepartmentUsers(departmentId, { page, limit });

    const rows = members.data ? [...members.data.data] : [];
    const count = members.data?.count ?? 0;

    return (
        <Card className="gap-3 p-4">
            <div className="flex flex-col gap-0.5">
                <h2 className="text-sm font-semibold">Members of {departmentName}</h2>
                <p aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET :id/users
                </p>
            </div>
            <DataTable
                aria-label={`Members of ${departmentName}`}
                columns={COLUMNS}
                rows={rows}
                rowKey={(row) => row.id}
                isLoading={members.isPending}
                error={members.error}
                onRetry={() => void members.refetch()}
                skeletonRows={5}
                empty={
                    <EmptyState
                        icon={IconUsers}
                        title="No members yet"
                        description="Assign users to this department from the Users screen."
                    />
                }
            />
            {count > 0 ? (
                <TablePagination
                    page={page}
                    limit={limit}
                    total={count}
                    onPageChange={setPage}
                    onLimitChange={(nextLimit) => {
                        setLimit(nextLimit);
                        setPage(0);
                    }}
                />
            ) : null}
        </Card>
    );
}
