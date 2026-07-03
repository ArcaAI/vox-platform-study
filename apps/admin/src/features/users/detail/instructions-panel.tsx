import { Alert, AlertDescription } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Input } from '@arcaai/ui/input';
import { Label } from '@arcaai/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { Textarea } from '@arcaai/ui/textarea';
import { usePrompts, type PromptTemplate, type User } from '@arcaai/vox';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Pencil, Plus, Sparkles, Trash2, UserRound } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { ConfirmDelete } from '@/features/common/confirm-delete';
import { reduceOccConflict } from '@/features/common/occ';
import { MOBILE_DIALOG_CONTENT, MOBILE_DIALOG_FOOTER } from '@/lib/responsive';
import { cn, formatDateTime } from '@/lib/utils';

type PromptCategory = PromptTemplate['category'];
const CATEGORY_OPTIONS: PromptCategory[] = ['CUSTOM', 'SUMMARY', 'DNA_ANALYSIS', 'SYSTEM'];

function promptStatusRole(status?: string) {
  return String(status ?? '').toUpperCase() === 'PUBLISHED' ? ('success' as const) : ('neutral' as const);
}

type DialogTarget = { mode: 'create' } | { mode: 'edit'; prompt: PromptTemplate } | null;

/** Create/edit a USER_PERSONAL prompt. Create takes name+category+content; edit patches content only (the update contract). */
function PersonalInstructionDialog({
  target,
  isSaving,
  onOpenChange,
  onSubmit,
}: {
  target: DialogTarget;
  isSaving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: { name: string; category: PromptCategory; content: string }) => void;
}) {
  const editing = target?.mode === 'edit' ? target.prompt : null;
  const [name, setName] = useState('');
  const [category, setCategory] = useState<PromptCategory>('CUSTOM');
  const [content, setContent] = useState('');

  useEffect(() => {
    if (!target) return;
    setName(editing?.name ?? '');
    setCategory(editing?.category ?? 'CUSTOM');
    setContent(editing?.content ?? '');
  }, [target, editing]);

  const canSave = name.trim().length > 0 && content.trim().length > 0 && !isSaving;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    onSubmit({ name: name.trim(), category, content: content.trim() });
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className={cn('sm:max-w-lg', MOBILE_DIALOG_CONTENT)}>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit personal instruction' : 'New personal instruction'}</DialogTitle>
            <DialogDescription>A prompt owned by this user that overrides the department default for their consultations.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pi-name">Name</Label>
                <Input
                  id="pi-name"
                  value={name}
                  disabled={!!editing}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Cardiology follow-up"
                  autoFocus={!editing}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pi-category">Category</Label>
                <Select value={category} onValueChange={(v) => setCategory(v as PromptCategory)} disabled={!!editing}>
                  <SelectTrigger id="pi-category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORY_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c.replace('_', ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pi-content">Instruction</Label>
              <Textarea
                id="pi-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={8}
                placeholder="Write the agent instruction…"
                autoFocus={!!editing}
              />
            </div>
          </div>
          <DialogFooter className={MOBILE_DIALOG_FOOTER}>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!canSave}>
              {editing ? 'Save changes' : 'Create instruction'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 38u **Agent instructions** tab (TASK-394 P0-1 · TASK-388 #12). Two REAL surfaces:
 *   - **Personal instructions** — the user's `USER_PERSONAL` prompts
 *     (`usePrompts.list({ scope: 'USER_PERSONAL', ownerUserId })`), with
 *     create / edit / delete owned by that user (`scope` + `ownerUserId` on create).
 *   - **Department defaults** — the `PromptTemplate` rows for each assigned
 *     department, applied when the user has no personal override.
 */
export function InstructionsPanel({
  user,
  departments,
  tenantId,
  canManage,
}: {
  user: User;
  departments: { id: string; name: string }[];
  tenantId: string;
  canManage: boolean;
}) {
  const { list, create, update, remove } = usePrompts();
  const [byDept, setByDept] = useState<Record<string, PromptTemplate[]>>({});
  const [loading, setLoading] = useState(true);

  const [personal, setPersonal] = useState<PromptTemplate[]>([]);
  const [personalLoading, setPersonalLoading] = useState(true);
  const [dialogTarget, setDialogTarget] = useState<DialogTarget>(null);
  const [isSaving, setIsSaving] = useState(false);

  const assignedIds = useMemo(() => user.departmentIds ?? [], [user.departmentIds]);
  const nameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments]);

  const reloadPersonal = useCallback(() => {
    setPersonalLoading(true);
    list({ scope: 'USER_PERSONAL', ownerUserId: user.id })
      .then(setPersonal)
      .catch(() => setPersonal([]))
      .finally(() => setPersonalLoading(false));
  }, [list, user.id]);

  useEffect(() => {
    reloadPersonal();
  }, [reloadPersonal]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.allSettled(assignedIds.map((departmentId) => list({ departmentId }).then((items) => [departmentId, items] as const)))
      .then((results) => {
        if (cancelled) return;
        const next: Record<string, PromptTemplate[]> = {};
        for (const r of results) if (r.status === 'fulfilled') next[r.value[0]] = r.value[1];
        setByDept(next);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(assignedIds)]);

  const handleSubmit = async (draft: { name: string; category: PromptCategory; content: string }) => {
    setIsSaving(true);
    try {
      if (dialogTarget?.mode === 'edit') {
        await update(dialogTarget.prompt.id, { content: draft.content, expectedVersion: dialogTarget.prompt.version });
        toast.success('Personal instruction updated');
      } else {
        await create({ name: draft.name, category: draft.category, content: draft.content, scope: 'USER_PERSONAL', ownerUserId: user.id });
        toast.success('Personal instruction created');
      }
      setDialogTarget(null);
      reloadPersonal();
    } catch (err) {
      const occ = reduceOccConflict(err);
      if (occ.conflict) {
        toast.error(occ.message);
        reloadPersonal();
      } else {
        toast.error(err instanceof Error ? err.message : 'Failed to save instruction');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (prompt: PromptTemplate) => {
    try {
      await remove(prompt.id);
      toast.success('Personal instruction deleted');
      reloadPersonal();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete instruction');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Agent instructions</h2>
          <p className="text-sm text-muted-foreground">
            Personal overrides plus the department defaults applied when this user works in each department.
          </p>
        </div>
      </div>

      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UserRound aria-hidden className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Personal instructions</h3>
            <StatusBadge label={`${personal.length}`} colorRole="neutral" />
          </div>
          {canManage ? (
            <Button size="sm" className="h-8" onClick={() => setDialogTarget({ mode: 'create' })}>
              <Plus className="size-4" />
              New
            </Button>
          ) : null}
        </div>

        {personalLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : personal.length === 0 ? (
          <p className="text-sm text-muted-foreground">No personal instructions. This user follows the department defaults below.</p>
        ) : (
          <ul className="space-y-3">
            {personal.map((p) => (
              <li key={p.id} className="rounded-md border bg-muted/20 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Sparkles aria-hidden className="size-3.5 text-ai" />
                    {p.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <StatusBadge
                      label={`v${p.currentVersionNumber} · ${(p.status ?? 'DRAFT').toLowerCase()}`}
                      colorRole={promptStatusRole(p.status)}
                    />
                    {canManage ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Edit ${p.name}`}
                          onClick={() => setDialogTarget({ mode: 'edit', prompt: p })}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <ConfirmDelete
                          title="Delete personal instruction?"
                          description={`“${p.name}” will be removed. The user reverts to the department default.`}
                          onConfirm={() => handleDelete(p)}
                          trigger={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-destructive hover:text-destructive"
                              aria-label={`Delete ${p.name}`}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          }
                        />
                      </>
                    ) : null}
                  </div>
                </div>
                <p className="mb-2 text-xs text-muted-foreground">
                  {p.category} · updated {formatDateTime(p.updatedAt)}
                </p>
                <p className="line-clamp-3 text-sm text-foreground/90">{p.content}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <h3 className="pt-2 text-sm font-semibold text-muted-foreground">Department defaults</h3>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : assignedIds.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Sparkles />
            </EmptyMedia>
            <EmptyTitle>No assigned departments</EmptyTitle>
            <EmptyDescription>Assign this user to a department to surface its agent instructions here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        assignedIds.map((deptId) => {
          const prompts = byDept[deptId] ?? [];
          const isPrimary = user.primaryDepartmentId === deptId;
          return (
            <Card key={deptId} className="p-5">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{nameById.get(deptId) ?? deptId}</h3>
                  <StatusBadge label={isPrimary ? 'Primary' : 'Member'} colorRole={isPrimary ? 'info' : 'neutral'} />
                </div>
                <Button asChild variant="ghost" size="sm" className="h-7 text-primary">
                  <Link to="/tenants/$tenantId/departments/$departmentId" params={{ tenantId, departmentId: deptId }}>
                    Manage <ArrowRight className="size-3.5" />
                  </Link>
                </Button>
              </div>
              {prompts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No agent instructions for this department yet.</p>
              ) : (
                <ul className="space-y-3">
                  {prompts.map((p) => (
                    <li key={p.id} className="rounded-md border bg-muted/20 p-3">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <Sparkles aria-hidden className="size-3.5 text-ai" />
                          {p.name}
                        </span>
                        <StatusBadge
                          label={`v${p.currentVersionNumber} · ${(p.status ?? 'DRAFT').toLowerCase()}`}
                          colorRole={promptStatusRole(p.status)}
                        />
                      </div>
                      <p className="mb-2 text-xs text-muted-foreground">
                        {p.category} · updated {formatDateTime(p.updatedAt)}
                      </p>
                      <p className="line-clamp-3 text-sm text-foreground/90">{p.content}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })
      )}

      <PersonalInstructionDialog
        target={dialogTarget}
        isSaving={isSaving}
        onOpenChange={(o) => !o && setDialogTarget(null)}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
