'use client';

import { useMemo, useState } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES,
  AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES,
  AI_MODEL_SERVING_RANGES,
  type AiModelServingGpuSplit,
  type AiModelServingGpuSplitStrategy,
  type AiModelServingKvCacheQuant,
  type AiModelServingKvCacheQuantizationType,
  type AiModelServingProfile,
} from '@arcaai/types';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { formatBytes } from '@/shared/format';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { asVramBudgetConflict, type LmStudioDevice, type LmStudioLoadedModel, type LoadModelResponse, type ServingValueSource } from '../api/serving-types';
import { projectServingFootprint } from './serving-estimate';

/** Tri-state selects: an admin who means "inherit" must not silently write `false`. */
const INHERIT = 'inherit';

const SOURCE_LABEL: Record<ServingValueSource, string> = {
  request: 'This request',
  model: 'Model row',
  platform: 'Platform default',
};

interface Draft {
  contextLength: string;
  parallel: string;
  flashAttention: string;
  kCache: string;
  vCache: string;
  strategy: string;
  /** Device indices the admin has switched OFF for this model. */
  disabledGpus: number[];
}

function initialDraft(effective: AiModelServingProfile): Draft {
  return {
    contextLength: effective.contextLength === undefined ? '' : String(effective.contextLength),
    parallel: effective.parallel === undefined ? '' : String(effective.parallel),
    flashAttention: effective.flashAttention === undefined ? INHERIT : effective.flashAttention ? 'on' : 'off',
    kCache: effective.kvCacheQuant?.k ?? INHERIT,
    vCache: effective.kvCacheQuant?.v ?? INHERIT,
    strategy: effective.gpuSplit?.strategy ?? INHERIT,
    disabledGpus: effective.gpuSplit?.disabledGpus ?? [],
  };
}

/**
 * The draft as a SPARSE profile.
 *
 * Sparse on purpose: only what the admin actually stated travels in the
 * request, so the gateway's `sources` map can still answer "model row" or
 * "platform default" for everything else. Sending the resolved profile back
 * wholesale would stamp every value as `request` and flatten the cascade into
 * one tier the next reader could not see through.
 */
function toProfile(draft: Draft): AiModelServingProfile {
  const profile: AiModelServingProfile = {};
  const contextLength = Number(draft.contextLength);
  const parallel = Number(draft.parallel);
  if (draft.contextLength !== '' && Number.isFinite(contextLength)) profile.contextLength = contextLength;
  if (draft.parallel !== '' && Number.isFinite(parallel)) profile.parallel = parallel;
  if (draft.flashAttention !== INHERIT) profile.flashAttention = draft.flashAttention === 'on';

  const kvCacheQuant: AiModelServingKvCacheQuant = {};
  if (draft.kCache !== INHERIT) kvCacheQuant.k = draft.kCache as AiModelServingKvCacheQuantizationType;
  if (draft.vCache !== INHERIT) kvCacheQuant.v = draft.vCache as AiModelServingKvCacheQuantizationType;
  if (Object.keys(kvCacheQuant).length > 0) profile.kvCacheQuant = kvCacheQuant;

  const gpuSplit: AiModelServingGpuSplit = {};
  if (draft.strategy !== INHERIT) gpuSplit.strategy = draft.strategy as AiModelServingGpuSplitStrategy;
  if (draft.disabledGpus.length > 0) gpuSplit.disabledGpus = [...draft.disabledGpus].sort((a, b) => a - b);
  if (Object.keys(gpuSplit).length > 0) profile.gpuSplit = gpuSplit;

  return profile;
}

/** Out-of-range scalars, named per field. The gateway validates too; this is the earlier telling. */
function rangeProblems(draft: Draft): string[] {
  const problems: string[] = [];
  for (const [key, label] of [
    ['contextLength', 'Context length'],
    ['parallel', 'Parallel'],
  ] as const) {
    const raw = key === 'contextLength' ? draft.contextLength : draft.parallel;
    if (raw === '') continue;
    const range = AI_MODEL_SERVING_RANGES[key];
    const value = Number(raw);
    if (!Number.isFinite(value) || (range.integer && !Number.isInteger(value)) || value < range.min || value > range.max) {
      problems.push(`${label} must be a whole number between ${range.min} and ${range.max}.`);
    }
  }
  return problems;
}

export interface ServingProfileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelKey: string;
  /** The running instance, when this model has one. Absent = a cold load. */
  loaded: LmStudioLoadedModel | undefined;
  devices: LmStudioDevice[];
  platformDefault: AiModelServingProfile;
  isPending: boolean;
  onApply: (profile: AiModelServingProfile) => void;
  /** The last successful load — its `applied` values and which tier supplied each. */
  result: LoadModelResponse | null;
  error: unknown;
}

/**
 * The per-model serving-profile editor (ticket §4 Phase 5).
 *
 * Every field here is a LOAD-TIME parameter of llama.cpp, so there is no such
 * thing as saving one quietly: the model has to come down and go back up. The
 * drawer therefore has no "Save" — only "Apply & reload", behind a confirmation
 * that names what the reload costs (D-2).
 */
export function ServingProfileDrawer({
  open,
  onOpenChange,
  modelKey,
  loaded,
  devices,
  platformDefault,
  isPending,
  onApply,
  result,
  error,
}: ServingProfileDrawerProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(loaded?.effective ?? {}));
  const [confirmOpen, setConfirmOpen] = useState(false);

  const profile = useMemo(() => toProfile(draft), [draft]);
  const precheck = useMemo(() => projectServingFootprint({ loaded, draft: profile, devices }), [loaded, profile, devices]);
  const problems = rangeProblems(draft);
  const conflict = asVramBudgetConflict(error);

  function patch(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function toggleGpu(index: number, use: boolean) {
    setDraft((current) => ({
      ...current,
      disabledGpus: use ? current.disabledGpus.filter((entry) => entry !== index) : [...current.disabledGpus, index],
    }));
  }

  return (
    <>
      <DetailDrawer
        open={open}
        onOpenChange={onOpenChange}
        size="lg"
        title={`Serving profile — ${modelKey}`}
        badges={loaded ? <Badge variant={loaded.status === 'ACTIVE' ? 'default' : 'secondary'}>{loaded.status === 'ACTIVE' ? 'Active' : 'Idle'}</Badge> : <Badge variant="outline">Not loaded</Badge>}
        meta={
          <span>
            Every field below is applied when the model is LOADED. Changing one means an unload and a reload — there is no live edit.
          </span>
        }
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Close
            </Button>
            <Button onClick={() => setConfirmOpen(true)} disabled={isPending || problems.length > 0}>
              {isPending ? <Spinner /> : null}
              Apply &amp; reload
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {/* The precheck sits ABOVE the fields on purpose: it is the number the
              admin is deciding against, and D-6 asks for it before the action is
              armed rather than as a 409 afterwards. */}
          <section aria-labelledby="serving-precheck" className="flex flex-col gap-2 rounded-md border p-3">
            <h3 id="serving-precheck" className="text-sm font-medium">
              Projected VRAM
            </h3>
            {precheck.estimateBytes === null ? (
              <p className="text-muted-foreground text-sm">{precheck.unavailableReason}</p>
            ) : (
              <>
                <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Projected total</dt>
                  <dd className="font-mono">{formatBytes(precheck.estimateBytes)}</dd>
                  <dt className="text-muted-foreground">Free after reload</dt>
                  <dd className="font-mono">{formatBytes(precheck.headroomBytes)}</dd>
                  <dt className="text-muted-foreground">On GPUs</dt>
                  <dd className="font-mono">{precheck.eligibleDeviceIndexes.join(', ') || '—'}</dd>
                </dl>
                <p className="text-muted-foreground text-xs">
                  An estimate, not a measurement: weights are measured, the KV half is derived from context × parallel and projected onto this
                  profile. The headroom counts the VRAM this instance releases when the reload unloads it. The gateway runs its own precheck
                  against live VRAM and is the one that decides.
                </p>
              </>
            )}
            {precheck.overBudget ? (
              <p role="status" className="text-destructive flex items-start gap-2 text-sm">
                <IconAlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                This profile is projected at {formatBytes(precheck.estimateBytes)}, which exceeds the available VRAM on the selected GPUs (
                {formatBytes(precheck.headroomBytes)}). The gateway will refuse the load.
              </p>
            ) : null}
          </section>

          <section aria-labelledby="serving-fields" className="flex flex-col gap-3">
            <h3 id="serving-fields" className="text-sm font-medium">
              Load-time parameters
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serving-context">Context length</Label>
                <Input
                  id="serving-context"
                  type="number"
                  inputMode="numeric"
                  min={AI_MODEL_SERVING_RANGES.contextLength.min}
                  max={AI_MODEL_SERVING_RANGES.contextLength.max}
                  step={1}
                  value={draft.contextLength}
                  onChange={(event) => patch({ contextLength: event.target.value })}
                  className="font-mono"
                />
                <span className="text-muted-foreground text-xs">Blank inherits the platform default ({platformDefault.contextLength ?? 'engine default'}).</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serving-parallel">Parallel slots</Label>
                <Input
                  id="serving-parallel"
                  type="number"
                  inputMode="numeric"
                  min={AI_MODEL_SERVING_RANGES.parallel.min}
                  max={AI_MODEL_SERVING_RANGES.parallel.max}
                  step={1}
                  value={draft.parallel}
                  onChange={(event) => patch({ parallel: event.target.value })}
                  className="font-mono"
                />
                <span className="text-muted-foreground text-xs">Every slot gets the FULL context, so KV memory scales with the product of the two.</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serving-flash">Flash attention</Label>
                <NativeSelect id="serving-flash" value={draft.flashAttention} onChange={(event) => patch({ flashAttention: event.target.value })}>
                  <NativeSelectOption value={INHERIT}>Inherit</NativeSelectOption>
                  <NativeSelectOption value="on">On</NativeSelectOption>
                  <NativeSelectOption value="off">Off</NativeSelectOption>
                </NativeSelect>
                <span className="text-muted-foreground text-xs">Also the precondition for a quantized V-cache.</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serving-strategy">GPU split strategy</Label>
                <NativeSelect id="serving-strategy" value={draft.strategy} onChange={(event) => patch({ strategy: event.target.value })}>
                  <NativeSelectOption value={INHERIT}>Inherit</NativeSelectOption>
                  {AI_MODEL_SERVING_GPU_SPLIT_STRATEGIES.map((strategy) => (
                    <NativeSelectOption key={strategy} value={strategy}>
                      {strategy}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serving-kcache">KV cache — K</Label>
                <NativeSelect id="serving-kcache" value={draft.kCache} onChange={(event) => patch({ kCache: event.target.value })}>
                  <NativeSelectOption value={INHERIT}>Inherit</NativeSelectOption>
                  {AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES.map((type) => (
                    <NativeSelectOption key={type} value={type}>
                      {type}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="serving-vcache">KV cache — V</Label>
                <NativeSelect id="serving-vcache" value={draft.vCache} onChange={(event) => patch({ vCache: event.target.value })}>
                  <NativeSelectOption value={INHERIT}>Inherit</NativeSelectOption>
                  {AI_MODEL_SERVING_KV_CACHE_QUANTIZATION_TYPES.map((type) => (
                    <NativeSelectOption key={type} value={type}>
                      {type}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <span className="text-muted-foreground text-xs">Quantizing V requires flash attention on — llama.cpp refuses otherwise.</span>
              </div>
            </div>
          </section>

          <section aria-labelledby="serving-gpus" className="flex flex-col gap-2">
            <h3 id="serving-gpus" className="text-sm font-medium">
              Devices this model may use
            </h3>
            <ul className="flex flex-col gap-2" aria-label="Devices this model may use">
              {devices.map((device) => (
                <li key={device.index} className="flex items-center gap-2">
                  <Checkbox
                    id={`serving-gpu-${device.index}`}
                    checked={!draft.disabledGpus.includes(device.index)}
                    onCheckedChange={(checked) => toggleGpu(device.index, checked === true)}
                  />
                  <Label htmlFor={`serving-gpu-${device.index}`} className="font-normal">
                    Use GPU {device.index} — {device.name} ({formatBytes(device.freeMib * 1024 * 1024)} free)
                  </Label>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              Unchecking a device sets `disabledGpus`, which is how a model is pinned to one card. The engine defaults to spreading a model
              evenly across every visible device even when it would fit on one.
            </p>
          </section>

          {problems.length > 0 ? (
            <ul className="text-destructive flex flex-col gap-1 text-sm" aria-label="Problems with this profile">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}

          {error && !isPending ? (
            <div role="alert" className="border-destructive/40 bg-destructive/10 flex flex-col gap-1 rounded-md border p-3 text-sm">
              <span className="text-destructive font-medium">The load was refused</span>
              {conflict ? (
                <span>
                  The engine has {formatBytes(conflict.freeBytes)} free and this profile was estimated at {formatBytes(conflict.estimateBytes)}.
                  Lower the context length or the parallel slots, or pin the model to a card with more headroom.
                </span>
              ) : (
                <span>{error instanceof Error ? error.message : 'The gateway rejected the load.'}</span>
              )}
            </div>
          ) : null}

          {result ? (
            <section aria-labelledby="serving-applied" className="flex flex-col gap-2 rounded-md border p-3">
              <h3 id="serving-applied" className="text-sm font-medium">
                Applied to {result.identifier}
              </h3>
              <ul className="flex flex-col gap-1 text-sm" aria-label="Where each applied value came from">
                {Object.entries(result.sources).map(([field, source]) => (
                  <li key={field} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{field}</span>
                    <Badge variant={source === 'request' ? 'default' : source === 'model' ? 'secondary' : 'outline'}>{SOURCE_LABEL[source]}</Badge>
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-xs">
                “Platform default” is shared with every model that states no opinion of its own; “Model row” travels with this model.
              </p>
            </section>
          ) : null}
        </div>
      </DetailDrawer>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        destructive
        title={`Reload ${modelKey} on this profile?`}
        description="Context, parallel slots, flash attention and GPU split are load-time parameters, so applying them restarts the model."
        body={
          <div className="flex flex-col gap-2">
            <p>
              The engine unloads this model and loads it again, which drops every generation in flight — including clinical summaries a
              clinician is waiting on. There is no drain and no live edit; this is the only way these values change.
            </p>
            {precheck.overBudget ? (
              <p className="text-destructive">
                This profile is also projected at {formatBytes(precheck.estimateBytes)} against {formatBytes(precheck.headroomBytes)} of
                headroom, so the gateway is expected to refuse it.
              </p>
            ) : null}
          </div>
        }
        confirmLabel="Unload & reload"
        isPending={isPending}
        onConfirm={() => {
          setConfirmOpen(false);
          onApply(profile);
        }}
      />
    </>
  );
}
