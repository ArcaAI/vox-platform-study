'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useCreateDepartment, useDeleteDepartment, useDepartment, useUpdateDepartment } from '../api/hooks';
import type { Department, UpdateDepartmentRequest } from '../api/types';

/** Radix Select reserves '', so "no parent" maps through a sentinel. */
const ROOT_SENTINEL = '__root__';

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

function Field({ id, label, hint, required, children }: { id: string; label: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden className="text-destructive">
            {' '}
            *
          </span>
        ) : null}
      </Label>
      {children}
      {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

/**
 * A parent must not be the department itself or anything below it — the gateway
 * only rejects direct self-parenting, so the deeper-cycle guard is client-side,
 * derived from the flat list's parentDepartmentId edges.
 */
function descendantIds(departments: Department[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const department of departments) {
    if (!department.parentDepartmentId) continue;
    const siblings = childrenByParent.get(department.parentDepartmentId) ?? [];
    siblings.push(department.id);
    childrenByParent.set(department.parentDepartmentId, siblings);
  }
  const collected = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    for (const childId of childrenByParent.get(current) ?? []) {
      if (collected.has(childId)) continue;
      collected.add(childId);
      queue.push(childId);
    }
  }
  return collected;
}

interface EditFormValues {
  name: string;
  code: string;
  description: string;
  parent: string;
  status: 'ENABLED' | 'DISABLED';
}

function toEditValues(department: Department): EditFormValues {
  return {
    name: department.name ?? '',
    code: department.code ?? '',
    description: department.description ?? '',
    parent: department.parentDepartmentId ?? ROOT_SENTINEL,
    status: department.resourceStatus === 'DISABLED' ? 'DISABLED' : 'ENABLED',
  };
}

/** Only fields that drifted from the loaded row go on the wire (a no-change PATCH 400s). */
function toUpdatePatch(values: EditFormValues, department: Department): UpdateDepartmentRequest {
  const patch: UpdateDepartmentRequest = {};
  if (values.name.trim() !== (department.name ?? '')) patch.name = values.name.trim();
  if (values.code.trim() !== (department.code ?? '')) patch.code = values.code.trim();
  if (values.description.trim() !== (department.description ?? '')) patch.description = values.description.trim();
  const currentParent = department.parentDepartmentId ?? ROOT_SENTINEL;
  if (values.parent !== currentParent) patch.parentDepartmentId = values.parent === ROOT_SENTINEL ? null : values.parent;
  const currentStatus = department.resourceStatus === 'DISABLED' ? 'DISABLED' : 'ENABLED';
  if (values.status !== currentStatus) patch.resourceStatus = values.status;
  return patch;
}

function ParentSelect({ id, value, onChange, options }: { id: string; value: string; onChange: (value: string) => void; options: Department[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ROOT_SENTINEL}>
          {'—'} Root (no parent) {'—'}
        </SelectItem>
        {options.map((candidate) => (
          <SelectItem key={candidate.id} value={candidate.id}>
            {candidate.name || candidate.code || candidate.id}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function EditForm({
  department,
  etag,
  departments,
  onReloadLatest,
}: {
  department: Department;
  etag: string;
  departments: Department[];
  onReloadLatest: () => void;
}) {
  const uid = useId();
  const update = useUpdateDepartment();
  const [values, setValues] = useState<EditFormValues>(() => toEditValues(department));

  const excludedParents = descendantIds(departments, department.id);
  const parentOptions = departments.filter((candidate) => !excludedParents.has(candidate.id));
  const patch = toUpdatePatch(values, department);
  const dirty = Object.keys(patch).length > 0;

  function set<K extends keyof EditFormValues>(key: K, value: EditFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function handleReloadLatest() {
    update.reset();
    onReloadLatest();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    update.mutate(
      { id: department.id, patch, etag },
      {
        onSuccess: () => toast.success('Department updated'),
        onError: (error) => {
          if (!isOccError(error)) toast.error(error instanceof GatewayError ? error.message : 'Could not update the department.');
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <OccConflictAlert error={update.error} onReload={handleReloadLatest} />
      <Field id={`${uid}-name`} label="Name">
        <Input id={`${uid}-name`} value={values.name} onChange={(event) => set('name', event.target.value)} />
      </Field>
      <Field id={`${uid}-code`} label="Code" hint="Unique per tenant.">
        <Input id={`${uid}-code`} value={values.code} onChange={(event) => set('code', event.target.value)} className="font-mono" />
      </Field>
      <Field id={`${uid}-description`} label="Description">
        <Textarea
          id={`${uid}-description`}
          value={values.description}
          onChange={(event) => set('description', event.target.value)}
          rows={2}
          className="resize-none"
        />
      </Field>
      <Field id={`${uid}-parent`} label="Parent">
        <ParentSelect id={`${uid}-parent`} value={values.parent} onChange={(next) => set('parent', next)} options={parentOptions} />
      </Field>
      <Field id={`${uid}-status`} label="Status">
        <Select value={values.status} onValueChange={(next) => set('status', next as EditFormValues['status'])}>
          <SelectTrigger id={`${uid}-status`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ENABLED">Active</SelectItem>
            <SelectItem value="DISABLED">Disabled</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="flex items-center justify-between gap-2">
        <p aria-hidden className="text-muted-foreground font-mono text-xs">
          v{department.version} {'·'} If-Match on save
        </p>
        <Button type="submit" size="sm" disabled={!dirty || update.isPending}>
          {update.isPending ? <Spinner /> : null}
          Save changes
        </Button>
      </div>
    </form>
  );
}

function CreateForm({
  departments,
  onCreated,
  onCancel,
}: {
  departments: Department[];
  onCreated: (department: Department) => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const create = useCreateDepartment();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [description, setDescription] = useState('');
  const [parent, setParent] = useState(ROOT_SENTINEL);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        ...(code.trim() ? { code: code.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(parent !== ROOT_SENTINEL ? { parentDepartmentId: parent } : {}),
      },
      {
        onSuccess: (created) => {
          toast.success('Department created');
          onCreated(created);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not create the department.'),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <Field id={`${uid}-name`} label="Name" required>
        <Input id={`${uid}-name`} value={name} onChange={(event) => setName(event.target.value)} placeholder="Cardiology" required />
      </Field>
      <Field id={`${uid}-code`} label="Code" hint="Unique per tenant; used for the code lookup.">
        <Input
          id={`${uid}-code`}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="CARD"
          className="font-mono"
          autoComplete="off"
        />
      </Field>
      <Field id={`${uid}-description`} label="Description">
        <Textarea
          id={`${uid}-description`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={2}
          className="resize-none"
        />
      </Field>
      <Field id={`${uid}-parent`} label="Parent">
        <ParentSelect id={`${uid}-parent`} value={parent} onChange={setParent} options={departments} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          {create.isPending ? <Spinner /> : null}
          Create department
        </Button>
      </div>
    </form>
  );
}

/** Skeleton mirroring the edit form (rule 10). */
function EditSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Frame 30 — the console-wide DetailDrawer for department create AND edit
 * (redesign build spec; retires the inline edit panel and the create dialog).
 * Create mode shows a single form; edit mode shows the If-Match form with the
 * type-to-confirm delete pinned in the footer. The prompt config is its own pane
 * (department-prompt-config-panel), not part of this drawer.
 */
export function DepartmentDetailDrawer({
  departmentId,
  creating,
  departments,
  onOpenChange,
  onCreated,
  onDeleted,
}: {
  departmentId: string | null;
  creating: boolean;
  departments: Department[];
  onOpenChange: (open: boolean) => void;
  onCreated: (department: Department) => void;
  onDeleted: () => void;
}) {
  const open = creating || departmentId !== null;
  const detail = useDepartment(creating ? '' : (departmentId ?? ''));
  const deleteDepartment = useDeleteDepartment();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Create mode: a single form, no detail read, no delete.
  if (creating) {
    return (
      <DetailDrawer open={open} onOpenChange={onOpenChange} size="md" title="New department">
        <CreateForm departments={departments} onCreated={onCreated} onCancel={() => onOpenChange(false)} />
      </DetailDrawer>
    );
  }

  const department = detail.data?.data ?? null;
  const title = department ? `Edit: ${department.name || department.code || department.id}` : 'Edit';
  const confirmToken = department ? department.code || department.name || department.id : '';

  function handleDeleteConfirmed() {
    if (!department) return;
    deleteDepartment.mutate(department.id, {
      onSuccess: () => {
        toast.success('Department deleted');
        setConfirmingDelete(false);
        onDeleted();
      },
      onError: (error) => {
        // 400 carries the "has children" guidance from the gateway.
        toast.error(error instanceof GatewayError ? error.message : 'Could not delete the department.');
        setConfirmingDelete(false);
      },
    });
  }

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={title}
      meta={
        <span aria-hidden className="font-mono">
          PATCH :id (If-Match)
        </span>
      }
      footer={
        department ? (
          <Button variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
            <IconTrash aria-hidden />
            Delete
          </Button>
        ) : null
      }
    >
      {!open ? null : detail.isPending ? (
        <EditSkeleton />
      ) : detail.error || !department ? (
        <ErrorState
          error={detail.error ?? new GatewayError(404, 'This department does not exist or is outside your tenant scope.')}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <EditForm
          key={department.id}
          department={department}
          etag={detail.data?.etag ?? ''}
          departments={departments}
          onReloadLatest={() => void detail.refetch()}
        />
      )}
      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={(next) => !next && setConfirmingDelete(false)}
        title="Delete department?"
        description={
          department
            ? `This soft-deletes ${department.name || department.code || department.id}. Departments with sub-departments cannot be deleted — reassign the children first.`
            : ''
        }
        confirmLabel="Delete department"
        destructive
        typeToConfirm={confirmToken}
        onConfirm={handleDeleteConfirmed}
        isPending={deleteDepartment.isPending}
      />
    </DetailDrawer>
  );
}
