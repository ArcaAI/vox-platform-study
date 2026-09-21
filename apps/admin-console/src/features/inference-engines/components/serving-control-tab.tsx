'use client';

import { useState } from 'react';
import { IconPlugConnectedX } from '@tabler/icons-react';
import { toast } from 'sonner';
import type { AiModelServingProfile } from '@arcaai/types';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatBytes } from '@/shared/format';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useLmStudioRuntime, useLoadLmStudioModel, useUnloadLmStudioModel } from '../api/serving-hooks';
import { asVramBudgetConflict, type LmStudioDevice, type LmStudioLoadedModel, type LoadModelResponse } from '../api/serving-types';
import { BYTES_PER_MIB } from './serving-estimate';
import { ServingProfileDrawer } from './serving-profile-drawer';

/** One model row: the running instance when there is one, otherwise a catalogue entry. */
interface ServingRow {
  modelKey: string;
  loaded: LmStudioLoadedModel | undefined;
}

function mergeRows(loaded: LmStudioLoadedModel[], catalogueModelKeys: string[]): ServingRow[] {
  const rows: ServingRow[] = loaded.map((instance) => ({ modelKey: instance.modelKey, loaded: instance }));
  const seen = new Set(rows.map((row) => row.modelKey));
  for (const modelKey of catalogueModelKeys) {
    if (!seen.has(modelKey)) rows.push({ modelKey, loaded: undefined });
  }
  return rows;
}

function DeviceRow({ device }: { device: LmStudioDevice }) {
  const percent = device.totalMib > 0 ? Math.round((device.usedMib / device.totalMib) * 100) : 0;
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">
          GPU {device.index} — {device.name}
        </span>
        <span className="text-muted-foreground font-mono text-xs">
          {formatBytes(device.usedMib * BYTES_PER_MIB)} used · {formatBytes(device.freeMib * BYTES_PER_MIB)} free of{' '}
          {formatBytes(device.totalMib * BYTES_PER_MIB)}
        </span>
      </div>
      <Progress value={percent} aria-label={`GPU ${device.index} memory used`} />
    </li>
  );
}

function profileSummary(profile: AiModelServingProfile): string {
  const parts: string[] = [];
  if (profile.contextLength !== undefined) parts.push(`${profile.contextLength} ctx`);
  if (profile.parallel !== undefined) parts.push(`${profile.parallel} parallel`);
  if (profile.flashAttention !== undefined) parts.push(`flash attention ${profile.flashAttention ? 'on' : 'off'}`);
  if (profile.kvCacheQuant?.k || profile.kvCacheQuant?.v) parts.push(`KV ${profile.kvCacheQuant.k ?? '—'}/${profile.kvCacheQuant.v ?? '—'}`);
  if (profile.gpuSplit?.strategy) parts.push(`split ${profile.gpuSplit.strategy}`);
  if (profile.gpuSplit?.disabledGpus?.length) parts.push(`GPU ${profile.gpuSplit.disabledGpus.join(',')} disabled`);
  return parts.length > 0 ? parts.join(' · ') : 'No opinion — the platform default applies';
}

function TabSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-5 w-72 max-w-full rounded-full" />
          </div>
          <Skeleton className="h-8 w-40" />
        </div>
      ))}
    </div>
  );
}

export interface ServingControlTabProps {
  /**
   * Model keys the engine or the registry knows about, so a model that is not
   * currently loaded can still be brought up. The runtime read only reports
   * what is RESIDENT, which would make "load" reachable for nothing.
   */
  catalogueModelKeys: string[];
}

/**
 * Serving Control — the ONE surface in `/ai-services/*` that mutates the
 * workload (owner decision D-1). Every other tab on this screen, and every
 * other engine screen, remains strictly read-only.
 *
 * Three honesty constraints shape what is on this tab, and none of them is
 * decoration:
 *
 *  - Context, parallel, flash attention and GPU split are LOAD-TIME parameters.
 *    There is no live edit, so there is no Save — only "Apply & reload", behind
 *    a confirmation naming the in-flight generations it drops (D-2).
 *  - Unload is ADVISORY. JIT loading cannot be disabled on this build, so the
 *    next inference request loads the model again (§2.5). Saying "unloaded" and
 *    stopping there would be a statement that expires without notice.
 *  - VRAM exists per DEVICE and per MODEL, and not per thread — CUDA attributes
 *    memory to a process, and no layer below that exists in the driver, DCGM or
 *    NVML (D-5). The per-model KV figure is derived from context × parallel and
 *    is labelled as the estimate it is.
 */
export function ServingControlTab({ catalogueModelKeys }: ServingControlTabProps) {
  const runtime = useLmStudioRuntime();
  const load = useLoadLmStudioModel();
  const unload = useUnloadLmStudioModel();

  const [editing, setEditing] = useState<ServingRow | null>(null);
  const [unloading, setUnloading] = useState<LmStudioLoadedModel | null>(null);
  const [lastApplied, setLastApplied] = useState<LoadModelResponse | null>(null);

  if (runtime.isPending) return <TabSkeleton />;
  if (runtime.error) {
    return <ErrorState title="Couldn’t read the LM Studio runtime" error={runtime.error} onRetry={() => void runtime.refetch()} />;
  }

  const data = runtime.data!;

  // No engine, no controls. An "Unload" button that can only fail is worse than
  // an explanation of why there is nothing to press.
  if (!data.engine.reachable) {
    return (
      <EmptyState
        icon={IconPlugConnectedX}
        title="The engine did not answer"
        description="Serving control needs a live engine: loading, unloading and VRAM all come from the running daemon. Bring the deployment up through Argo CD, then probe again."
      />
    );
  }

  const rows = mergeRows(data.loaded, catalogueModelKeys);

  function applyProfile(profile: AiModelServingProfile) {
    const row = editing;
    if (!row) return;
    setLastApplied(null);
    load.mutate(
      { modelKey: row.modelKey, body: { profile } },
      {
        onSuccess: (result) => {
          setLastApplied(result);
          toast.success(`${row.modelKey} reloaded on the applied profile.`);
        },
        onError: (error) => {
          const conflict = asVramBudgetConflict(error);
          toast.error(
            conflict
              ? `Refused: ${formatBytes(conflict.estimateBytes)} estimated against ${formatBytes(conflict.freeBytes)} free.`
              : `Couldn’t reload ${row.modelKey}.`,
          );
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="gap-3 p-4">
        <h2 className="text-sm font-medium">GPU memory</h2>
        <ul className="flex flex-col gap-3" aria-label="GPU memory">
          {data.devices.map((device) => (
            <DeviceRow key={device.index} device={device} />
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          Per-thread VRAM is not shown here because it does not exist: CUDA attributes memory to a process and its contexts, and neither the
          driver, DCGM nor NVML accounts for anything below that. Device and model are the two granularities that are real.
        </p>
      </Card>

      <Card className="gap-3 p-4">
        <h2 className="text-sm font-medium">Models</h2>
        <p className="text-muted-foreground text-xs">
          Weights are measured. KV cache figures are derived from context × parallel — LM Studio gives every parallel slot the full context —
          so they are an estimate of residency, never a measurement of it.
        </p>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            The engine answered and is holding no model, and the registry lists none for it either. There is nothing to load — publish a model
            to this engine first.
          </p>
        ) : null}
        <ul className="flex flex-col">
          {rows.map((row) => (
            <li key={row.modelKey} className="flex flex-wrap items-center justify-between gap-3 border-b py-3 last:border-b-0">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate font-mono text-sm">{row.modelKey}</span>
                <span className="flex flex-wrap items-center gap-1.5">
                  {row.loaded ? (
                    <Badge variant={row.loaded.status === 'ACTIVE' ? 'default' : 'secondary'}>{row.loaded.status === 'ACTIVE' ? 'Active' : 'Idle'}</Badge>
                  ) : (
                    <Badge variant="outline">Not loaded</Badge>
                  )}
                  <span className="text-muted-foreground text-xs">{profileSummary(row.loaded?.effective ?? {})}</span>
                </span>
                {row.loaded ? (
                  <span className="text-muted-foreground font-mono text-xs">
                    {formatBytes(row.loaded.weightsBytes)} weights · KV cache (estimate) {formatBytes(row.loaded.kvCacheEstimateBytes)}
                  </span>
                ) : null}
                {row.loaded && row.loaded.identifier !== row.modelKey ? (
                  <span className="text-muted-foreground font-mono text-xs">instance {row.loaded.identifier}</span>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Serving profile for ${row.modelKey}`}
                  onClick={() => {
                    setLastApplied(null);
                    load.reset();
                    setEditing(row);
                  }}
                >
                  Serving profile
                </Button>
                {row.loaded ? (
                  <Button variant="outline" size="sm" aria-label={`Unload ${row.loaded.identifier}`} onClick={() => setUnloading(row.loaded!)}>
                    Unload
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="gap-2 p-4">
        <h2 className="text-sm font-medium">Platform default</h2>
        <span className="text-muted-foreground text-sm">{profileSummary(data.platformDefault)}</span>
        <p className="text-muted-foreground text-xs">
          What a model inherits when its own row states nothing. It is shared by every model with no opinion, so a change here reaches all of
          them at their next load.
        </p>
      </Card>

      {editing ? (
        <ServingProfileDrawer
          key={editing.modelKey}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null);
          }}
          modelKey={editing.modelKey}
          loaded={editing.loaded}
          devices={data.devices}
          platformDefault={data.platformDefault}
          isPending={load.isPending}
          onApply={applyProfile}
          result={lastApplied}
          error={load.error}
        />
      ) : null}

      <ConfirmDialog
        open={unloading !== null}
        onOpenChange={(next) => {
          if (!next) setUnloading(null);
        }}
        destructive
        title={unloading ? `Unload ${unloading.identifier}?` : 'Unload'}
        description="Unloading frees this model’s VRAM now and drops any generation it is serving."
        body={
          <p>
            It is advisory, not a stop: JIT loading cannot be disabled on this build, so the next inference request will load it again — on the
            JIT defaults, not on the profile it is running now.
          </p>
        }
        confirmLabel="Unload"
        isPending={unload.isPending}
        onConfirm={() => {
          const target = unloading;
          if (!target) return;
          setUnloading(null);
          unload.mutate(target.identifier, {
            onSuccess: () => toast.success(`${target.identifier} unloaded. The next inference request will JIT-load it again.`),
            onError: () => toast.error(`Couldn’t unload ${target.identifier}.`),
          });
        }}
      />
    </div>
  );
}
