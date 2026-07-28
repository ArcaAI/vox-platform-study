'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { UseMutationResult } from '@tanstack/react-query';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { GatewayError } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import type { SetSttFallbackRequest, SttConfigRow, SttPipelineCandidate } from '../api';

export type SttRowMutation = UseMutationResult<
  WithEtag<SttConfigRow>,
  Error,
  { patch: Omit<SetSttFallbackRequest, 'expectedVersion'>; version: number }
>;

/** Radix Select cannot bind a null value; this sentinel maps to "no fallback". */
const NONE_VALUE = '__none__';

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * OCC save panel for the STT fallback row: the fallback pipeline pointer, the
 * error-triggered auto-switch toggle, and the consecutive-failure threshold.
 * Sparse write over the current row; saves send If-Match from the row version
 * (`0` on first create). A 412/428 keeps local drafts and offers reload-merge
 * (frame 08).
 */
export function SttFallbackForm({
  row,
  candidates,
  mutation,
  onReloadLatest,
}: {
  row: SttConfigRow;
  candidates: SttPipelineCandidate[];
  mutation: SttRowMutation;
  onReloadLatest: () => void;
}) {
  const uid = useId();
  const savedFallback = row.fallbackPipelineId ?? null;
  const savedAutoSwitch = row.autoSwitchEnabled;
  const savedThreshold = row.consecutiveFailureThreshold ?? 2;

  const [fallback, setFallback] = useState<string | null>(savedFallback);
  const [autoSwitch, setAutoSwitch] = useState<boolean>(savedAutoSwitch);
  const [threshold, setThreshold] = useState<string>(String(savedThreshold));

  // Sparse patch: only include a field when the draft differs from the row.
  const patch: Omit<SetSttFallbackRequest, 'expectedVersion'> = {};
  if (fallback !== savedFallback) patch.fallbackPipelineId = fallback;
  if (autoSwitch !== savedAutoSwitch) patch.autoSwitchEnabled = autoSwitch;
  const thresholdNumber = Number(threshold);
  if (Number.isInteger(thresholdNumber) && thresholdNumber !== savedThreshold) patch.consecutiveFailureThreshold = thresholdNumber;
  const dirty = Object.keys(patch).length > 0;

  // A saved pointer whose pipeline is no longer a candidate (disabled/deleted)
  // still needs to render in the Select — surface it as its own option.
  const options = [...candidates];
  if (fallback && !options.some((candidate) => candidate.id === fallback)) {
    options.push({ id: fallback, name: `${fallback} (unavailable)`, slug: fallback, isDefault: false, resourceStatus: 'UNKNOWN', tags: [] });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty) return;
    mutation.mutate(
      { patch, version: row.version },
      {
        onSuccess: () => toast.success('STT fallback config saved'),
        onError: (error) => {
          if (!isOccError(error)) toast.error(error.message);
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4" aria-label="STT fallback save panel">
      <Card className="gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-fallback`} className="text-muted-foreground text-xs font-medium">
            Fallback pipeline
          </Label>
          <Select value={fallback ?? NONE_VALUE} onValueChange={(next) => setFallback(next === NONE_VALUE ? null : next)}>
            <SelectTrigger id={`${uid}-fallback`} className="h-8 font-mono text-xs">
              <SelectValue placeholder="No fallback" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE} className="text-xs">
                No fallback
              </SelectItem>
              {options.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id} className="font-mono text-xs">
                  {candidate.name}
                  {candidate.isDefault ? ' · default' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">
            Cloud-engine-backed pipeline used on a classified outage. Only enabled, tenant-visible candidates are offered.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Switch id={`${uid}-auto`} checked={autoSwitch} onCheckedChange={setAutoSwitch} />
          <Label htmlFor={`${uid}-auto`} className="text-muted-foreground text-xs">
            Auto-switch on classified outage
          </Label>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${uid}-threshold`} className="text-muted-foreground text-xs font-medium">
            Consecutive failure threshold
          </Label>
          <Input
            id={`${uid}-threshold`}
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            step={1}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            className="h-8 w-24 font-mono text-xs"
          />
          <p className="text-muted-foreground text-xs">Consecutive utterance failures before an automatic switch (1&ndash;10).</p>
        </div>
      </Card>

      <OccConflictAlert
        error={mutation.error}
        onReload={() => {
          // Drafts stay in memory (reload-merge: no silent loss).
          mutation.reset();
          onReloadLatest();
        }}
      />
      <div className="flex flex-wrap items-center justify-end gap-3">
        {dirty ? <span className="text-muted-foreground text-sm">Unsaved changes</span> : null}
        <Button type="submit" disabled={!dirty || mutation.isPending}>
          {mutation.isPending ? <Spinner /> : null}
          Save &middot; If-Match
        </Button>
      </div>
    </form>
  );
}
