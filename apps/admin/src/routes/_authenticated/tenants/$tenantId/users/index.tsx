import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@arcaai/ui/dropdown-menu';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { toPaginatedQuery, type DataQueryState } from '@arcaai/ui/lib/shared';
import { useDepartments, useRoles, useUsers, type User } from '@arcaai/vox';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table';
import { ChevronDown, Download, Eye, KeyRound, MoreHorizontal, Power, PowerOff, UserPlus, VenetianMask } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { toast } from 'sonner';
import { CheckboxPickerDialog, type PickerOption } from '@/features/common/checkbox-picker-dialog';
import { ResponsiveDataGrid } from '@/features/data-grid/responsive-data-grid';
import { useGridLayoutPersistence } from '@/features/data-grid/use-grid-persistence';
import { isSuperAdmin, isSystemTenant } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { AssignRoleDialog } from '@/features/users/assign-role-dialog';
import { bulkSelectionReducer, selectedRowIds, selectionCount } from '@/features/users/bulk-selection';
import { downloadBlob, downloadTextFile, exportExtension, timestampedCsvName, timestampedExportName } from '@/features/users/download';
import { ImpersonateDialog } from '@/features/users/impersonate-dialog';
import { ResetPasswordDialog } from '@/features/users/reset-password-dialog';
import type { BulkUserActionType, UserExportFormat } from '@/features/users/sdk-types';
import { toCreateUserInput, type CreateUserDraft } from '@/features/users/user-draft';
import { toUserCsv } from '@/features/users/user-export';
import { deriveUserStatus, toUserListQuery, USER_STATUS_FACET_OPTIONS, USER_TYPE_FACET_OPTIONS, userTypeLabel } from '@/features/users/user-query';
import { UserCreateDialog } from '@/features/users/user-create-dialog';
import { UsersBulkBar } from '@/features/users/users-bulk-bar';
import { GRID_LAYOUT_NAMESPACE } from '@/lib/constants';
import { initialsOf, isAdminRole } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/users/')({
  component: TenantUsersPage,
});

const INITIAL_QUERY_STATE: DataQueryState = {
  pagination: { mode: 'offset', page: 0, limit: 20 },
  sorting: [],
  filters: [],
};

/** Best-effort role extraction — the directory list MAY embed `roles`; degrade to none. */
function rolesOf(user: User): string[] {
  const raw = (user as { roles?: unknown }).roles;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) =>
      typeof r === 'string'
        ? r
        : r && typeof r === 'object'
          ? String((r as { name?: string; roleName?: string }).name ?? (r as { roleName?: string }).roleName ?? '')
          : '',
    )
    .filter(Boolean);
}

type AssignTarget = { kind: 'user'; user: User } | { kind: 'bulk'; ids: string[] } | null;

/** Past-tense verbs for the per-item bulk-action toast. */
const BULK_LABELS: Record<BulkUserActionType, string> = {
  enable: 'enabled',
  disable: 'disabled',
  delete: 'deleted',
  'assign-departments': 'updated',
  'assign-role': 'assigned the role',
};

function TenantUsersPage() {
  const { tenantId } = Route.useParams();
  const navigate = useNavigate();
  const tenant = useTenantDetailStore((s) => s.tenant);
  const roleNames = useAuthStore((s) => s.user?.roles);
  const authUserId = useAuthStore((s) => s.user?.id);
  const superAdmin = isSuperAdmin(roleNames);
  const system = isSystemTenant(tenant);
  const canManage = !system && isAdminRole(roleNames ?? undefined);

  const { listPaginated, create, enable, disable, assignDepartments, bulkAction, exportUsers } = useUsers();
  const { roles: roleList, listRoles, assignRoleToUser } = useRoles();
  const { departments, list: listDepartments } = useDepartments();
  const adapter = useGridLayoutPersistence();

  const [rows, setRows] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [queryState, setQueryState] = useState<DataQueryState>(INITIAL_QUERY_STATE);

  const [rowSelection, dispatchSelection] = useReducer(bulkSelectionReducer, {});
  const [createOpen, setCreateOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<AssignTarget>(null);
  // TASK-398 P1-6 — bulk assign-role picker; holds the ids captured when opened.
  const [assignRoleIds, setAssignRoleIds] = useState<string[] | null>(null);
  const [resetUser, setResetUser] = useState<{ id: string; username: string } | null>(null);
  // TASK-401 — super-admin act-as; hidden for self/disabled targets below.
  const [impersonateUser, setImpersonateUser] = useState<{ id: string; username: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isBulkBusy, setIsBulkBusy] = useState(false);

  const query = useMemo(() => toUserListQuery(queryState.pagination, toPaginatedQuery(queryState)), [queryState]);
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const fetchPage = useCallback(() => {
    setIsLoading(true);
    setError(null);
    listPaginated(query)
      .then((res) => {
        setRows(res.data);
        setTotal(res.total);
      })
      .catch((err) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setIsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  useEffect(() => {
    void listDepartments().catch(() => undefined);
    void listRoles().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const deptNameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const roleOptions = useMemo(() => roleList.map((r) => ({ label: r.name, value: r.id })), [roleList]);
  const deptFacetOptions = useMemo(() => departments.map((d) => ({ label: d.name, value: d.id })), [departments]);
  const deptPickerOptions = useMemo<PickerOption[]>(() => departments.map((d) => ({ id: d.id, primary: d.name })), [departments]);

  const onQueryStateChange = useCallback((next: DataQueryState) => {
    setQueryState((prev) => {
      const shapeChanged =
        JSON.stringify(prev.filters) !== JSON.stringify(next.filters) ||
        (prev.globalSearch ?? '') !== (next.globalSearch ?? '') ||
        prev.pagination.limit !== next.pagination.limit;
      if (shapeChanged && next.pagination.mode === 'offset') {
        return { ...next, pagination: { ...next.pagination, page: 0 } };
      }
      return next;
    });
  }, []);

  const openDetail = (id: string) => void navigate({ to: '/tenants/$tenantId/users/$userId', params: { tenantId, userId: id } });

  const handleToggleStatus = async (user: User) => {
    const enabled = String(user.resourceStatus ?? '').toUpperCase() === 'ENABLED';
    try {
      await (enabled ? disable(user.id) : enable(user.id));
      toast.success(enabled ? 'User disabled' : 'User enabled');
      fetchPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update status');
    }
  };

  // Shared per-user action menu — identical behavior in the desktop/tablet grid
  // column and the mobile card (TASK-384), so responsiveness adds no new feature.
  const renderUserActions = (user: User) => {
    const enabled = String(user.resourceStatus ?? '').toUpperCase() === 'ENABLED';
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${user.username}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openDetail(user.id)}>
            <Eye className="size-4" />
            View
          </DropdownMenuItem>
          {superAdmin && enabled && user.id !== authUserId ? (
            <DropdownMenuItem onClick={() => setImpersonateUser({ id: user.id, username: user.username })}>
              <VenetianMask className="size-4" />
              Impersonate
            </DropdownMenuItem>
          ) : null}
          {canManage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setResetUser({ id: user.id, username: user.username })}>
                <KeyRound className="size-4" />
                Reset password
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void handleToggleStatus(user)}
                className={enabled ? 'text-destructive focus:text-destructive' : undefined}
              >
                {enabled ? <PowerOff className="size-4" /> : <Power className="size-4" />}
                {enabled ? 'Disable' : 'Enable'}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const columns = useMemo<ColumnDef<User>[]>(
    () => [
      {
        accessorKey: 'username',
        header: 'Member',
        enableHiding: false,
        meta: { label: 'Member' },
        cell: ({ row }) => (
          <button type="button" className="flex items-center gap-2.5 text-left" onClick={() => openDetail(row.original.id)}>
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">{initialsOf(row.original.username)}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium hover:underline">{row.original.username}</span>
              <span className="truncate text-xs text-muted-foreground">{row.original.email || '—'}</span>
            </span>
          </button>
        ),
      },
      {
        id: 'roleId',
        accessorFn: (u) => rolesOf(u)[0] ?? '',
        header: 'Role',
        enableSorting: false,
        meta: { label: 'Role', variant: 'multiSelect', options: roleOptions },
        cell: ({ row }) => {
          const rs = rolesOf(row.original);
          return rs.length ? (
            <span className="flex flex-wrap gap-1">
              {rs.map((r) => (
                <StatusBadge key={r} label={r} colorRole="primary" />
              ))}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          );
        },
      },
      {
        id: 'departmentId',
        accessorFn: (u) => (u.departmentIds ?? []).join(','),
        header: 'Departments',
        enableSorting: false,
        meta: { label: 'Department', variant: 'multiSelect', options: deptFacetOptions },
        cell: ({ row }) => {
          const names = (row.original.departmentIds ?? []).map((id) => deptNameById.get(id)).filter(Boolean) as string[];
          return <span className="truncate text-sm text-muted-foreground">{names.length ? names.join(', ') : '—'}</span>;
        },
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        size: 130,
        meta: { label: 'Status', variant: 'multiSelect', options: USER_STATUS_FACET_OPTIONS },
        cell: ({ row }) => {
          const s = deriveUserStatus(row.original);
          return <StatusBadge label={s.label} colorRole={s.colorRole} />;
        },
      },
      {
        accessorKey: 'isServiceAccount',
        header: 'Type',
        size: 120,
        enableSorting: false,
        meta: { label: 'Type', variant: 'multiSelect', options: USER_TYPE_FACET_OPTIONS },
        cell: ({ row }) => <span className="text-sm text-muted-foreground">{userTypeLabel(row.original.isServiceAccount)}</span>,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        enableHiding: false,
        size: 56,
        cell: ({ row }) => renderUserActions(row.original),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deptNameById, roleOptions, deptFacetOptions, canManage, superAdmin, authUserId],
  );

  // ── Create ──────────────────────────────────────────────────────────────
  const handleCreate = async (draft: CreateUserDraft) => {
    setIsSaving(true);
    try {
      const created = await create(toCreateUserInput(draft));
      if (draft.roleId) await assignRoleToUser(created.id, draft.roleId).catch(() => toast.error('User created, but role assignment failed'));
      if (draft.departmentIds.length)
        await assignDepartments(created.id, { departmentIds: draft.departmentIds, primaryDepartmentId: draft.departmentIds[0] }).catch(() =>
          toast.error('User created, but department assignment failed'),
        );
      toast.success('User created');
      setCreateOpen(false);
      fetchPage();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setIsSaving(false);
    }
  };

  // ── Export ──────────────────────────────────────────────────────────────
  /** Client CSV of a specific in-memory set — used for the bulk-selected rows. */
  const exportRows = (users: User[], prefix: string) => {
    if (users.length === 0) {
      toast.error('Nothing to export');
      return;
    }
    downloadTextFile(timestampedCsvName(prefix), toUserCsv(users, deptNameById));
    toast.success(`Exported ${users.length} user${users.length === 1 ? '' : 's'}`);
  };

  /** Server export (csv | xlsx | pdf) of the full filtered set — TASK-388 #10. */
  const handleServerExport = async (format: UserExportFormat) => {
    try {
      const blob = await exportUsers({
        format,
        search: query.search,
        filters: query.filters,
        sort: query.sort,
        searchFields: query.searchFields,
      });
      downloadBlob(timestampedExportName('users', exportExtension(format)), blob);
      toast.success(`Export ready (${format.toUpperCase()})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed');
    }
  };

  // ── Bulk ops (server-side, TASK-388 #9) ───────────────────────────────────
  const selectedIds = useMemo(() => selectedRowIds(rowSelection), [rowSelection]);
  const selectedUsers = useMemo(() => rows.filter((u) => selectedIds.includes(u.id)), [rows, selectedIds]);

  /** One server round-trip for enable/disable/delete; reports per-item results. */
  const runBulkAction = async (action: BulkUserActionType) => {
    if (selectedIds.length === 0) return;
    setIsBulkBusy(true);
    try {
      const res = await bulkAction({ action, ids: selectedIds });
      if (res.failed === 0) toast.success(`${res.succeeded} user${res.succeeded === 1 ? '' : 's'} ${BULK_LABELS[action]}`);
      else toast.error(`${res.failed} of ${res.total} could not be ${BULK_LABELS[action]}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Bulk action failed');
    } finally {
      setIsBulkBusy(false);
      dispatchSelection({ type: 'clear' });
      fetchPage();
    }
  };

  /** TASK-398 P1-6 — one server round-trip assigning a role to every selected id. */
  const handleAssignRoleConfirm = async (roleId: string) => {
    if (!assignRoleIds || assignRoleIds.length === 0) return;
    const ids = assignRoleIds;
    setIsSaving(true);
    try {
      const res = await bulkAction({ action: 'assign-role', ids, roleId });
      if (res.failed === 0) toast.success(`Role assigned to ${res.succeeded} user${res.succeeded === 1 ? '' : 's'}`);
      else toast.error(`${res.failed} of ${res.total} could not be ${BULK_LABELS['assign-role']}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign role');
    } finally {
      setIsSaving(false);
      setAssignRoleIds(null);
      dispatchSelection({ type: 'clear' });
      fetchPage();
    }
  };

  const handleAssignConfirm = async (deptIds: string[]) => {
    if (!assignTarget) return;
    const target = assignTarget;
    setIsSaving(true);
    try {
      if (target.kind === 'user') {
        const currentPrimary = target.user.primaryDepartmentId;
        const primaryDepartmentId = currentPrimary && deptIds.includes(currentPrimary) ? currentPrimary : deptIds[0];
        await assignDepartments(target.user.id, { departmentIds: deptIds, primaryDepartmentId });
        toast.success('Departments updated');
      } else {
        const res = await bulkAction({
          action: 'assign-departments',
          ids: target.ids,
          departmentIds: deptIds,
          primaryDepartmentId: deptIds[0],
        });
        if (res.failed === 0) toast.success(`Departments updated for ${res.succeeded} user${res.succeeded === 1 ? '' : 's'}`);
        else toast.error(`${res.failed} of ${res.total} could not be updated`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to assign departments');
    } finally {
      setIsSaving(false);
      setAssignTarget(null);
      if (target.kind === 'bulk') dispatchSelection({ type: 'clear' });
      fetchPage();
    }
  };

  const count = selectionCount(rowSelection);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              <Download className="size-4" />
              Export
              <ChevronDown className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void handleServerExport('csv')}>Export as CSV</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleServerExport('xlsx')}>Export as Excel</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void handleServerExport('pdf')}>Export as PDF</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {canManage ? (
          <Button className="max-md:hidden" onClick={() => setCreateOpen(true)}>
            <UserPlus className="size-4" />
            New user
          </Button>
        ) : null}
      </div>

      <ResponsiveDataGrid<User>
        aria-label="Tenant users"
        data={rows}
        columns={columns}
        getRowId={(u) => u.id}
        manual={{ pagination: true, filtering: true }}
        rowCount={total}
        queryState={queryState}
        onQueryStateChange={onQueryStateChange}
        features={{ sorting: false, globalSearch: true, facetedFilters: true, columnVisibility: true, rowSelection: canManage }}
        selection={canManage ? { value: rowSelection, onChange: (s) => dispatchSelection({ type: 'set', value: s }) } : undefined}
        isLoading={isLoading && rows.length === 0}
        error={error ?? undefined}
        onRetry={fetchPage}
        height={520}
        pageSizeOptions={[10, 20, 50]}
        persistence={{ key: 'tenant-users', namespace: GRID_LAYOUT_NAMESPACE, adapter }}
        condensedColumnIds={['username', 'roleId', 'resourceStatus', 'actions']}
        mobileSearchPlaceholder="Search members…"
        mobilePrimaryAction={canManage ? { label: 'New user', icon: <UserPlus className="size-6" />, onClick: () => setCreateOpen(true) } : undefined}
        mobileCard={(u) => {
          const s = deriveUserStatus(u);
          const roles = rolesOf(u);
          return {
            id: u.id,
            avatar: (
              <Avatar className="size-10">
                <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initialsOf(u.username)}</AvatarFallback>
              </Avatar>
            ),
            title: u.username,
            subtitle: u.email || '—',
            meta: roles.length ? roles.join(', ') : undefined,
            badge: <StatusBadge label={s.label} colorRole={s.colorRole} />,
            onClick: () => openDetail(u.id),
            actions: renderUserActions(u),
          };
        }}
        actionBar={
          canManage ? (
            <UsersBulkBar
              count={count}
              canManage={canManage}
              isBusy={isBulkBusy}
              onEnable={() => void runBulkAction('enable')}
              onDisable={() => void runBulkAction('disable')}
              onDelete={() => runBulkAction('delete')}
              onAssignDepartment={() => setAssignTarget({ kind: 'bulk', ids: selectedIds })}
              onAssignRole={() => setAssignRoleIds(selectedIds)}
              onExportCsv={() => exportRows(selectedUsers, 'users-selected')}
              onClear={() => dispatchSelection({ type: 'clear' })}
            />
          ) : undefined
        }
      />

      {superAdmin && tenant ? (
        <ActingOnBanner
          tenantName={tenant.name}
          description="Full read-write on this tenant’s users — create, reset-password, bulk enable/disable/delete/assign-departments, manage agent instructions. CSV/Excel/PDF export and the audit trail are live. A tenant-admin sees the same grid scoped to their tenant; the System tenant is protected."
        />
      ) : null}

      <UserCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        roles={roleList.map((r) => ({ id: r.id, name: r.name }))}
        departments={departments.map((d) => ({ id: d.id, name: d.name }))}
        isSaving={isSaving}
        onSave={handleCreate}
      />

      <ResetPasswordDialog open={!!resetUser} onOpenChange={(o) => !o && setResetUser(null)} user={resetUser} />

      <ImpersonateDialog
        open={!!impersonateUser}
        onOpenChange={(o) => !o && setImpersonateUser(null)}
        user={impersonateUser}
        returnTo={impersonateUser ? `/tenants/${tenantId}/users/${impersonateUser.id}` : `/tenants/${tenantId}/users`}
      />

      <CheckboxPickerDialog
        open={!!assignTarget}
        onOpenChange={(o) => !o && setAssignTarget(null)}
        title="Assign departments"
        subtitle={
          assignTarget?.kind === 'user' ? assignTarget.user.username : assignTarget?.kind === 'bulk' ? `${assignTarget.ids.length} users` : undefined
        }
        searchPlaceholder="Filter departments…"
        options={deptPickerOptions}
        initialSelected={assignTarget?.kind === 'user' ? (assignTarget.user.departmentIds ?? []) : []}
        confirmLabel={() => 'Save assignments'}
        emptyLabel="No departments yet."
        isSaving={isSaving}
        onConfirm={handleAssignConfirm}
      />

      <AssignRoleDialog
        open={!!assignRoleIds}
        onOpenChange={(o) => !o && setAssignRoleIds(null)}
        subtitle={assignRoleIds ? `${assignRoleIds.length} user${assignRoleIds.length === 1 ? '' : 's'} selected` : undefined}
        roles={roleList.map((r) => ({ id: r.id, name: r.name, description: r.description }))}
        isSaving={isSaving}
        onConfirm={handleAssignRoleConfirm}
      />
    </div>
  );
}
