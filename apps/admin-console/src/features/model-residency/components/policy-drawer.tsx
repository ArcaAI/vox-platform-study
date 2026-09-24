'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { useCreateResidencyPolicy, useUpdateResidencyPolicy } from '../api/hooks';
import type { ModelResidencyClass, ModelResidencyDevice, ModelResidencyModel } from '../api/types';

const NO_PREFERRED_DEVICE = '__none__';
const RESIDENCY_CLASSES: ModelResidencyClass[] = ['PINNED', 'WARM', 'ON_DEMAND'];

interface Draft {
  class: ModelResidencyClass;
  idleTtlSeconds: string;
  priority: string;
  maxInstances: string;
  preferredDevice: string;
}

function initialDraft(model: ModelResidencyModel): Draft {
  return {
    class: model.class,
    idleTtlSeconds: model.ttlSeconds === null ? '' : String(model.ttlSeconds),
    priority: '100',
    maxInstances: '1',
    preferredDevice: model.device || NO_PREFERRED_DEVICE,
  };
}

export interface PolicyDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ModelResidencyModel;
  devices: ModelResidencyDevice[];
}

/**
 * "Edit policy" (ticket §5.4) — the `ModelResidencyPolicy` row that decides
 * this model's class/TTL/priority/placement going forward. A row that has
 * never had an explicit policy (`policyId: null`, `classSource !== 'policy'`)
 * is CREATED here on first save; one that already has a row is PATCHed with
 * If-Match (`_version` carried on the row already — no extra GET needed).
 */
export function PolicyDrawer({ open, onOpenChange, model, devices }: PolicyDrawerProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(model));
  const create = useCreateResidencyPolicy();
  const update = useUpdateResidencyPolicy();
  const isPending = create.isPending || update.isPending;

  function patch(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function submit() {
    if (!model.aiModelId) return;
    const body = {
      class: draft.class,
      idleTtlSeconds: draft.idleTtlSeconds === '' ? null : Number(draft.idleTtlSeconds),
      priority: draft.priority === '' ? undefined : Number(draft.priority),
      maxInstances: draft.maxInstances === '' ? undefined : Number(draft.maxInstances),
      preferredDevice: draft.preferredDevice === NO_PREFERRED_DEVICE ? null : draft.preferredDevice,
    };
    const onSettled = {
      onSuccess: () => {
        toast.success(`Policy saved for ${model.service}/${model.modelRef}.`);
        onOpenChange(false);
      },
      onError: () => toast.error(`Couldn't save the policy for ${model.service}/${model.modelRef}.`),
    };
    if (model.policyId && model.policyVersion !== null) {
      update.mutate({ id: model.policyId, patch: body, expectedVersion: model.policyVersion }, onSettled);
    } else {
      create.mutate({ aiModelId: model.aiModelId, service: model.service, ...body }, onSettled);
    }
  }

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={`Residency policy — ${model.modelRef}`}
      badges={<Badge variant="outline">{model.service}</Badge>}
      meta={
        <span>
          {model.policyId ? `Editing policy row (v${model.policyVersion})` : 'No explicit policy yet — saving creates one'} &middot; class source:{' '}
          {model.classSource}
        </span>
      }
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Close
          </Button>
          <Button onClick={submit} disabled={isPending || !model.aiModelId}>
            {isPending ? <Spinner /> : null}
            Save policy
          </Button>
        </div>
      }
    >
      {!model.aiModelId ? (
        <p className="text-muted-foreground text-sm">This instance is not resolved to a catalogue AI model, so it cannot carry a residency policy.</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="residency-class">Class</Label>
          <NativeSelect id="residency-class" value={draft.class} onChange={(event) => patch({ class: event.target.value as ModelResidencyClass })}>
            {RESIDENCY_CLASSES.map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <span className="text-muted-foreground text-xs">PINNED never evicts. ON_DEMAND follows the idle TTL below.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="residency-ttl">Idle TTL (seconds)</Label>
          <Input
            id="residency-ttl"
            type="number"
            inputMode="numeric"
            min={0}
            value={draft.idleTtlSeconds}
            onChange={(event) => patch({ idleTtlSeconds: event.target.value })}
            className="font-mono"
          />
          <span className="text-muted-foreground text-xs">Blank inherits the service&rsquo;s own default TTL.</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="residency-priority">Priority</Label>
          <Input
            id="residency-priority"
            type="number"
            inputMode="numeric"
            value={draft.priority}
            onChange={(event) => patch({ priority: event.target.value })}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="residency-max-instances">Max instances</Label>
          <Input
            id="residency-max-instances"
            type="number"
            inputMode="numeric"
            min={1}
            value={draft.maxInstances}
            onChange={(event) => patch({ maxInstances: event.target.value })}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="residency-preferred-device">Preferred device</Label>
          <NativeSelect
            id="residency-preferred-device"
            value={draft.preferredDevice}
            onChange={(event) => patch({ preferredDevice: event.target.value })}
          >
            <NativeSelectOption value={NO_PREFERRED_DEVICE}>No preference</NativeSelectOption>
            {devices.map((device) => (
              <NativeSelectOption key={device.id} value={device.id}>
                {device.name} ({device.id})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
    </DetailDrawer>
  );
}
