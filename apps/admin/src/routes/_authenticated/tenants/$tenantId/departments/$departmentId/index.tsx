import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { VirtualizedDataGrid } from '@arcaai/ui/components/data-grid';
import { useDepartments, useUsers, useUserDepartments, type User } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { DepartmentDetailShell } from '@/features/agents/department-shell';
import { useDepartmentScope } from '@/features/agents/use-department-scope';
import { CheckboxPickerDialog, type PickerOption } from '@/features/common/checkbox-picker-dialog';
import { resourceStatusLabel, resourceStatusRole } from '@/features/data-grid/status';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { initialsOf } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/departments/$departmentId/')({
  component: DepartmentMembersPage,
});

/** One server page of members; the reverse listing is paginated but returns no total (SDK narrows it). */
const MEMBER_PAGE_LIMIT = 100;
/** Tenant user page used only to populate the "Add members" candidate picker. */
const CANDIDATE_POOL_LIMIT = 100;

function DepartmentMembersPage() {
  const { tenantId, departmentId } = Route.useParams();
  const { department, tenant, superAdmin, canManage } = useDepartmentScope();

  const { listPaginated } = useUsers();
  const { getUsers } = useDepartments();
  const { assign } = useUserDepartments();

  const [members, setMembers] = useState<User[]>([]);
  const [candidatePool, setCandidatePool] = useState<User[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<Error | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const loadMembers = () => {
    setMembersLoading(true);
    setMembersError(null);
    // Server-authoritative membership (TASK-387 #6 / D2) — replaces the prior
    // client-side filter of the tenant user page. Rows are full user records at
    // runtime (the endpoint maps UserResponse); the SDK narrows the static type.
    getUsers(departmentId, { page: 1, limit: MEMBER_PAGE_LIMIT })
      .then((rows) => setMembers(rows as unknown as User[]))
      .catch((e) => setMembersError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setMembersLoading(false));
  };

  useEffect(() => {
    loadMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const candidates = useMemo<PickerOption[]>(
    () => candidatePool.filter((u) => !memberIds.has(u.id)).map((u) => ({ id: u.id, primary: u.username, secondary: u.email })),
    [candidatePool, memberIds],
  );

  // Lazy-load the tenant user pool the first time the picker opens (only needed to add members).
  const openAddMembers = () => {
    setAddOpen(true);
    if (candidatePool.length === 0) {
      listPaginated({ page: 1, limit: CANDIDATE_POOL_LIMIT })
        .then((res) => setCandidatePool(res.data))
        .catch(() => undefined);
    }
  };

  const memberColumns = useMemo<ColumnDef<User>[]>(
    () => [
      {
        accessorKey: 'username',
        header: 'Member',
        meta: { label: 'Member' },
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5">
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">{initialsOf(row.original.username)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{row.original.username}</span>
              <span className="truncate text-xs text-muted-foreground">{row.original.email || '—'}</span>
            </div>
          </div>
        ),
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        size: 130,
        cell: ({ getValue }) => {
          const s = getValue() as string | undefined;
          return <StatusBadge label={resourceStatusLabel(s)} colorRole={resourceStatusRole(s)} />;
        },
      },
      {
        id: 'primary',
        header: 'Primary dept',
        enableSorting: false,
        size: 130,
        cell: ({ row }) =>
          row.original.primaryDepartmentId === departmentId ? (
            <StatusBadge label="Primary" colorRole="info" />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          ),
      },
    ],
    [departmentId],
  );

  const handleAddMembers = async (userIds: string[]) => {
    setIsSaving(true);
    const results = await Promise.allSettled(userIds.map((userId) => assign(userId, { departmentId })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setIsSaving(false);
    if (failed === 0) toast.success(`Added ${userIds.length} member${userIds.length === 1 ? '' : 's'}`);
    else toast.error(`${failed} of ${userIds.length} could not be added`);
    setAddOpen(false);
    loadMembers();
  };

  if (!department) return null;

  return (
    <DepartmentDetailShell
      department={department}
      tenant={tenant}
      tenantId={tenantId}
      departmentId={departmentId}
      active="members"
      actions={
        canManage ? (
          <Button onClick={openAddMembers}>
            <UserPlus className="size-4" />
            Add members
          </Button>
        ) : null
      }
    >
      <div className="space-y-2">
        <VirtualizedDataGrid<User>
          aria-label="Department members"
          data={members}
          columns={memberColumns}
          getRowId={(u) => u.id}
          features={{ sorting: true, globalSearch: true, rowSelection: false }}
          isLoading={membersLoading && members.length === 0}
          error={membersError ?? undefined}
          onRetry={loadMembers}
          height={480}
          pageSizeOptions={[10, 20, 50]}
        />
        {/* Role-within-department and join date aren't modeled yet (UserDepartment carries isPrimary only). */}
        <p className="text-xs text-muted-foreground">
          Members are read directly from this department (first {MEMBER_PAGE_LIMIT}); role-in-department and join date are not yet modeled.
        </p>
      </div>

      {superAdmin && tenant ? (
        <ActingOnBanner
          tenantName={`${department.name} · ${tenant.name}`}
          description="Members are UserDepartment links. Add members assigns the selected tenant users to this department."
        />
      ) : null}

      <CheckboxPickerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add members"
        subtitle={tenant?.name ? `${department.name} · ${tenant.name}` : department.name}
        searchPlaceholder="Search people to add…"
        options={candidates}
        confirmLabel={(n) => `Add ${n} member${n === 1 ? '' : 's'}`}
        emptyLabel="Everyone is already a member."
        isSaving={isSaving}
        onConfirm={handleAddMembers}
      />
    </DepartmentDetailShell>
  );
}
