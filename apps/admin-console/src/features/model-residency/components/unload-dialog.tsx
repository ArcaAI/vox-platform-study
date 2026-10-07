'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { asModelResidencyConflict, useUnloadResidencyModel } from '../api';
import type { UnloadDialogProps } from './residency-dialog-contracts';

export function UnloadDialog({ open, onOpenChange, service, model, onUnloaded }: UnloadDialogProps) {
  const unload = useUnloadResidencyModel();
  const [reason, setReason] = useState('');
  const [serverInFlight, setServerInFlight] = useState<number | null>(null);
  const [pending, setPending] = useState(false);

  // Fresh state on every open.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setReason('');
      setServerInFlight(null);
    }
  }

  const pinned = model.keepPolicy.kind === 'always';
  const inFlight = serverInFlight ?? model.residency?.inFlight ?? 0;
  const force = inFlight > 0 || serverInFlight !== null;
  const trimmed = reason.trim();
  const armed = !force || trimmed.length > 0;

  async function confirm() {
    setPending(true);
    try {
      await unload.mutateAsync({
        service: service.service,
        modelRef: model.modelRef,
        ...(force ? { force: true } : {}),
        ...(trimmed ? { reason: trimmed } : {}),
      });
      toast.success(`${model.name} unloaded.`);
      onUnloaded?.();
      onOpenChange(false);
    } catch (error) {
      const conflict = asModelResidencyConflict(error);
      if (conflict?.code === 'IN_FLIGHT' && !force) {
        setServerInFlight(conflict.inFlight ?? 1);
      } else {
        toast.error(conflict?.message || `Couldn't unload ${model.name}.`);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Unload {model.name}</DialogTitle>
          <DialogDescription>{service.label}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {pinned ? (
            <p className="text-sm">
              <strong>{model.keepPolicy.label}.</strong> {model.keepPolicy.reason} It cannot be unloaded while it is pinned; change its keep policy
              first.
            </p>
          ) : (
            <>
              <p className="text-sm">
                {force
                  ? `${model.name} is serving ${inFlight} request${inFlight === 1 ? '' : 's'}. Unloading it now will interrupt them.`
                  : 'The model is unloaded from the service. It reloads on demand if something asks for it.'}
              </p>
              {serverInFlight !== null ? (
                <p role="alert" className="text-destructive text-sm">
                  The service reports {serverInFlight} request{serverInFlight === 1 ? '' : 's'} still in flight. Enter a reason to unload anyway.
                </p>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="unload-reason">
                  {force ? (
                    <>
                      Reason <span aria-hidden>*</span>
                      <span className="sr-only">(required, audited)</span>
                    </>
                  ) : (
                    'Reason (optional)'
                  )}
                </Label>
                <Textarea
                  id="unload-reason"
                  rows={2}
                  aria-required={force ? 'true' : undefined}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={pending}
                />
              </div>
            </>
          )}
        </div>
        <DialogFooter className="shrink-0 border-t p-4 sm:justify-end">
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {pinned ? 'Close' : 'Cancel'}
          </Button>
          {pinned ? null : (
            <Button variant="destructive" disabled={!armed || pending} onClick={() => void confirm()}>
              {pending ? <Spinner /> : null}
              {force ? 'Unload anyway' : 'Unload'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
