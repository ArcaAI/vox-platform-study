import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUsers, useAuth, useStoreApi, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE, type User } from '@arcaai/vox';
import type { DeepPartial, AppConfig } from '@arcaai/vox';
import { useAuthStore } from '@/store/auth-store';
import { useEndImpersonation } from '@/hooks/use-end-impersonation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Input } from '@arcaai/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { cn } from '@/lib/utils';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search, UserCheck, UserX, Filter } from 'lucide-react';
import { toast } from 'sonner';
import { type ColumnDef, type PaginationState, type RowSelectionState, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

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
  const { isImpersonating: sdkImpersonating, impersonatedUser: sdkImpersonatedUser, impersonate } = useAuth();
  const storeApi = useStoreApi();
  const endImpersonationRoutine = useEndImpersonation();
  const localUser = useAuthStore((s) => s.user);
  const persistedImpersonating = useAuthStore((s) => s.isImpersonating);
  const persistedImpersonatedUser = useAuthStore((s) => s.impersonatedUser);
  const isImpersonating = sdkImpersonating || persistedImpersonating;
  const impersonatedUser = sdkImpersonatedUser ?? persistedImpersonatedUser ?? null;
  // TASK-417 — GLOBAL_ADMIN is the single elevated role.
  const canImpersonate = localUser?.roles?.some((r) => ['GLOBAL_ADMIN', 'TENANT_ADMIN'].includes(r)) ?? false;

  // TASK-327 T6 — a global-scope operator (GLOBAL_ADMIN) has no
  // implicit tenant, so impersonation is ambiguous until they pick one. Tenant
  // admins are locked to their own tenant and are never blocked.
  // TASK-331 doc-06 F5 — point at the real control. Tenant selection moved to
  // the header tenant switcher (the on-page tenant card was removed), so the
  // old "Select a tenant first" tooltip pointed at a control that no longer
  // exists on this page.
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());
  const activeTenantId = useAuthStore((s) => s.tenantId);
  const impersonateBlockReason = isGlobalScope && !activeTenantId ? 'Choose a tenant in the header switcher to start impersonation' : null;
  const needsTenant = impersonateBlockReason !== null;

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
        cell: ({ row }) => <span className="text-muted-foreground">{row.original.email || '—'}</span>,
      },
      {
        id: 'role',
        header: 'Role',
        cell: ({ row }) => <span className="text-muted-foreground">{getRoles(row.original)}</span>,
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

  const handleImpersonate = async () => {
    // Defensive re-check against the live store (the button is also disabled).
    const store = useAuthStore.getState();
    if (store.isGlobalScope() && !store.tenantId) {
      toast.error('Choose a tenant in the header switcher to start impersonation');
      return;
    }
    if (!selectedUserId) {
      toast.error('Please select a user to impersonate');
      return;
    }
    setIsActionLoading(true);
    try {
      // TASK-331 doc-05 F-3 — forward the active tenant so a global admin's
      // selected tenant is honoured; without it the backend falls back to the
      // target's oldest assignment. Only sent when truthy.
      const targetTenantId = store.tenantId || undefined;
      const result = await impersonate(selectedUserId, targetTenantId);
      // TASK-295 M-5: trust `result.user.tenantId` from the server response.
      // The previous `atob(token.split('.')[1])` fallback decoded the JWT
      // client-side, which is both a code smell (re-implementing JWT parsing
      // in a browser without verification) and a sign of dead defensive
      // code: the backend always populates `tenantId` on the response now
      // (TASK-295 H-3). If the server response ever omits it we want to
      // surface that bug — not paper over it.
      const tenantId = result.user.tenantId;
      useAuthStore.getState().startImpersonation(result.user, result.token, tenantId);

      // TASK-331 doc-05 F-2 — load the impersonated user's REAL backend prefs as
      // the SINGLE writer of the ConfigManager user-pref tier. The SDK apiClient
      // now carries the impersonation (doctor) JWT, so GET /user/me/settings
      // returns the impersonated user's OWN settings — unlike the admin-guarded
      // /admin/users/:id/settings, which the doctor token cannot call. Read-only
      // so nothing the admin does while impersonating persists (TASK-245). The
      // provider's identity-change rehydrate skips the user-pref clear/load while
      // impersonating, so this load is never raced/wiped, and reloads the admin's
      // own namespace on exit (F-7 — no manual snapshot needed).
      const cm = storeApi.getState().configManager;
      const apiClient = storeApi.getState().apiClient;
      if (cm && apiClient) {
        cm.setReadOnly(true);
        try {
          const settings = await apiClient.get<
            Array<{
              key: string;
              value: string;
              dataType?: string;
              namespace?: string;
            }>
          >('/user/me/settings');
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
      // TASK-331 doc-05 F-2/F-7 — shared routine: clears ConfigManager read-only
      // (the provider's rehydrate reloads the admin's own namespace on exit, so no
      // component-scoped snapshot is needed) then restores the admin identity.
      await endImpersonationRoutine();
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
              {canImpersonate ? 'Select a user to impersonate for testing SDK interactions' : 'Requires GLOBAL_ADMIN or TENANT_ADMIN role'}
            </CardDescription>
          </div>
          <div className="flex shrink-0 gap-2">
            {isImpersonating ? (
              <Button variant="destructive" size="sm" onClick={handleEndImpersonation} disabled={isActionLoading}>
                <UserX className="mr-1.5 size-4" />
                {isActionLoading ? 'Stopping...' : 'Stop Impersonation'}
              </Button>
            ) : needsTenant ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-not-allowed">
                      <Button size="sm" disabled className="pointer-events-none">
                        <UserCheck className="mr-1.5 size-4" />
                        Start Impersonation
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{impersonateBlockReason}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <Button size="sm" onClick={handleImpersonate} disabled={!canImpersonate || !selectedUserId || isActionLoading}>
                <UserCheck className="mr-1.5 size-4" />
                {isActionLoading ? 'Starting...' : 'Start Impersonation'}
              </Button>
            )}
          </div>
        </div>

        {isImpersonating && (
          <div className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <div className="flex items-center gap-2">
              <UserCheck className="size-4 text-amber-600" />
              <span className="text-sm">
                Currently impersonating <strong>{impersonatedUser?.username || 'a user'}</strong>
              </span>
            </div>
            {/* TASK-331 doc-05 F-6 — impersonation is in-memory only (auth-store
                partialize drops it), so a reload silently reverts to the admin. */}
            <span className="text-muted-foreground pl-6 text-xs">Reloading the page will end impersonation.</span>
          </div>
        )}

        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <Input placeholder="Search by name or email..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9" />
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
                    <TableHead key={header.id} style={header.column.columnDef.size ? { width: header.column.columnDef.size } : undefined}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {usersLoading && table.getRowModel().rows.length === 0 ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {columns.map((_, ci) => (
                      <TableCell key={ci}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length > 0 ? (
                table.getRowModel().rows.map((row) => {
                  const isActive = impersonatedUser?.id === row.original.id;
                  return (
                    <TableRow
                      key={row.id}
                      data-state={row.getIsSelected() ? 'selected' : undefined}
                      data-testid={`user-row-${row.original.username}`}
                      aria-selected={row.getIsSelected()}
                      tabIndex={!isImpersonating && canImpersonate ? 0 : undefined}
                      className={cn(!isImpersonating && canImpersonate && 'cursor-pointer', isActive && 'bg-amber-500/5')}
                      onClick={() => {
                        if (!isImpersonating && canImpersonate) {
                          setRowSelection((prev) => (prev[row.id] ? {} : { [row.id]: true }));
                        }
                      }}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && !isImpersonating && canImpersonate) {
                          e.preventDefault();
                          setRowSelection((prev) => (prev[row.id] ? {} : { [row.id]: true }));
                        }
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                      ))}
                    </TableRow>
                  );
                })
              ) : (
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
              {totalRowCount > 0 ? `Showing ${pageStart}–${pageEnd} of ${totalRowCount} users` : '0 users'}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Rows:</span>
              <Select value={String(pagination.pageSize)} onValueChange={(v) => table.setPageSize(Number(v))}>
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
            <Button variant="outline" size="icon" className="size-8" onClick={() => table.firstPage()} disabled={!table.getCanPreviousPage()}>
              <ChevronsLeft className="size-4" />
            </Button>
            <Button variant="outline" size="icon" className="size-8" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
              <ChevronLeft className="size-4" />
            </Button>
            <span className="text-sm tabular-nums px-2">
              {pagination.pageIndex + 1} / {table.getPageCount()}
            </span>
            <Button variant="outline" size="icon" className="size-8" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
              <ChevronRight className="size-4" />
            </Button>
            <Button variant="outline" size="icon" className="size-8" onClick={() => table.lastPage()} disabled={!table.getCanNextPage()}>
              <ChevronsRight className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
