'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { asModelResidencyConflict, residencyErrorMessage, useUnloadResidencyModel } from '../api';
import type { UnloadDialogProps } from './residency-dialog-contracts';
import { liveConsumerLines, requiresUnloadReason, unloadDeviceChoices } from './residency-display';

const ALL_COPIES = 'all';

/** "gpu1" -> "GPU 1" (the copy picker names devices the way the GPU cards do). */
function gpuWords(device: string): string {
  const match = /^gpu(\d+)$/.exec(device);
  return match ? `GPU ${match[1]}` : device;
}

/**
 * Every unload goes through this one dialog (TASK-1051), now also for a
 * live-path / "Always loaded" model (TASK-1055, OD-2): no keep-policy change is
 * needed first — the confirmation names who loses the model and the reason
 * becomes MANDATORY (audited). A reason is likewise mandatory (with
 * `force: true`) while requests are in flight. A model held as separate copies
 * on several GPUs can be unloaded one device at a time.
 */
export function UnloadDialog({ open, onOpenChange, service, model, onUnloaded }: UnloadDialogProps) {
  const unload = useUnloadResidencyModel();
  const [reason, setReason] = useState('');
  const [serverInFlight, setServerInFlight] = useState<number | null>(null);
  /** The server said this model is on the live path (409 LIVE_PATH_REASON_REQUIRED) — its own words for who uses it. */
  const [serverLivePath, setServerLivePath] = useState<{ message: string; consumers: string[] } | null>(null);
  const [copy, setCopy] = useState(ALL_COPIES);
  const [pending, setPending] = useState(false);

  // Fresh state on every open.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setReason('');
      setServerInFlight(null);
      setServerLivePath(null);
      setCopy(ALL_COPIES);
    }
  }

  const livePath = requiresUnloadReason(model) || serverLivePath !== null;
  const consumers = serverLivePath?.consumers.length ? serverLivePath.consumers : liveConsumerLines(model);
  const copies = unloadDeviceChoices(model);
  const inFlight = serverInFlight ?? model.residency?.inFlight ?? 0;
  const force = inFlight > 0 || serverInFlight !== null;
  const reasonRequired = force || livePath;
  const trimmed = reason.trim();
  const armed = !reasonRequired || trimmed.length > 0;

  async function confirm() {
    setPending(true);
    try {
      await unload.mutateAsync({
        service: service.service,
        modelRef: model.modelRef,
        ...(force ? { force: true } : {}),
        ...(trimmed ? { reason: trimmed } : {}),
        ...(copies.length > 0 && copy !== ALL_COPIES ? { device: copy } : {}),
      });
      toast.success(`${model.name} unloaded.`);
      onUnloaded?.();
      onOpenChange(false);
    } catch (error) {
      const conflict = asModelResidencyConflict(error);
      if (conflict?.code === 'IN_FLIGHT' && !force) {
        setServerInFlight(conflict.inFlight ?? 1);
      } else if (conflict?.code === 'LIVE_PATH_REASON_REQUIRED' && !trimmed) {
        setServerLivePath({ message: conflict.message, consumers: conflict.consumers ?? [] });
      } else {
        toast.error(residencyErrorMessage(error, `Couldn't unload ${model.name}.`));
      }
    } finally {
      setPending(false);
    }
  }

  const summary = force
    ? `${model.name} is serving ${inFlight} request${inFlight === 1 ? '' : 's'}. Unloading it now will interrupt them.`
    : livePath
      ? null
      : 'The model is unloaded from the service. It reloads on demand if something asks for it.';

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-md">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Unload {model.name}</DialogTitle>
          <DialogDescription>{service.label}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {livePath ? (
            <section className="flex flex-col gap-2" aria-labelledby="unload-live-h">
              <h3 id="unload-live-h" className="text-sm font-medium">
                {model.keepPolicy.kind === 'always' ? `${model.keepPolicy.label} — on the live path` : 'On the live consultation path'}
              </h3>
              {serverLivePath ? (
                <p role="alert" className="text-destructive text-sm">
                  {serverLivePath.message || `${model.name} is on the live consultation path.`} Enter a reason to unload it.
                </p>
              ) : (
                <p className="text-muted-foreground text-sm">{model.keepPolicy.reason}</p>
              )}
              {consumers.length > 0 ? (
                <ul aria-label="Who loses it" className="list-disc pl-5 text-sm">
                  {consumers.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-sm">
                Requests that need it fail or wait for a cold load until it is loaded again. Its keep policy is not changed; the residency controller
                reloads live-path models only in enforce mode.
              </p>
            </section>
          ) : null}
          {summary ? <p className="text-sm">{summary}</p> : null}
          {serverInFlight !== null ? (
            <p role="alert" className="text-destructive text-sm">
              The service reports {serverInFlight} request{serverInFlight === 1 ? '' : 's'} still in flight. Enter a reason to unload anyway.
            </p>
          ) : null}
          {copies.length > 0 ? (
            <section className="flex flex-col gap-2" aria-labelledby="unload-copy-h">
              <h3 id="unload-copy-h" className="text-sm font-medium">
                Which copy
              </h3>
              <RadioGroup aria-labelledby="unload-copy-h" value={copy} onValueChange={setCopy} disabled={pending} className="gap-2">
                {[ALL_COPIES, ...copies].map((value) => (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={`unload-copy-${value}`} value={value} />
                    <Label htmlFor={`unload-copy-${value}`} className="font-normal">
                      {value === ALL_COPIES ? `All copies (${copies.map(gpuWords).join(', ')})` : `Only ${gpuWords(value)}`}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </section>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unload-reason">
              {reasonRequired ? (
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
              aria-required={reasonRequired ? 'true' : undefined}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={pending}
            />
          </div>
        </div>
        <DialogFooter className="shrink-0 items-center border-t p-4 sm:justify-end">
          {reasonRequired && !armed ? <span className="text-muted-foreground mr-auto text-xs">Enter a reason to enable unload</span> : null}
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!armed || pending} onClick={() => void confirm()}>
            {pending ? <Spinner /> : null}
            {force ? 'Unload anyway' : 'Unload'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
