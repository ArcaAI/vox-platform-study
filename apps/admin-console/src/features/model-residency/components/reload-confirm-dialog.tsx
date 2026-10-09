'use client';

import { useState } from 'react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { asModelResidencyConflict, toastResidencyError } from '@/shared/residency';
import type { LmStudioResidencyLoadOptions, ResidencyCatalogueModel, ResidencyServiceGroup } from '../api/types';
import { liveConsumerLines, requiresUnloadReason } from './residency-display';

export interface ReloadConfirmInput {
  /** The audited reason — set whenever the admin typed one (mandatory for a live-path, pinned or serving model). */
  reason: string | null;
  /** Only while requests are in flight (local count or a 409 IN_FLIGHT): the replace drops them. */
  force: boolean;
}

export interface ReloadConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: ResidencyServiceGroup;
  model: ResidencyCatalogueModel;
  options: LmStudioResidencyLoadOptions;
  isPending: boolean;
  /** Sends the replace; a rejection is handled HERE (409 LIVE_PATH_REASON_REQUIRED / IN_FLIGHT, or a toast). */
  onConfirm: (input: ReloadConfirmInput) => Promise<void>;
}

/** "with context length 32768; everything else is restored…" / ", restored to its serving profile" (R3-1). */
function describeOptions(options: LmStudioResidencyLoadOptions): string {
  const parts: string[] = [];
  if (options.contextLength !== undefined) parts.push(`context length ${options.contextLength}`);
  if (options.flashAttention !== undefined) parts.push(`flash attention ${options.flashAttention ? 'on' : 'off'}`);
  return parts.length > 0 ? ` with ${parts.join(', ')}; everything else is restored from its serving profile` : ', restored to its serving profile';
}

/**
 * Confirms "Reload with options": the running instance is UNLOADED and loaded
 * again, so anything it is serving is interrupted. Mirrors the unload rule
 * (TASK-1055): a live-path or pinned model needs a reason and names who uses
 * it (also on a 409 LIVE_PATH_REASON_REQUIRED from the reload itself); a
 * reason AND `force` are needed while requests are in flight.
 */
export function ReloadConfirmDialog({ open, onOpenChange, service, model, options, isPending, onConfirm }: ReloadConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [serverInFlight, setServerInFlight] = useState<number | null>(null);
  const [serverLivePath, setServerLivePath] = useState<{ message: string; consumers: string[] } | null>(null);
  const pending = isPending || sending;

  const inFlight = serverInFlight ?? model.residency?.inFlight ?? 0;
  const force = inFlight > 0;
  const livePath = requiresUnloadReason(model) || serverLivePath !== null;
  const consumers = serverLivePath?.consumers.length ? serverLivePath.consumers : livePath ? liveConsumerLines(model) : [];
  const needsReason = force || livePath;
  const trimmed = reason.trim();
  const armed = !needsReason || trimmed.length > 0;

  async function confirm() {
    setSending(true);
    try {
      await onConfirm({ reason: trimmed || null, force });
    } catch (error) {
      const conflict = asModelResidencyConflict(error);
      if (conflict?.code === 'IN_FLIGHT' && !force) setServerInFlight(conflict.inFlight ?? 1);
      else if (conflict?.code === 'LIVE_PATH_REASON_REQUIRED' && !trimmed)
        setServerLivePath({ message: conflict.message, consumers: conflict.consumers ?? [] });
      else toastResidencyError(error, `Couldn't reload ${model.name}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Reload {model.name}</DialogTitle>
          <DialogDescription>{service.label}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="text-sm">
            The running instance is unloaded and loaded again{describeOptions(options)}. Requests it is serving during the reload are interrupted.
          </p>
          {inFlight > 0 ? (
            <p role="alert" className="text-destructive text-sm">
              {model.name} is serving {inFlight} request{inFlight === 1 ? '' : 's'} right now.
            </p>
          ) : null}
          {livePath ? (
            <section className="flex flex-col gap-2" aria-labelledby="reload-live-h">
              <h3 id="reload-live-h" className="text-sm font-medium">
                {model.keepPolicy.kind === 'always' ? `${model.keepPolicy.label} — on the live path` : 'On the live consultation path'}
              </h3>
              {serverLivePath ? (
                <p role="alert" className="text-destructive text-sm">
                  {serverLivePath.message || `${model.name} is on the live consultation path.`} Enter a reason to reload it.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">{model.keepPolicy.reason}</p>
              )}
              {consumers.length > 0 ? (
                <ul aria-label="Who is interrupted" className="list-disc pl-5 text-sm">
                  {consumers.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
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
                disabled={pending}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter className="shrink-0 items-center border-t p-4 sm:justify-end">
          {needsReason && !armed ? <span className="text-muted-foreground mr-auto text-xs">Enter a reason to enable Reload</span> : null}
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!armed || pending} onClick={() => void confirm()}>
            {pending ? <Spinner /> : null}
            Reload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
