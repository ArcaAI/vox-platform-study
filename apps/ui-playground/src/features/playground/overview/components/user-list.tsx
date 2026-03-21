import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUsers, useAuth, useAgenticStore, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE, type User } from '@arcaai/vox';
import type { DeepPartial, AppConfig } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';
import { adminClient } from '@/features/admin/api/admin-client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import {
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@arcaai/ui/table';
import { cn } from '@/lib/utils';
import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Search,
    UserCheck,
    UserX,
    Filter,
} from 'lucide-react';
import { toast } from 'sonner';
import {
    type ColumnDef,
    type PaginationState,
    type RowSelectionState,
    flexRender,
    getCoreRowModel,
    useReactTable,
} from '@tanstack/react-table';

const statusFilterOptions = [
    { value: 'all', label: 'All Statuses' },
    { value: 'ENABLED', label: 'Enabled' },
    { value: 'DISABLED', label: 'Disabled' },
];

function getRoles(user: User): string {
    const roles = (user as Record<string, unknown>).roles;
    if (Array.isArray(roles) && roles.length > 0) return roles.join(', ');
    return '—';
}

export function UserList() {
    const { isLoading: usersLoading, listPaginated, search } = useUsers();
    const { isImpersonating: sdkImpersonating, impersonatedUser: sdkImpersonatedUser, impersonate, endImpersonation } = useAuth();
    const localUser = useAuthStore((s) => s.user);
    const persistedImpersonating = useAuthStore((s) => s.isImpersonating);
    const persistedImpersonatedUser = useAuthStore((s) => s.impersonatedUser);
    const isImpersonating = sdkImpersonating || persistedImpersonating;
    const impersonatedUser = sdkImpersonatedUser ?? persistedImpersonatedUser ?? null;
    const canImpersonate = localUser?.roles?.some((r) =>
        ['SUPER_ADMIN', 'TENANT_ADMIN'].includes(r),
    ) ?? false;

    const [searchQuery, setSearchQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [isActionLoading, setIsActionLoading] = useState(false);
    const [pageData, setPageData] = useState<User[]>([]);
    const [totalRowCount, setTotalRowCount] = useState(0);
    const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
    const [pagination, setPagination] = useState<PaginationState>({
        pageIndex: 0,
        pageSize: DEFAULT_PAGE_SIZE,
    });

    const fetchUsers = useCallback(async () => {
        try {
            if (searchQuery.trim()) {
                const result = await search(searchQuery.trim(), { limit: pagination.pageSize });
                setPageData(result);
                setTotalRowCount(result.length);
            } else {
                const result = await listPaginated({
                    page: pagination.pageIndex + 1,
                    limit: pagination.pageSize,
                });
                setPageData(result.data);
                setTotalRowCount(result.total);
            }
        } catch {
            toast.error('Failed to fetch users');
        }
    }, [listPaginated, search, searchQuery, pagination.pageIndex, pagination.pageSize]);

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    const filteredData = useMemo(() => {
        if (statusFilter === 'all') return pageData;
        return pageData.filter((u) => u.resourceStatus === statusFilter);
    }, [pageData, statusFilter]);

    useEffect(() => {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }));
    }, [searchQuery, statusFilter]);

    const columns = useMemo<ColumnDef<User>[]>(() => {
        const cols: ColumnDef<User>[] = [];

        if (!isImpersonating && canImpersonate) {
            cols.push({
                id: 'select',
                header: () => null,
                cell: ({ row }) => (
                    <input
                        type="radio"
                        name="impersonate-user"
                        checked={row.getIsSelected()}
                        aria-label={`Select ${row.original.username}`}
                        readOnly
                        className="size-4 accent-primary cursor-pointer"
                    />
                ),
                size: 48,
                enableSorting: false,
            });
        }

        cols.push(
            {
                accessorKey: 'username',
                header: 'Name',
                cell: ({ row }) => {
                    const isActive = impersonatedUser?.id === row.original.id;
                    return (
                        <div className="flex items-center gap-2 font-medium">
                            {row.original.username}
                            {isActive && (
                                <Badge variant="outline" className="bg-amber-500/15 text-amber-700 text-xs dark:text-amber-400">
                                    Active
                                </Badge>
                            )}
                        </div>
                    );
                },
            },
            {
                accessorKey: 'email',
                header: 'Email',
                cell: ({ row }) => (
                    <span className="text-muted-foreground">{row.original.email || '—'}</span>
                ),
            },
            {
                id: 'role',
                header: 'Role',
                cell: ({ row }) => (
                    <span className="text-muted-foreground">{getRoles(row.original)}</span>
                ),
            },
            {
                accessorKey: 'resourceStatus',
                header: 'Status',
                cell: ({ row }) => {
                    const status = row.original.resourceStatus;
                    return (
                        <Badge
                            variant="outline"
                            className={cn(
                                'text-xs',
                                status === 'ENABLED'
                                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                    : status === 'DISABLED'
                                      ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                                      : '',
                            )}
                        >
                            {status || 'Unknown'}
                        </Badge>
                    );
                },
            },
        );

        return cols;
    }, [isImpersonating, canImpersonate, impersonatedUser?.id]);

    const table = useReactTable({
        data: filteredData,
        columns,
        state: { pagination, rowSelection },
        onPaginationChange: setPagination,
        onRowSelectionChange: setRowSelection,
        getCoreRowModel: getCoreRowModel(),
        manualPagination: true,
        rowCount: totalRowCount,
        enableMultiRowSelection: false,
        getRowId: (row) => row.id,
    });

    const selectedUserId = useMemo(() => {
        const ids = Object.keys(rowSelection).filter((k) => rowSelection[k]);
        return ids.length > 0 ? ids[0] : null;
    }, [rowSelection]);

    const adminPrefsSnapshot = useRef<DeepPartial<AppConfig> | null>(null);

    const handleImpersonate = async () => {
        if (!selectedUserId) {
            toast.error('Please select a user to impersonate');
            return;
        }
        setIsActionLoading(true);
        try {
            const result = await impersonate(selectedUserId);
            let tenantId = result.user.tenantId;
            if (!tenantId && result.token) {
                try {
                    const payload = JSON.parse(atob(result.token.split('.')[1]));
                    if (payload.tenantId) tenantId = payload.tenantId;
                } catch { /* malformed JWT — skip */ }
            }
            useAuthStore.getState().startImpersonation(result.user, result.token, tenantId);

            // TASK-245: Isolate impersonated user's preferences
            const cm = useAgenticStore.getState().configManager;
            if (cm) {
                adminPrefsSnapshot.current = cm.snapshotUserPreferences();
                cm.setReadOnly(true);
                try {
                    const settings = await adminClient.get<Array<{
                        key: string; value: string; dataType?: string; namespace?: string;
                    }>>(`/admin/users/${selectedUserId}/settings`);
                    const sdkSettings = settings.filter((s) => s.namespace === 'arcaai-sdk');
                    const prefs: DeepPartial<AppConfig> = {};
                    for (const s of sdkSettings) {
                        const parts = s.key.split('.');
                        let target: Record<string, unknown> = prefs as Record<string, unknown>;
                        for (let i = 0; i < parts.length - 1; i++) {
                            if (!target[parts[i]]) target[parts[i]] = {};
                            target = target[parts[i]] as Record<string, unknown>;
                        }
                        const dt = String(s.dataType ?? 'STRING').toUpperCase();
                        let val: unknown = s.value;
                        if (dt === 'BOOLEAN') val = s.value === 'true';
                        else if (dt === 'NUMBER' || dt === 'FLOAT' || dt === 'INTEGER') val = Number(s.value);
                        target[parts[parts.length - 1]] = val;
                    }
                    cm.loadExternalPreferences(prefs);
                } catch {
                    // Fallback: impersonate without user prefs (uses defaults)
                }
            }

            toast.success('Impersonation started');
            setRowSelection({});
        } catch {
            toast.error('Failed to impersonate user');
        } finally {
            setIsActionLoading(false);
        }
    };

    const handleEndImpersonation = async () => {
        setIsActionLoading(true);
        try {
            // TASK-245: Restore admin's original preferences
            const cm = useAgenticStore.getState().configManager;
            if (cm) {
                cm.setReadOnly(false);
                if (adminPrefsSnapshot.current) {
                    cm.restoreUserPreferences(adminPrefsSnapshot.current);
                    adminPrefsSnapshot.current = null;
                }
            }

            await endImpersonation();
            useAuthStore.getState().endImpersonation();
            toast.success('Impersonation ended');
        } catch {
            toast.error('Failed to end impersonation');
        } finally {
            setIsActionLoading(false);
        }
    };

    const pageStart = totalRowCount > 0 ? pagination.pageIndex * pagination.pageSize + 1 : 0;
    const pageEnd = Math.min((pagination.pageIndex + 1) * pagination.pageSize, totalRowCount);

    return (
        <Card>
            <CardHeader className="flex flex-col gap-4 space-y-0">
                <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                        <CardTitle className="text-base">User Impersonation</CardTitle>
                        <CardDescription>
                            {canImpersonate
                                ? 'Select a user to impersonate for testing SDK interactions'
                                : 'Requires SUPER_ADMIN or TENANT_ADMIN role'}
                        </CardDescription>
                    </div>
                    <div className="flex shrink-0 gap-2">
                        {isImpersonating ? (
                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={handleEndImpersonation}
                                disabled={isActionLoading}
                            >
                                <UserX className="mr-1.5 size-4" />
                                {isActionLoading ? 'Stopping...' : 'Stop Impersonation'}
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                onClick={handleImpersonate}
                                disabled={!canImpersonate || !selectedUserId || isActionLoading}
                            >
                                <UserCheck className="mr-1.5 size-4" />
                                {isActionLoading ? 'Starting...' : 'Start Impersonation'}
                            </Button>
                        )}
                    </div>
                </div>

                {isImpersonating && (
                    <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                        <UserCheck className="size-4 text-amber-600" />
                        <span className="text-sm">
                            Currently impersonating{' '}
                            <strong>{impersonatedUser?.username || 'a user'}</strong>
                        </span>
                    </div>
                )}

                <div className="flex gap-3">
                    <div className="relative flex-1">
                        <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
                        <Input
                            placeholder="Search by name or email..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="pl-9"
                        />
                    </div>
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                        <SelectTrigger className="w-40">
                            <Filter className="mr-1.5 size-4" />
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {statusFilterOptions.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </CardHeader>

            <CardContent className="flex flex-col gap-4 pt-0">
                <div className="max-h-102.5 overflow-auto rounded-md border">
                    <table className="w-full caption-bottom text-sm">
                        <TableHeader className="bg-background sticky top-0 z-10">
                            {table.getHeaderGroups().map((headerGroup) => (
                                <TableRow key={headerGroup.id}>
                                    {headerGroup.headers.map((header) => (
                                        <TableHead
                                            key={header.id}
                                            style={header.column.columnDef.size ? { width: header.column.columnDef.size } : undefined}
                                        >
                                            {header.isPlaceholder
                                                ? null
                                                : flexRender(header.column.columnDef.header, header.getContext())}
                                        </TableHead>
                                    ))}
                                </TableRow>
                            ))}
                        </TableHeader>
                        <TableBody>
                            {usersLoading && table.getRowModel().rows.length === 0
                                ? Array.from({ length: 5 }).map((_, i) => (
                                      <TableRow key={i}>
                                          {columns.map((_, ci) => (
                                              <TableCell key={ci}>
                                                  <Skeleton className="h-4 w-24" />
                                              </TableCell>
                                          ))}
                                      </TableRow>
                                  ))
                                : table.getRowModel().rows.length > 0
                                  ? table.getRowModel().rows.map((row) => {
                                        const isActive = impersonatedUser?.id === row.original.id;
                                        return (
                                            <TableRow
                                                key={row.id}
                                                data-state={row.getIsSelected() ? 'selected' : undefined}
                                                data-testid={`user-row-${row.original.username}`}
                                                aria-selected={row.getIsSelected()}
                                                tabIndex={!isImpersonating && canImpersonate ? 0 : undefined}
                                                className={cn(
                                                    !isImpersonating && canImpersonate && 'cursor-pointer',
                                                    isActive && 'bg-amber-500/5',
                                                )}
                                                onClick={() => {
                                                    if (!isImpersonating && canImpersonate) {
                                                        setRowSelection((prev) =>
                                                            prev[row.id] ? {} : { [row.id]: true },
                                                        );
                                                    }
                                                }}
                                                onKeyDown={(e) => {
                                                    if ((e.key === 'Enter' || e.key === ' ') && !isImpersonating && canImpersonate) {
                                                        e.preventDefault();
                                                        setRowSelection((prev) =>
                                                            prev[row.id] ? {} : { [row.id]: true },
                                                        );
                                                    }
                                                }}
                                            >
                                                {row.getVisibleCells().map((cell) => (
                                                    <TableCell key={cell.id}>
                                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                                    </TableCell>
                                                ))}
                                            </TableRow>
                                        );
                                    })
                                  : (
                                        <TableRow>
                                            <TableCell colSpan={columns.length} className="text-muted-foreground h-24 text-center">
                                                No users found matching your criteria.
                                            </TableCell>
                                        </TableRow>
                                    )}
                        </TableBody>
                    </table>
                </div>

                <div className="flex items-center justify-between border-t pt-4">
                    <div className="flex items-center gap-4">
                        <span className="text-muted-foreground text-sm">
                            {totalRowCount > 0
                                ? `Showing ${pageStart}–${pageEnd} of ${totalRowCount} users`
                                : '0 users'}
                        </span>
                        <div className="flex items-center gap-2">
                            <span className="text-muted-foreground text-sm">Rows:</span>
                            <Select
                                value={String(pagination.pageSize)}
                                onValueChange={(v) => table.setPageSize(Number(v))}
                            >
                                <SelectTrigger className="h-8 w-18">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PAGE_SIZE_OPTIONS.map((size) => (
                                        <SelectItem key={size} value={String(size)}>
                                            {size}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.firstPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <ChevronsLeft className="size-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.previousPage()}
                            disabled={!table.getCanPreviousPage()}
                        >
                            <ChevronLeft className="size-4" />
                        </Button>
                        <span className="text-sm tabular-nums px-2">
                            {pagination.pageIndex + 1} / {table.getPageCount()}
                        </span>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.nextPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            <ChevronRight className="size-4" />
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="size-8"
                            onClick={() => table.lastPage()}
                            disabled={!table.getCanNextPage()}
                        >
                            <ChevronsRight className="size-4" />
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
