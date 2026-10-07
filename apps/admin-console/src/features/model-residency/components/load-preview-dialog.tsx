'use client';

import { useEffect, useMemo, useState } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { formatBytes } from '@/shared/format';
import { asModelResidencyConflict, useLoadPreview, useLoadResidencyModel, useModelResidencyCatalogue, useUnloadResidencyModel } from '../api';
import type { LoadModelResidencyRequest, ModelResidencyLoadPreview } from '../api';
import type { LoadPreviewDialogProps } from './residency-dialog-contracts';

function PreviewSkeleton() {
  return (
    <div className="flex flex-col gap-4" data-testid="load-preview-skeleton">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-3 w-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  );
}

function Callout({ tone, title, children }: { tone: 'ok' | 'warn' | 'info'; title: string; children?: React.ReactNode }) {
  const Icon = tone === 'ok' ? IconCircleCheck : tone === 'warn' ? IconAlertTriangle : IconInfoCircle;
  const toneClass = tone === 'ok' ? 'border-success/40 bg-success/10' : tone === 'warn' ? 'border-destructive/40 bg-destructive/10' : 'bg-muted';
  return (
    <div role="status" className={`flex items-start gap-3 rounded-md border p-3 ${toneClass}`}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        {children ? <div className="text-muted-foreground text-sm">{children}</div> : null}
      </div>
    </div>
  );
}

/** Before/after bar of the device: used (after the ticked evictions) + this model's need, against the card and the headroom line. */
function DeviceBar({
  label,
  totalBytes,
  usedBytes,
  needBytes,
  headroomBytes,
}: {
  label: string;
  totalBytes: number;
  usedBytes: number;
  needBytes: number;
  headroomBytes: number;
}) {
  const pct = (bytes: number) => `${Math.min(100, Math.max(0, (bytes / totalBytes) * 100))}%`;
  const after = usedBytes + needBytes;
  const over = totalBytes - after < headroomBytes;
  const description = `${label}: ${formatBytes(usedBytes)} in use plus ${formatBytes(needBytes)} needed is ${formatBytes(after)} of ${formatBytes(totalBytes)}; headroom line at ${formatBytes(totalBytes - headroomBytes)}${over ? ', over the headroom line' : ''}`;
  return (
    <div className="flex flex-col gap-1">
      <div role="img" aria-label={description} className="bg-muted relative flex h-3 w-full overflow-hidden rounded-full">
        <span className="bg-foreground/50 h-full" style={{ width: pct(usedBytes) }} />
        <span className={`h-full ${over ? 'bg-destructive' : 'bg-primary'}`} style={{ width: pct(needBytes) }} />
        <span aria-hidden className="bg-foreground absolute inset-y-0 w-0.5" style={{ left: pct(totalBytes - headroomBytes) }} />
      </div>
      <div className="text-muted-foreground flex justify-between text-xs" aria-hidden>
        <span>0</span>
        <span>headroom line {formatBytes(totalBytes - headroomBytes)}</span>
        <span>{formatBytes(totalBytes)}</span>
      </div>
    </div>
  );
}

export function LoadPreviewDialog({ open, onOpenChange, service, model, onAdmitted }: LoadPreviewDialogProps) {
  const preview = useLoadPreview();
  const unload = useUnloadResidencyModel();
  const load = useLoadResidencyModel();
  const catalogue = useModelResidencyCatalogue();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { mutate: requestPreview } = preview;
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setReason('');
    requestPreview({ service: service.service, modelRef: model.modelRef });
  }, [open, service.service, model.modelRef, requestPreview]);

  const data: ModelResidencyLoadPreview | undefined = preview.data;
  const evictKey = (e: { service: string; modelRef: string }) => `${e.service}::${e.modelRef}`;

  const freedBytes = useMemo(
    () => (data ? data.evictable.filter((e) => selected.has(evictKey(e))).reduce((sum, e) => sum + (e.bytes ?? 0), 0) : 0),
    [data, selected],
  );
  const remainingShortfall = data ? Math.max(0, data.shortfallBytes - freedBytes) : 0;
  const fitsAfter = !!data && (data.fits || (data.refusal === 'OVER_BUDGET' && remainingShortfall === 0));
  const alreadyLoaded = data?.refusal === 'ALREADY_LOADED';
  const needsReason = !!data && !alreadyLoaded && !fitsAfter;
  const device = data?.device ? catalogue.data?.devices.find((d) => d.id === data.device) : undefined;
  const armed = !needsReason || reason.trim().length > 0;

  async function confirm() {
    if (!data) return;
    setBusy(true);
    try {
      for (const e of data.evictable.filter((candidate) => selected.has(evictKey(candidate)))) {
        await unload.mutateAsync({ service: e.service, modelRef: e.modelRef, reason: `Make room for ${model.name}` });
      }
      const body: LoadModelResidencyRequest = { service: service.service, modelRef: model.modelRef };
      if (needsReason) {
        body.force = true;
        body.reason = reason.trim();
      }
      const response = await load.mutateAsync(body);
      onAdmitted(response);
      onOpenChange(false);
    } catch (error) {
      const conflict = asModelResidencyConflict(error);
      toast.error(conflict?.message || `Couldn't load ${model.name}.`);
    } finally {
      setBusy(false);
    }
  }

  function calloutFor(d: ModelResidencyLoadPreview) {
    if (d.refusal === 'ALREADY_LOADED')
      return (
        <Callout tone="info" title="Already loaded">
          This model is resident on the service; there is nothing to load.
        </Callout>
      );
    if (d.refusal === 'NO_SIZE')
      return (
        <Callout tone="warn" title="No size known — loading needs a reason">
          Neither a measurement nor a catalogue size exists, so HOPE cannot tell whether it fits.
        </Callout>
      );
    if (fitsAfter)
      return (
        <Callout tone="ok" title={selected.size > 0 ? 'Fits once the selected models are unloaded' : 'Fits'}>
          Within the card and its headroom.
        </Callout>
      );
    return (
      <Callout tone="warn" title={`Does not fit — short by ${formatBytes(remainingShortfall)}`}>
        Loading now would push {device ? device.label.split('—')[0]?.trim() : 'the device'} past its limit.
      </Callout>
    );
  }

  const deviceLabel = device ? (device.label.split('—')[0]?.trim() ?? device.label) : (data?.device ?? 'Device');

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Load {model.name}</DialogTitle>
          <DialogDescription>{service.label}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {preview.isPending && !data ? (
            <PreviewSkeleton />
          ) : preview.isError || !data ? (
            <Callout tone="warn" title="Couldn't check placement">
              The dry run failed. Close this dialog and try again.
            </Callout>
          ) : (
            <div className="flex flex-col gap-5">
              {calloutFor(data)}

              {device && data.needBytes !== null ? (
                <section className="flex flex-col gap-2" aria-labelledby="lp-bar-h">
                  <h3 id="lp-bar-h" className="text-sm font-medium">
                    {deviceLabel} after this load
                  </h3>
                  <DeviceBar
                    label={deviceLabel}
                    totalBytes={device.totalBytes}
                    usedBytes={Math.max(0, device.usedBytes - freedBytes)}
                    needBytes={data.needBytes}
                    headroomBytes={data.headroomBytes ?? device.headroomBytes}
                  />
                </section>
              ) : null}

              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Needs</dt>
                <dd>
                  {data.needBytes === null ? 'Unknown' : formatBytes(data.needBytes)}
                  {data.needSource === 'catalogue' ? <span className="text-muted-foreground"> · catalogue × 1.2, never measured</span> : null}
                  {data.needSource === 'measured' ? <span className="text-muted-foreground"> · measured</span> : null}
                </dd>
                <dt className="text-muted-foreground">Free now</dt>
                <dd>{formatBytes(data.freeBytes)}</dd>
                <dt className="text-muted-foreground">Headroom to keep</dt>
                <dd>{formatBytes(data.headroomBytes)}</dd>
                <dt className="text-muted-foreground">Shortfall</dt>
                <dd>{formatBytes(remainingShortfall)}</dd>
              </dl>

              {data.evictable.length > 0 || data.pinned.length > 0 || (data.unattributedBytes ?? 0) > 0 ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">Make room on {deviceLabel}</legend>
                  {data.evictable.map((e) => {
                    const id = `lp-evict-${evictKey(e)}`;
                    return (
                      <div key={id} className="flex items-start gap-2">
                        <Checkbox
                          id={id}
                          checked={selected.has(evictKey(e))}
                          disabled={busy}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked === true) next.add(evictKey(e));
                              else next.delete(evictKey(e));
                              return next;
                            })
                          }
                        />
                        <Label htmlFor={id} className="flex flex-1 flex-col gap-0.5 font-normal">
                          <span>Unload {e.name}</span>
                          <span className="text-muted-foreground text-xs">{e.reason}</span>
                        </Label>
                        <span className="text-sm tabular-nums">{formatBytes(e.bytes)}</span>
                      </div>
                    );
                  })}
                  {data.pinned.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {data.pinned.map((p) => (
                        <li key={evictKey(p)} className="text-muted-foreground flex items-start justify-between gap-2 text-sm">
                          <span className="flex flex-col">
                            <span>{p.name}</span>
                            <span className="text-xs">{p.reason} — pinned, not offered</span>
                          </span>
                          <span className="tabular-nums">{formatBytes(p.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {(data.unattributedBytes ?? 0) > 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {formatBytes(data.unattributedBytes)} is not attributed to any model (CUDA contexts and other pods on a time-sliced card).
                    </p>
                  ) : null}
                  {data.evictable.length > 0 && data.refusal === 'OVER_BUDGET' ? (
                    <p className="text-sm" aria-live="polite">
                      {remainingShortfall > 0
                        ? `With the selection: still short by ${formatBytes(remainingShortfall)}.`
                        : 'With the selection it fits.'}
                    </p>
                  ) : null}
                </fieldset>
              ) : null}

              {needsReason ? (
                <section className="flex flex-col gap-1.5" aria-labelledby="lp-force-h">
                  <h3 id="lp-force-h" className="text-sm font-medium">
                    Load anyway
                  </h3>
                  <p className="text-muted-foreground text-sm">
                    There is no memory isolation on time-sliced cards: an out-of-memory error can take down other models on the same GPU.
                  </p>
                  <Label htmlFor="lp-force-reason">
                    Reason <span aria-hidden>*</span>
                    <span className="sr-only">(required, audited)</span>
                  </Label>
                  <Textarea id="lp-force-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} disabled={busy} />
                </section>
              ) : null}
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0 items-center border-t p-4 sm:justify-end">
          {needsReason && !armed ? <span className="text-muted-foreground mr-auto text-xs">Enter a reason to enable Load anyway</span> : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {data && !alreadyLoaded ? (
            <Button variant={needsReason ? 'destructive' : 'default'} disabled={!armed || busy} onClick={() => void confirm()}>
              {busy ? <Spinner /> : null}
              {needsReason ? 'Load anyway' : 'Load'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
