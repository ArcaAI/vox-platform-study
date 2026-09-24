'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { useLoadModel } from '../api/hooks';
import { asModelResidencyConflict, type LoadModelRequest } from '../api/types';

/** The four services the owner asked to control load/unload/lifetime for
 *  (ticket §1): stt, nlp, text generation, and LM Studio. */
const SERVICES = ['stt', 'text', 'nlp', 'lm-studio'] as const;

interface Draft {
  service: (typeof SERVICES)[number];
  modelRef: string;
  pin: boolean;
  contextLength: string;
  flashAttention: boolean;
}

const INITIAL_DRAFT: Draft = { service: 'stt', modelRef: '', pin: false, contextLength: '', flashAttention: false };

export interface LoadModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired once the load is ADMITTED (202/200) so the screen can start polling. */
  onLoadStarted: (operationId: string | null) => void;
}

/**
 * The primary "Load model" header action (ticket §5.4). A row action does not
 * fit here — the residency GET lists only RESIDENT models, so bringing a new
 * one up needs its own entry point regardless of which row (if any) is
 * selected on the table.
 */
export function LoadModelDialog({ open, onOpenChange, onLoadStarted }: LoadModelDialogProps) {
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);
  const [overBudget, setOverBudget] = useState(false);
  const [reason, setReason] = useState('');
  const load = useLoadModel();

  function patch(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  function reset() {
    setDraft(INITIAL_DRAFT);
    setOverBudget(false);
    setReason('');
  }

  function submit(force: boolean) {
    if (draft.modelRef.trim().length === 0) return;
    const body: LoadModelRequest = {
      service: draft.service,
      modelRef: draft.modelRef.trim(),
      pin: draft.pin,
      force,
      reason: force ? reason : undefined,
      ...(draft.service === 'lm-studio'
        ? {
            options: {
              ...(draft.contextLength !== '' ? { contextLength: Number(draft.contextLength) } : {}),
              flashAttention: draft.flashAttention,
            },
          }
        : {}),
    };
    load.mutate(body, {
      onSuccess: (response) => {
        toast.success(response.outcome === 'already_loaded' ? `${draft.modelRef} is already resident.` : `Loading ${draft.modelRef}…`);
        onLoadStarted(response.operationId ?? null);
        onOpenChange(false);
        reset();
      },
      onError: (error) => {
        const conflict = asModelResidencyConflict(error);
        if (conflict?.code === 'OVER_BUDGET') {
          setOverBudget(true);
          return;
        }
        toast.error(conflict?.message || `Couldn't load ${draft.modelRef}.`);
      },
    });
  }

  const armedForce = reason.trim().length > 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Load a model</DialogTitle>
          <DialogDescription>
            Brings a model up on the named service. A 5GB LLM on LM Studio can take ~100s — the load runs in the background.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="residency-load-service">Service</Label>
            <NativeSelect
              id="residency-load-service"
              value={draft.service}
              onChange={(event) => patch({ service: event.target.value as Draft['service'] })}
            >
              {SERVICES.map((service) => (
                <NativeSelectOption key={service} value={service}>
                  {service}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="residency-load-model-ref">Model</Label>
            <Input
              id="residency-load-model-ref"
              value={draft.modelRef}
              onChange={(event) => patch({ modelRef: event.target.value })}
              placeholder="e.g. gemma-4-e4b-it-qat@q4_0"
              className="font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="residency-load-pin" checked={draft.pin} onCheckedChange={(checked) => patch({ pin: checked === true })} />
            <Label htmlFor="residency-load-pin" className="font-normal">
              Pin once loaded
            </Label>
          </div>
          {draft.service === 'lm-studio' ? (
            <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="residency-load-context">Context length</Label>
                <Input
                  id="residency-load-context"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={draft.contextLength}
                  onChange={(event) => patch({ contextLength: event.target.value })}
                  className="font-mono"
                />
              </div>
              <div className="flex items-end gap-2 pb-1.5">
                <Checkbox
                  id="residency-load-flash"
                  checked={draft.flashAttention}
                  onCheckedChange={(checked) => patch({ flashAttention: checked === true })}
                />
                <Label htmlFor="residency-load-flash" className="font-normal">
                  Flash attention
                </Label>
              </div>
            </div>
          ) : null}
          {overBudget ? (
            <div role="alert" className="border-destructive/40 bg-destructive/10 flex flex-col gap-2 rounded-md border p-3 text-sm">
              <span className="text-destructive font-medium">Refused — over budget</span>
              <span>The controller refused this load against the measured free memory on the target device.</span>
              <Label htmlFor="residency-load-force-reason">Reason to force it anyway (required, audited)</Label>
              <Textarea id="residency-load-force-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={load.isPending}>
            Cancel
          </Button>
          {overBudget ? (
            <Button variant="destructive" disabled={!armedForce || load.isPending} onClick={() => submit(true)}>
              {load.isPending ? <Spinner /> : null}
              Force load
            </Button>
          ) : (
            <Button disabled={draft.modelRef.trim().length === 0 || load.isPending} onClick={() => submit(false)}>
              {load.isPending ? <Spinner /> : null}
              Load
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
