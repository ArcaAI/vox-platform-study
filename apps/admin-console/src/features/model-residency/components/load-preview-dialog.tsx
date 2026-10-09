'use client';

import { useEffect, useRef, useState } from 'react';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { RadioGroup, RadioGroupItem } from '@arcaai/ui/components/shadcn/radio-group';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { formatBytes } from '@/shared/format';
import {
  asModelResidencyConflict,
  residencyErrorMessage,
  useLoadPreview,
  useLoadResidencyModel,
  useModelResidencyCatalogue,
  useUnloadResidencyModel,
} from '../api';
import type { LoadModelResidencyRequest, ModelResidencyConflict, ModelResidencyLoadPreview, ResidencyPlacementCandidate } from '../api';
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

function Callout({
  tone,
  title,
  children,
  role = 'status',
}: {
  tone: 'ok' | 'warn' | 'info';
  title: string;
  children?: React.ReactNode;
  role?: 'status' | 'alert';
}) {
  const Icon = tone === 'ok' ? IconCircleCheck : tone === 'warn' ? IconAlertTriangle : IconInfoCircle;
  const toneClass = tone === 'ok' ? 'border-success/40 bg-success/10' : tone === 'warn' ? 'border-destructive/40 bg-destructive/10' : 'bg-muted';
  return (
    <div role={role} className={`flex items-start gap-3 rounded-md border p-3 ${toneClass}`}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        {children ? <div className="text-muted-foreground flex flex-col gap-2 text-sm">{children}</div> : null}
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

/** "GPU 1 · NVIDIA RTX 2000 Ada Generation" (or "— …") -> title "GPU 1", subtitle the card name. */
function splitCandidateLabel(label: string): { title: string; subtitle: string | null } {
  const [head, ...rest] = label.split(/\s[·—]\s/);
  const title = head?.trim() || label;
  const subtitle = rest.join(' · ').trim();
  return { title, subtitle: subtitle || null };
}

function candidateTitle(candidate: ResidencyPlacementCandidate | undefined, fallback: string): string {
  if (!candidate) return fallback;
  if (candidate.device === 'multi' && !candidate.label) return 'Split across cards';
  return splitCandidateLabel(candidate.label).title;
}

/** Free memory above the headroom the card must keep — what admission actually compares the need against. */
function freeAboveHeadroom(candidate: ResidencyPlacementCandidate): number {
  return Math.max(0, (candidate.freeBytes ?? 0) - (candidate.headroomBytes ?? 0));
}

const CAPACITY_CODES = new Set(['OVER_BUDGET', 'EXCEEDS_DEVICE']);

/**
 * TASK-1055 (AC-3) — one radio card per device the model could go to: name,
 * free memory and the need, and a fits / does-not-fit badge in WORDS with an
 * icon (never colour alone). Radix radio group: arrow keys move the pick.
 */
function PlacementPicker({
  candidates,
  picked,
  suggestedDevice,
  suggestionReason,
  needBytes,
  disabled,
  onPick,
}: {
  candidates: ResidencyPlacementCandidate[];
  picked: string | null;
  suggestedDevice: string | null;
  suggestionReason: string | null;
  needBytes: number | null;
  disabled: boolean;
  onPick: (device: string) => void;
}) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="lp-gpu-h">
      <h3 id="lp-gpu-h" className="text-sm font-medium">
        Choose a GPU
      </h3>
      {suggestionReason ? (
        <p id="lp-gpu-hint" className="text-muted-foreground text-xs">
          {suggestionReason}
        </p>
      ) : null}
      <RadioGroup
        aria-labelledby="lp-gpu-h"
        aria-describedby={suggestionReason ? 'lp-gpu-hint' : undefined}
        value={picked ?? ''}
        onValueChange={onPick}
        disabled={disabled}
        className="gap-2"
      >
        {candidates.map((candidate) => {
          const id = `lp-device-${candidate.device}`;
          const { title, subtitle } =
            candidate.device === 'multi' && !candidate.label ? { title: 'Split across cards', subtitle: null } : splitCandidateLabel(candidate.label);
          const verdict = candidate.fits ? 'Fits' : candidate.exceedsDevice ? 'Exceeds the card' : 'Does not fit';
          return (
            <div
              key={candidate.device}
              data-slot="placement-candidate"
              data-fits={candidate.fits ? 'true' : 'false'}
              className="has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 flex items-start gap-3 rounded-md border p-3"
            >
              <RadioGroupItem id={id} value={candidate.device} className="mt-0.5" />
              <Label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-start justify-between gap-x-3 gap-y-1 font-normal">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium break-words">{title}</span>
                  {subtitle ? <span className="text-muted-foreground text-xs break-words">{subtitle}</span> : null}
                </span>
                <span className="flex flex-col items-end gap-1 text-right">
                  <span className="flex flex-wrap justify-end gap-1">
                    {candidate.device === suggestedDevice ? <Badge variant="outline">Suggested</Badge> : null}
                    <Badge variant={candidate.fits ? 'secondary' : 'destructive'}>
                      {candidate.fits ? <IconCircleCheck aria-hidden /> : <IconAlertTriangle aria-hidden />}
                      {verdict}
                    </Badge>
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {formatBytes(candidate.freeBytes)} free · needs {formatBytes(needBytes)}
                    {candidate.fits ? '' : ` · short ${formatBytes(candidate.shortfallBytes)}`}
                  </span>
                </span>
              </Label>
            </div>
          );
        })}
      </RadioGroup>
    </section>
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
  /** TASK-1055 — the GPU the admin is placing the model on; null until the first preview names the candidates. */
  const [picked, setPicked] = useState<string | null>(null);
  const [makeDefault, setMakeDefault] = useState(false);
  /** TASK-1055 — a 409 OVER_BUDGET / EXCEEDS_DEVICE from the load itself: its advice is shown like the preview's. */
  const [conflict, setConflict] = useState<ModelResidencyConflict | null>(null);
  /** The last preview answered — kept while a re-check for a new pick is in flight, so the picker never blinks out. */
  const [lastData, setLastData] = useState<ModelResidencyLoadPreview | undefined>(undefined);

  const { mutate: requestPreview } = preview;
  // Fresh draft whenever the dialog opens for a (different) model — derived during render, not set in an effect.
  const seedKey = open ? `${service.service}::${model.modelRef}` : null;
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (seededFor !== seedKey) {
    setSeededFor(seedKey);
    if (seedKey !== null) {
      setSelected(new Set());
      setReason('');
      setPicked(null);
      setMakeDefault(false);
      setConflict(null);
      setLastData(undefined);
    }
  }
  if (preview.data && preview.data !== lastData) setLastData(preview.data);
  const data: ModelResidencyLoadPreview | undefined = preview.data ?? lastData;

  const conflictCandidates = conflict?.candidates && conflict.candidates.length > 0 ? conflict.candidates : null;
  const candidates: ResidencyPlacementCandidate[] = conflictCandidates ?? data?.candidates ?? [];
  const hasPicker = candidates.length > 0;
  // Default the pick to the suggested GPU the first time the candidates are known.
  if (hasPicker && picked === null && data) {
    const suggested = data.suggestedDevice && candidates.some((c) => c.device === data.suggestedDevice) ? data.suggestedDevice : null;
    setPicked(suggested ?? (data.device && candidates.some((c) => c.device === data.device) ? data.device : candidates[0]!.device));
  }

  const requestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open) return;
    requestedFor.current = null;
    requestPreview({ service: service.service, modelRef: model.modelRef });
  }, [open, service.service, model.modelRef, requestPreview]);
  // Every pick is re-checked with the same admission arithmetic (once per pick — a server that answers for another device cannot loop this).
  const previewPending = preview.isPending && !!data;
  useEffect(() => {
    if (!open || picked === null || !data || previewPending) return;
    if (data.device === picked || requestedFor.current === picked) return;
    requestedFor.current = picked;
    requestPreview({ service: service.service, modelRef: model.modelRef, device: picked });
  }, [open, picked, data, previewPending, service.service, model.modelRef, requestPreview]);

  const pickedCandidate = hasPicker ? candidates.find((c) => c.device === picked) : undefined;
  const previewMatchesPick = !hasPicker || (!!data && data.device === picked);
  const conflictForPick = conflict !== null && CAPACITY_CODES.has(conflict.code) && (conflict.device ?? picked) === picked ? conflict : null;
  const suggestedId = conflictForPick ? (conflict?.suggestedDevice ?? null) : (data?.suggestedDevice ?? null);
  const suggestedCandidate = candidates.find((c) => c.device === suggestedId);

  const evictKey = (e: { service: string; modelRef: string }) => `${e.service}::${e.modelRef}`;
  const evictable = conflictForPick && pickedCandidate ? pickedCandidate.evictable : previewMatchesPick && data ? data.evictable : [];
  const pinned = previewMatchesPick && !conflictForPick && data ? data.pinned : [];

  const freedBytes = evictable.filter((e) => selected.has(evictKey(e))).reduce((sum, e) => sum + (e.bytes ?? 0), 0);
  const shortfallNow = conflictForPick
    ? (conflictForPick.shortfallBytes ?? pickedCandidate?.shortfallBytes ?? 0)
    : previewMatchesPick || !pickedCandidate
      ? (data?.shortfallBytes ?? 0)
      : pickedCandidate.shortfallBytes;
  const remainingShortfall = Math.max(0, shortfallNow - freedBytes);
  const fitsAfter = !data
    ? false
    : conflictForPick
      ? shortfallNow > 0 && remainingShortfall === 0
      : previewMatchesPick || !pickedCandidate
        ? data.fits || (data.refusal === 'OVER_BUDGET' && remainingShortfall === 0)
        : pickedCandidate.fits;
  const alreadyLoaded = !conflictForPick && data?.refusal === 'ALREADY_LOADED';
  const needsReason = !!data && !alreadyLoaded && !fitsAfter;
  /** OD-5 — need > the card's free memory outright: refused even with force (would OOM its card-mates). */
  const exceedsDevice = (conflictForPick?.code === 'EXCEEDS_DEVICE' || pickedCandidate?.exceedsDevice === true) && !fitsAfter;
  const forceBlocked = needsReason && exceedsDevice;
  const device = previewMatchesPick && data?.device ? catalogue.data?.devices.find((d) => d.id === data.device) : undefined;
  const armed = !needsReason || (!forceBlocked && reason.trim().length > 0);
  const pickedTitle = candidateTitle(pickedCandidate, picked ?? 'the device');

  function pick(next: string) {
    setPicked(next);
    setConflict(null);
    setSelected(new Set());
  }

  function placement(deviceId: string | null): Pick<LoadModelResidencyRequest, 'device' | 'makeDefault'> {
    if (!hasPicker || !deviceId) return {};
    return { device: deviceId, ...(makeDefault ? { makeDefault: true } : {}) };
  }

  /** A refusal with placement advice is shown as the capacity callout; anything else toasts the server's words. */
  function handleLoadError(error: unknown, unloaded: string[]) {
    const refused = asModelResidencyConflict(error);
    const done = unloaded.length > 0 ? ` Already unloaded: ${unloaded.join(', ')}.` : '';
    if (refused && CAPACITY_CODES.has(refused.code)) {
      setConflict(refused);
      if (refused.device && refused.device !== picked) setPicked(refused.device);
      setSelected(new Set());
      if (done) toast.error(`${refused.message || refused.code}${done}`);
      return;
    }
    toast.error(`${residencyErrorMessage(error, `Couldn't load ${model.name}.`)}${done}`);
  }

  async function confirm() {
    if (!data) return;
    setBusy(true);
    const unloaded: string[] = [];
    try {
      for (const e of evictable.filter((candidate) => selected.has(evictKey(candidate)))) {
        await unload.mutateAsync({ service: e.service, modelRef: e.modelRef, reason: `Make room for ${model.name}` });
        unloaded.push(e.name);
        toast.success(`Unloaded ${e.name}`);
        setSelected((current) => {
          const next = new Set(current);
          next.delete(evictKey(e));
          return next;
        });
        // The card changed under us: refresh the numbers before the load is sent.
        requestPreview({ service: service.service, modelRef: model.modelRef, ...(hasPicker && picked ? { device: picked } : {}) });
      }
      const body: LoadModelResidencyRequest = { service: service.service, modelRef: model.modelRef, ...placement(picked) };
      if (needsReason) {
        body.force = true;
        body.reason = reason.trim();
      }
      const response = await load.mutateAsync(body);
      onAdmitted(response);
      onOpenChange(false);
    } catch (error) {
      handleLoadError(error, unloaded);
    } finally {
      setBusy(false);
    }
  }

  /** "Load on <suggested GPU>" — un-forced, on the GPU the server said has room. */
  async function loadOn(deviceId: string) {
    setBusy(true);
    setPicked(deviceId);
    setConflict(null);
    try {
      const response = await load.mutateAsync({ service: service.service, modelRef: model.modelRef, ...placement(deviceId) });
      onAdmitted(response);
      onOpenChange(false);
    } catch (error) {
      handleLoadError(error, []);
    } finally {
      setBusy(false);
    }
  }

  /** TASK-1055 (AC-4) — the picked GPU cannot hold the model: say why in numbers and name the GPU that can. */
  function capacityCallout() {
    const need = formatBytes(data?.needBytes ?? null);
    const others = candidates.filter((c) => c.device !== picked);
    let advice: React.ReactNode = null;
    if (suggestedCandidate && suggestedCandidate.device !== picked && suggestedCandidate.fits) {
      const title = candidateTitle(suggestedCandidate, suggestedCandidate.device);
      advice = (
        <>
          {` ${title} has room.`}
          <span className="block pt-2">
            <Button size="sm" disabled={busy} onClick={() => void loadOn(suggestedCandidate.device)}>
              {busy ? <Spinner /> : null}
              Load on {title}
            </Button>
          </span>
        </>
      );
    } else if (suggestedCandidate && suggestedCandidate.device !== picked) {
      advice = ` No GPU has room; ${candidateTitle(suggestedCandidate, suggestedCandidate.device)} is the closest (short ${formatBytes(suggestedCandidate.shortfallBytes)}).`;
    } else if (others.length > 0 && !others.some((c) => c.fits)) {
      advice = ' No other GPU has room either.';
    }
    const detail = pickedCandidate
      ? `${pickedTitle} cannot hold this model — needs ${need}, ${formatBytes(freeAboveHeadroom(pickedCandidate))} free above headroom (short ${formatBytes(remainingShortfall || pickedCandidate.shortfallBytes)}).`
      : conflictForPick?.message || `${pickedTitle} cannot hold this model.`;
    return (
      <Callout tone="warn" role="alert" title={`${pickedTitle} does not have room`}>
        <p>
          {detail}
          {advice}
        </p>
      </Callout>
    );
  }
  function calloutFor(d: ModelResidencyLoadPreview) {
    if (!conflictForPick) {
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
      if (d.refusal === 'LOAD_IN_PROGRESS' || d.refusal === 'IN_FLIGHT')
        return (
          <Callout tone="warn" title={d.refusal === 'IN_FLIGHT' ? 'Serving requests right now' : 'Another load is in progress'}>
            {d.refusal === 'IN_FLIGHT'
              ? 'Replacing it would drop requests in flight; loading anyway needs a reason.'
              : 'Wait for the running load on this device to finish, or load anyway with a reason.'}
          </Callout>
        );
    }
    if (fitsAfter)
      return (
        <Callout
          tone="ok"
          title={`${selected.size > 0 ? 'Fits once the selected models are unloaded' : 'Fits'}${hasPicker && selected.size === 0 ? ` on ${pickedTitle}` : ''}`}
        >
          Within the card and its headroom.
        </Callout>
      );
    if (hasPicker || conflictForPick) return capacityCallout();
    return (
      <Callout tone="warn" title={`Does not fit — short by ${formatBytes(remainingShortfall)}`}>
        Loading now would push {device ? device.label.split('—')[0]?.trim() : 'the device'} past its limit.
      </Callout>
    );
  }

  const deviceLabel = hasPicker ? pickedTitle : device ? (device.label.split('—')[0]?.trim() ?? device.label) : (data?.device ?? 'Device');

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="shrink-0 border-b p-4">
          <DialogTitle>Load {model.name}</DialogTitle>
          <DialogDescription>{service.label}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {(preview.isPending || preview.isIdle) && !data ? (
            <PreviewSkeleton />
          ) : !data ? (
            <Callout tone="warn" title="Couldn't check placement">
              The dry run failed. Close this dialog and try again.
            </Callout>
          ) : (
            <div className="flex flex-col gap-5">
              {hasPicker ? (
                <PlacementPicker
                  candidates={candidates}
                  picked={picked}
                  suggestedDevice={suggestedId}
                  suggestionReason={conflictForPick ? null : data.suggestionReason}
                  needBytes={data.needBytes}
                  disabled={busy}
                  onPick={pick}
                />
              ) : null}
              {hasPicker && picked ? (
                <div className="flex items-start gap-2">
                  <Checkbox
                    id="lp-make-default"
                    checked={makeDefault}
                    disabled={busy}
                    onCheckedChange={(checked) => setMakeDefault(checked === true)}
                  />
                  <Label htmlFor="lp-make-default" className="flex flex-col gap-0.5 font-normal">
                    <span>Make this the model&rsquo;s default GPU</span>
                    <span className="text-muted-foreground text-xs">Used at boot and by the residency controller, not just for this load.</span>
                  </Label>
                </div>
              ) : null}
              {previewPending ? (
                <p className="text-muted-foreground text-sm" aria-live="polite">
                  Checking {pickedTitle}…
                </p>
              ) : preview.isError ? (
                <p className="text-destructive text-sm" role="alert">
                  Couldn&rsquo;t re-check {pickedTitle}; the figures below may be out of date.
                </p>
              ) : null}
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
                <dd>{formatBytes(previewMatchesPick && !conflictForPick ? data.freeBytes : (pickedCandidate?.freeBytes ?? data.freeBytes))}</dd>
                <dt className="text-muted-foreground">Headroom to keep</dt>
                <dd>
                  {formatBytes(previewMatchesPick && !conflictForPick ? data.headroomBytes : (pickedCandidate?.headroomBytes ?? data.headroomBytes))}
                </dd>
                <dt className="text-muted-foreground">Shortfall</dt>
                <dd>{formatBytes(remainingShortfall)}</dd>
              </dl>

              {evictable.length > 0 || pinned.length > 0 || (previewMatchesPick && (data.unattributedBytes ?? 0) > 0) ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">Make room on {deviceLabel}</legend>
                  {evictable.map((e) => {
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
                  {pinned.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {pinned.map((p) => (
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
                  {previewMatchesPick && (data.unattributedBytes ?? 0) > 0 ? (
                    <p className="text-muted-foreground text-xs">
                      {formatBytes(data.unattributedBytes)} is not attributed to any model (CUDA contexts and other pods on a time-sliced card).
                    </p>
                  ) : null}
                  {evictable.length > 0 && (data.refusal === 'OVER_BUDGET' || conflictForPick) ? (
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
                  {forceBlocked ? (
                    <p id="lp-force-blocked" className="text-sm">
                      Not possible on {pickedTitle}: the model needs more than the card has free at all, so a forced load would run its card-mates out
                      of memory. Pick another GPU or unload something there first.
                    </p>
                  ) : (
                    <>
                      <p className="text-muted-foreground text-sm">
                        There is no memory isolation on time-sliced cards: an out-of-memory error can take down other models on the same GPU.
                      </p>
                      <Label htmlFor="lp-force-reason">
                        Reason <span aria-hidden>*</span>
                        <span className="sr-only">(required, audited)</span>
                      </Label>
                      <Textarea
                        id="lp-force-reason"
                        aria-required="true"
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                        rows={2}
                        disabled={busy}
                      />
                    </>
                  )}
                </section>
              ) : null}
            </div>
          )}
        </div>
        <DialogFooter className="shrink-0 items-center border-t p-4 sm:justify-end">
          {needsReason && !armed ? (
            <span className="text-muted-foreground mr-auto text-xs">
              {forceBlocked ? `Load anyway is refused on ${pickedTitle}` : 'Enter a reason to enable Load anyway'}
            </span>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {data && !alreadyLoaded ? (
            <Button
              variant={needsReason ? 'destructive' : 'default'}
              disabled={!armed || busy || previewPending}
              aria-describedby={forceBlocked ? 'lp-force-blocked' : undefined}
              onClick={() => void confirm()}
            >
              {busy ? <Spinner /> : null}
              {needsReason ? 'Load anyway' : 'Load'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
