import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/toggle-group';
import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn } from '@/lib/utils';
import { CheckboxPickerDialog, type PickerOption } from '@/features/common/checkbox-picker-dialog';
import {
  EMPTY_CREATE_USER_DRAFT,
  isCreateUserValid,
  suggestUsername,
  validateCreateUserDraft,
  type CreateUserDraft,
} from '@/features/users/user-draft';

export interface CreateUserRole {
  id: string;
  name: string;
}

export interface CreateUserDepartment {
  id: string;
  name: string;
}

/**
 * Create-User dialog (frame `120:10354`). Composes {@link CreateUserDraft} +
 * inline validation. The dialog is presentational — the caller wires the REAL
 * `useUsers.create` → `assignRoleToUser` → `assignDepartments` pipeline in
 * `onSave`. The **Invited** status (email-invite, no password) is a TARGET: it
 * leaves the temp password blank and is flagged inline; **Active** takes a REAL
 * temporary password.
 */
export function UserCreateDialog({
  open,
  onOpenChange,
  roles,
  departments,
  isSaving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: CreateUserRole[];
  departments: CreateUserDepartment[];
  isSaving: boolean;
  onSave: (draft: CreateUserDraft) => void;
}) {
  const [draft, setDraft] = useState<CreateUserDraft>(EMPTY_CREATE_USER_DRAFT);
  const [status, setStatus] = useState<'invited' | 'active'>('invited');
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [touched, setTouched] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_CREATE_USER_DRAFT);
    setStatus('invited');
    setUsernameEdited(false);
    setTouched(false);
  }, [open]);

  const errors = useMemo(() => validateCreateUserDraft(draft), [draft]);
  const canSave = isCreateUserValid(draft) && !isSaving;

  const deptNameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);
  const deptOptions = useMemo<PickerOption[]>(() => departments.map((d) => ({ id: d.id, primary: d.name })), [departments]);

  const onFullName = (value: string) => {
    setDraft((d) => ({ ...d, fullName: value, username: usernameEdited ? d.username : suggestUsername(value) }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSave) return;
    onSave(draft);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-lg', MOBILE_DIALOG_CONTENT)}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Create user</DialogTitle>
            <DialogDescription>Add a clinician to HOPE. They’ll receive an email invite to set their password.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-fullname">Full name</Label>
                <Input
                  id="cu-fullname"
                  value={draft.fullName}
                  onChange={(e) => onFullName(e.target.value)}
                  placeholder="e.g. Dr. Maya Chen"
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-role">Role</Label>
                <Select value={draft.roleId ?? ''} onValueChange={(v) => setDraft((d) => ({ ...d, roleId: v || undefined }))}>
                  <SelectTrigger id="cu-role">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-email">Email{draft.isServiceAccount ? '' : ' *'}</Label>
                <Input
                  id="cu-email"
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                  placeholder="name@acmehealth.org"
                  aria-invalid={touched && !!errors.email}
                />
                {touched && errors.email ? <span className="text-xs text-destructive">{errors.email}</span> : null}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cu-username">Username</Label>
                <Input
                  id="cu-username"
                  value={draft.username}
                  onChange={(e) => {
                    setUsernameEdited(true);
                    setDraft((d) => ({ ...d, username: e.target.value }));
                  }}
                  placeholder="maya.chen"
                  aria-invalid={touched && !!errors.username}
                />
                <span className="text-xs text-muted-foreground">
                  {touched && errors.username ? <span className="text-destructive">{errors.username}</span> : 'Auto-suggested from the name'}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Departments</Label>
              <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2">
                {draft.departmentIds.map((id) => (
                  <Badge key={id} variant="secondary" className="gap-1">
                    {deptNameById.get(id) ?? id}
                    <button
                      type="button"
                      aria-label={`Remove ${deptNameById.get(id) ?? id}`}
                      onClick={() => setDraft((d) => ({ ...d, departmentIds: d.departmentIds.filter((x) => x !== id) }))}
                      className="rounded-full text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                <Button type="button" variant="ghost" size="sm" className="h-7 gap-1" onClick={() => setPickerOpen(true)}>
                  <Plus className="size-3.5" />
                  Add department
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
              <div className="flex flex-col gap-1.5">
                <Label>Initial status</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={status}
                  onValueChange={(v) => v && setStatus(v as 'invited' | 'active')}
                  aria-label="Initial status"
                >
                  <ToggleGroupItem value="invited">Invited</ToggleGroupItem>
                  <ToggleGroupItem value="active">Active</ToggleGroupItem>
                </ToggleGroup>
              </div>
              {status === 'active' ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cu-password">Temporary password</Label>
                  <Input
                    id="cu-password"
                    type="password"
                    value={draft.password}
                    onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
                    placeholder="At least 8 characters"
                    aria-invalid={touched && !!errors.password}
                  />
                  {touched && errors.password ? <span className="text-xs text-destructive">{errors.password}</span> : null}
                </div>
              ) : (
                <p className="self-end text-xs text-muted-foreground">
                  Invited users receive an email to set their password. <span className="font-medium text-foreground">Target ·</span> email delivery
                  ships later.
                </p>
              )}
            </div>
          </div>

          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSave}>
              {isSaving ? <Spinner className="size-4" /> : 'Create user'}
            </Button>
          </DialogFooter>
        </form>

        <CheckboxPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          title="Add departments"
          searchPlaceholder="Filter departments…"
          options={deptOptions}
          initialSelected={draft.departmentIds}
          confirmLabel={(n) => `Add ${n} department${n === 1 ? '' : 's'}`}
          emptyLabel="No departments yet."
          isSaving={false}
          onConfirm={(ids) => {
            setDraft((d) => ({ ...d, departmentIds: ids }));
            setPickerOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
