'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@arcaai/ui/components/shadcn/alert-dialog';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useUnloadModel } from '../api/hooks';
import { asModelResidencyConflict } from '../api/types';
import type { ModelResidencyModel } from '../api/types';

export interface UnloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ModelResidencyModel | null;
  /** True when this is the FORCED path — the row action is only reachable this
   *  way while `inFlight > 0` (OD-3: a mandatory reason and a red confirmation). */
  force: boolean;
}

/**
 * Unload — plain confirm when the model is idle; a forced, reasoned,
 * destructive confirm when it is serving requests (ticket §5.4, mirroring the
 * force-load pattern the same owner decision, OD-3, applies to Load).
 */
export function UnloadDialog({ open, onOpenChange, model, force }: UnloadDialogProps) {
  const [reason, setReason] = useState('');
  const mutation = useUnloadModel();

  // Re-arm the reason field whenever the dialog closes, so a second forced
  // unload never inherits the first one's text.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setReason('');
  }

  if (!model) return null;

  function submit(withReason: string | undefined) {
    if (!model) return;
    mutation.mutate(
      { service: model.service, modelRef: model.modelRef, force, reason: withReason },
      {
        onSuccess: () => {
          toast.success(`${model.modelRef} unloaded.`);
          onOpenChange(false);
        },
        onError: (error) => {
          const conflict = asModelResidencyConflict(error);
          toast.error(
            conflict?.code === 'IN_FLIGHT'
              ? `${model.modelRef} is serving ${conflict.inFlight ?? 'some'} request(s) — force unload to proceed anyway.`
              : `Couldn't unload ${model.modelRef}.`,
          );
        },
      },
    );
  }

  if (!force) {
    return (
      <ConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Unload ${model.modelRef}?`}
        description="Frees this model's device memory. A future request loads it again on the usual policy."
        confirmLabel="Unload"
        isPending={mutation.isPending}
        onConfirm={() => submit(undefined)}
      />
    );
  }

  const armed = reason.trim().length > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Force unload {model.modelRef}?</AlertDialogTitle>
          <AlertDialogDescription>
            This model is serving {model.inFlight} request(s) right now. Forcing the unload drops them in flight.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="residency-force-unload-reason">Reason (required, audited)</Label>
          <Textarea
            id="residency-force-unload-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why this can't wait for the requests to finish"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!armed || mutation.isPending} onClick={() => submit(reason)}>
            {mutation.isPending ? <Spinner /> : null}
            Force unload
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
