'use client';

import { useId, useState } from 'react';
import { IconAlertTriangle, IconShieldLock } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';
import { isRestoreLockError, useRestoreCheckpoint } from '../api/hooks';
import {
  RESTORE_CATEGORY_LABELS,
  type RestoreCategory,
  type TenantCheckpoint,
  type TenantCheckpointRestore,
} from '../api/types';

const REASON_MIN = 10;
const REASON_MAX = 1000;

export interface RestoreDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  /** The tenant's CURRENT name — the gateway matches it exactly. */
  tenantName: string;
  checkpoint: TenantCheckpoint;
  /** Clinical data is a platform-admin category; tenant admins never see it. */
  isSuperAdmin: boolean;
  onRestored: (restore: TenantCheckpointRestore) => void;
  /** Called on a 423 so the screen can show its read-only banner. */
  onLocked?: () => void;
}

/**
 * Restore step-up: the break-glass credentials (password + retyped tenant
 * name) of the shared dialog, plus the category picker and a required reason.
 * The shared `BreakGlassDialog` has no body slot, so this composes the same
 * primitives and field contract here rather than editing the shared file.
 * Gateway rejections (401/400/403/409/423) render in the dialog, not as toasts.
 */
export function RestoreDialog({ open, onOpenChange, tenantId, tenantName, checkpoint, isSuperAdmin, onRestored, onLocked }: RestoreDialogProps) {
  const restore = useRestoreCheckpoint(tenantId);
  const [categories, setCategories] = useState<RestoreCategory[]>([]);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [typedName, setTypedName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const uid = useId();

  const available: RestoreCategory[] = isSuperAdmin ? ['CONFIG_CONTENT', 'USERS_ACCESS', 'CLINICAL'] : ['CONFIG_CONTENT', 'USERS_ACCESS'];
  const trimmedReason = reason.trim();
  const armed = categories.length > 0 && trimmedReason.length >= REASON_MIN && password.length > 0 && typedName === tenantName;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setCategories([]);
      setReason('');
      setPassword('');
      setTypedName('');
      setError(null);
      restore.reset();
    }
    onOpenChange(next);
  }

  function toggle(category: RestoreCategory, checked: boolean) {
    setCategories((current) => (checked ? [...current, category] : current.filter((entry) => entry !== category)));
  }

  function handleSubmit() {
    setError(null);
    restore.mutate(
      { id: checkpoint.id, body: { categories, reason: trimmedReason, password, confirmationName: typedName } },
      {
        onSuccess: (result) => {
          toast.success('Restore started');
          handleOpenChange(false);
          onRestored(result);
        },
        onError: (mutationError) => {
          if (isRestoreLockError(mutationError)) onLocked?.();
          setError(mutationError.message);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={DIALOG_SIZE_CLASS.md}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconShieldLock aria-hidden className="text-destructive size-5" />
            Restore checkpoint
          </DialogTitle>
          <DialogDescription>
            Restores <span className="text-foreground font-medium">{checkpoint.label}</span> into <span className="text-foreground font-medium">{tenantName}</span>. A
            safety checkpoint of the current state is taken first, and the tenant is read-only until the restore finishes.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">What to restore *</legend>
            {available.map((category) => {
              const id = `${uid}-${category}`;
              const { label, description } = RESTORE_CATEGORY_LABELS[category];
              return (
                <div key={category} className="flex items-start gap-3 rounded-md border p-3">
                  <Checkbox id={id} checked={categories.includes(category)} onCheckedChange={(checked) => toggle(category, checked === true)} className="mt-0.5" />
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={id}>{label}</Label>
                    <p className="text-muted-foreground text-xs">{description}</p>
                    {category === 'CLINICAL' ? (
                      <p className="text-destructive flex items-center gap-1 text-xs font-medium">
                        <IconAlertTriangle aria-hidden className="size-3.5" />
                        This overwrites live clinical records with the checkpoint copy.
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-reason`}>Reason *</Label>
            <Textarea
              id={`${uid}-reason`}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={REASON_MAX}
              className="min-h-20 resize-none"
              aria-describedby={`${uid}-reason-hint`}
            />
            <p id={`${uid}-reason-hint`} className="text-muted-foreground text-xs">
              {REASON_MIN}&ndash;{REASON_MAX} characters; recorded in the audit trail ({trimmedReason.length}/{REASON_MAX}).
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-password`}>Your password</Label>
            <Input id={`${uid}-password`} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-name`}>
              Type <span className="font-mono font-medium">{tenantName}</span> to confirm
            </Label>
            <Input id={`${uid}-name`} value={typedName} onChange={(event) => setTypedName(event.target.value)} autoComplete="off" />
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={restore.isPending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!armed || restore.isPending} onClick={handleSubmit}>
            {restore.isPending ? <Spinner /> : null}
            Restore checkpoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
