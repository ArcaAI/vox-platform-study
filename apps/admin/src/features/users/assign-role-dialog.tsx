import { Avatar, AvatarFallback } from '@arcaai/ui/avatar';
import { Button } from '@arcaai/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Input } from '@arcaai/ui/input';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/radio-group';
import { ScrollArea } from '@arcaai/ui/scroll-area';
import { Spinner } from '@arcaai/ui/spinner';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER_DEEP } from '@/lib/responsive';
import { cn, initialsOf } from '@/lib/utils';

export interface RoleOption {
  id: string;
  name: string;
  description?: string;
}

/**
 * TASK-398 P1-6 — single-select role picker for the bulk **Assign role** action.
 * Mirrors the `CheckboxPickerDialog` shell (search + rows + footer) used by
 * assign-departments, but a role assignment is one-role-per-confirm, so rows are
 * a radio group. Purely presentational: the caller supplies options and owns the
 * `bulkAction({ action: 'assign-role' })` mutation.
 */
export function AssignRoleDialog({
  open,
  onOpenChange,
  subtitle,
  roles,
  isSaving,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subtitle?: string;
  roles: RoleOption[];
  isSaving: boolean;
  onConfirm: (roleId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((r) => r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
  }, [roles, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-md', MOBILE_DIALOG_CONTENT)}>
        <DialogHeader>
          <DialogTitle>Assign role</DialogTitle>
          {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter roles…" className="pl-8" aria-label="Filter roles…" />
          </div>
          <ScrollArea className="h-64 rounded-md border">
            {filtered.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">No roles found.</p>
            ) : (
              <RadioGroup value={selected} onValueChange={setSelected} className="gap-0 divide-y">
                {filtered.map((role) => (
                  <label key={role.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent/40">
                    <RadioGroupItem value={role.id} aria-label={role.name} />
                    <Avatar className="size-7">
                      <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">{initialsOf(role.name)}</AvatarFallback>
                    </Avatar>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium text-foreground">{role.name}</span>
                      {role.description ? <span className="truncate text-xs text-muted-foreground">{role.description}</span> : null}
                    </span>
                  </label>
                ))}
              </RadioGroup>
            )}
          </ScrollArea>
        </div>
        <DialogFooter className={cn('sm:items-center sm:justify-between', MOBILE_DIALOG_FOOTER_DEEP)}>
          <span className="text-sm text-muted-foreground">{selected ? '1 role selected' : 'Select a role'}</span>
          <div className="flex gap-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="button" disabled={!selected || isSaving} onClick={() => onConfirm(selected)}>
              {isSaving ? <Spinner className="size-4" /> : 'Assign role'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
