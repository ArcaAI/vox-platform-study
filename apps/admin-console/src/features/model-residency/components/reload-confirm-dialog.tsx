'use client';

import { useState } from 'react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import type { LmStudioResidencyLoadOptions, ResidencyCatalogueModel, ResidencyServiceGroup } from '../api/types';

export interface ReloadConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  options: LmStudioResidencyLoadOptions;
  isPending: boolean;
  /** `reason` is set (and the load is forced) only when the dialog demanded one. */
  onConfirm: (reason: string | null) => void;
}

function describeOptions(options: LmStudioResidencyLoadOptions): string {
  const parts: string[] = [];
  if (options.contextLength !== undefined) parts.push(`context length ${options.contextLength}`);
  if (options.flashAttention !== undefined) parts.push(`flash attention ${options.flashAttention ? 'on' : 'off'}`);
  return parts.length > 0 ? parts.join(', ') : 'the same settings';
}

/**
 * Confirms "Reload with options": the running instance is UNLOADED and loaded
 * again, so anything it is serving is interrupted. A reason is required (and
 * the load is forced) when requests are in flight or the model is pinned.
 */
export function ReloadConfirmDialog({ open, onOpenChange, service, model, options, isPending, onConfirm }: ReloadConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const inFlight = model.residency?.inFlight ?? 0;
  const pinned = model.keepPolicy.kind === 'always';
  const needsReason = inFlight > 0 || pinned;
  const trimmed = reason.trim();
  const armed = !needsReason || trimmed.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Reload {model.name}</DialogTitle>
          <DialogDescription>{service.label}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="text-sm">
            The running instance is unloaded and loaded again with {describeOptions(options)}. Requests it is serving during the reload are
            interrupted.
          </p>
          {inFlight > 0 ? (
            <p role="alert" className="text-destructive text-sm">
              {model.name} is serving {inFlight} request{inFlight === 1 ? '' : 's'} right now.
            </p>
          ) : null}
          {pinned ? <p className="text-sm">{model.keepPolicy.label}: it is pinned, so a reload needs a reason.</p> : null}
          {needsReason ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reload-reason">
                Reason <span aria-hidden>*</span>
                <span className="sr-only">(required, audited)</span>
              </Label>
              <Textarea
                id="reload-reason"
                rows={2}
                aria-required="true"
                value={reason}
                disabled={isPending}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 border-t p-4 sm:justify-end">
          <Button variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!armed || isPending} onClick={() => onConfirm(needsReason ? trimmed : null)}>
            {isPending ? <Spinner /> : null}
            Reload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
