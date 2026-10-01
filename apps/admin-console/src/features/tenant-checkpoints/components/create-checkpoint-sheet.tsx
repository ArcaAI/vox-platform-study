'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@arcaai/ui/components/shadcn/sheet';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { isRestoreLockError, useCreateCheckpoint } from '../api/hooks';

const LABEL_MAX = 120;

export function CreateCheckpointSheet({
  open,
  onOpenChange,
  tenantId,
  onLocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  onLocked?: () => void;
}) {
  const create = useCreateCheckpoint(tenantId);
  const uid = useId();
  const [label, setLabel] = useState('');
  const [includesMedia, setIncludesMedia] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mismatch = passphrase !== confirm;
  const valid = label.trim().length > 0 && !mismatch;

  function handleOpenChange(next: boolean) {
    if (!next) {
      setLabel('');
      setIncludesMedia(true);
      setPassphrase('');
      setConfirm('');
      setError(null);
      create.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setError(null);
    create.mutate(
      { label: label.trim(), includesMedia, ...(passphrase ? { passphrase } : {}) },
      {
        onSuccess: () => {
          toast.success('Checkpoint started');
          handleOpenChange(false);
        },
        onError: (mutationError) => {
          if (isRestoreLockError(mutationError)) onLocked?.();
          setError(mutationError.message);
        },
      },
    );
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="flex flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Create checkpoint</SheetTitle>
          <SheetDescription>Captures this tenant&apos;s data into an encrypted archive you can download or restore later.</SheetDescription>
        </SheetHeader>
        <form id={`${uid}-form`} onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-label`}>Label *</Label>
            <Input id={`${uid}-label`} value={label} maxLength={LABEL_MAX} onChange={(event) => setLabel(event.target.value)} autoComplete="off" />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${uid}-media`}>Include media</Label>
              <p className="text-muted-foreground text-xs">Recordings and other stored files. Turn off for a smaller, faster archive.</p>
            </div>
            <Switch id={`${uid}-media`} checked={includesMedia} onCheckedChange={setIncludesMedia} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-pass`}>Passphrase (optional)</Label>
            <Input id={`${uid}-pass`} type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${uid}-confirm`}>Confirm passphrase</Label>
            <Input
              id={`${uid}-confirm`}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              aria-invalid={mismatch && confirm.length > 0}
              aria-describedby={`${uid}-pass-note`}
            />
            {mismatch && confirm.length > 0 ? <p className="text-destructive text-sm">Passphrases do not match.</p> : null}
            <p id={`${uid}-pass-note`} className="text-muted-foreground text-xs">
              Store it safely &mdash; it cannot be recovered. Without it a passphrase-protected checkpoint can never be opened.
            </p>
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
        </form>
        <SheetFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!valid || create.isPending}>
            {create.isPending ? <Spinner /> : null}
            Create checkpoint
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
