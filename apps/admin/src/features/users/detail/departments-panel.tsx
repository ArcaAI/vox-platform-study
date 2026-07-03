import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { useUserDepartments, type UserDepartmentAssignment } from '@arcaai/vox';
import { FolderPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckboxPickerDialog, type PickerOption } from '@/features/common/checkbox-picker-dialog';
import { reduceOccConflict } from '@/features/common/occ';
import { formatDateTime } from '@/lib/utils';

const EM_DASH = '—';

/**
 * 38u **Department assignment** tab — REAL `useUserDepartments` list / assign /
 * setPrimary (OCC `If-Match`) / unassign. The per-assignment "Assigned" date is
 * not modeled on `UserDepartmentAssignment`, so it degrades to an em-dash. The
 * primary assignment can't be removed (promote another first).
 */
export function DepartmentsPanel({
  userId,
  departments,
  canManage,
}: {
  userId: string;
  departments: { id: string; name: string }[];
  canManage: boolean;
}) {
  const { assignments, list, assign, setPrimary, unassign } = useUserDepartments();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const nameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);

  const load = () => {
    setLoading(true);
    setError(null);
    list(userId)
      .then(() => undefined)
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const assignedIds = useMemo(() => assignments.map((a) => a.departmentId), [assignments]);
  const options = useMemo<PickerOption[]>(() => departments.map((d) => ({ id: d.id, primary: d.name })), [departments]);

  const handleAssign = async (selectedIds: string[]) => {
    const added = selectedIds.filter((id) => !assignedIds.includes(id));
    if (added.length === 0) {
      setAssignOpen(false);
      return;
    }
    setIsSaving(true);
    const results = await Promise.allSettled(added.map((departmentId) => assign(userId, { departmentId })));
    const failed = results.filter((r) => r.status === 'rejected').length;
    setIsSaving(false);
    setAssignOpen(false);
    if (failed === 0) toast.success(`Assigned ${added.length} department${added.length === 1 ? '' : 's'}`);
    else toast.error(`${failed} of ${added.length} could not be assigned`);
    load();
  };

  const handleMakePrimary = async (a: UserDepartmentAssignment) => {
    setBusyId(a.id);
    try {
      await setPrimary(userId, a.id, true, a.version);
      toast.success('Primary department updated');
      load();
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message);
        load();
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to set primary');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (a: UserDepartmentAssignment) => {
    setBusyId(a.id);
    try {
      await unassign(userId, a.id);
      toast.success('Department removed');
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove department');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Department assignment</h2>
          <p className="text-sm text-muted-foreground">
            Departments this user belongs to. Assignments drive personalized agent instructions and access.
          </p>
        </div>
        {canManage ? (
          <Button onClick={() => setAssignOpen(true)}>
            <FolderPlus className="size-4" />
            Assign department
          </Button>
        ) : null}
      </div>

      <Card className="p-0">
        {loading && assignments.length === 0 ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load department assignments.</p>
            <Button variant="outline" size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        ) : assignments.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">This user isn’t assigned to any department yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Assigned</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments.map((a) => {
                const assignedAt = typeof a.createdAt === 'string' ? a.createdAt : undefined;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">
                      {nameById.get(a.departmentId) ?? <span className="font-mono text-xs">{a.departmentId}</span>}
                    </TableCell>
                    <TableCell>
                      {a.isPrimary ? <StatusBadge label="Primary" colorRole="info" /> : <span className="text-sm text-muted-foreground">Member</span>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{assignedAt ? formatDateTime(assignedAt) : EM_DASH}</TableCell>
                    <TableCell className="text-right">
                      {canManage ? (
                        <div className="flex justify-end gap-3">
                          {!a.isPrimary ? (
                            <button
                              type="button"
                              className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
                              disabled={busyId === a.id}
                              onClick={() => void handleMakePrimary(a)}
                            >
                              Make primary
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="text-sm font-medium text-destructive hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline"
                            disabled={a.isPrimary || busyId === a.id}
                            title={a.isPrimary ? 'Promote another department first' : undefined}
                            onClick={() => void handleRemove(a)}
                          >
                            Remove
                          </button>
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">{EM_DASH}</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">Removing a department also unlinks this user’s personalized agent instructions for it.</p>

      <CheckboxPickerDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        title="Assign departments"
        searchPlaceholder="Filter departments…"
        options={options}
        initialSelected={assignedIds}
        confirmLabel={() => 'Save assignments'}
        emptyLabel="No departments yet."
        isSaving={isSaving}
        onConfirm={handleAssign}
      />
    </div>
  );
}
