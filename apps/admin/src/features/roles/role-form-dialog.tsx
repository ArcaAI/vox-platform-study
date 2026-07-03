import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Spinner } from '@arcaai/ui/spinner';
import { Textarea } from '@arcaai/ui/textarea';
import type { Role } from '@arcaai/vox';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';

const NO_PARENT = '__none__';

export interface RoleFormInput {
  name: string;
  description?: string;
  /** `null` clears the parent (edit); `undefined` omits it (create). */
  parentRoleId?: string | null;
}

/**
 * Create/edit role dialog (TASK-374). `updateRole`/`createRole` are SDK
 * `useRoles()` methods. The parent role select excludes the role being edited
 * (a role cannot be its own parent).
 */
export function RoleFormDialog({
  mode,
  initial,
  roles,
  open,
  onOpenChange,
  trigger,
  onSave,
}: {
  mode: 'create' | 'edit';
  initial?: Role | null;
  roles: Role[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  onSave: (input: RoleFormInput) => Promise<void>;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;

  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parent, setParent] = useState(NO_PARENT);

  useEffect(() => {
    if (!isOpen) return;
    setName(initial?.name ?? '');
    setDescription(initial?.description ?? '');
    setParent(initial?.parentRoleId ?? NO_PARENT);
  }, [isOpen, initial]);

  const parentOptions = roles.filter((r) => r.id !== initial?.id);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || undefined,
        // edit clears with null; create omits with undefined.
        parentRoleId: parent === NO_PARENT ? (mode === 'edit' ? null : undefined) : parent,
      });
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className={MOBILE_DIALOG_CONTENT}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? 'New role' : 'Edit role'}</DialogTitle>
            <DialogDescription>Roles group policies and can inherit from a parent role.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-name">Name</Label>
              <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-desc">Description</Label>
              <Textarea id="role-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role-parent">Parent role</Label>
              <Select value={parent} onValueChange={setParent}>
                <SelectTrigger id="role-parent">
                  <SelectValue placeholder="No parent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT}>No parent</SelectItem>
                  {parentOptions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? <Spinner className="size-4" /> : mode === 'create' ? 'Create role' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
