'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@arcaai/ui/components/shadcn/alert-dialog';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useSetPin } from '../api/hooks';
import type { ModelResidencyModel } from '../api/types';

export interface PinTtlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ModelResidencyModel | null;
}

/** Pin/Unpin and Set TTL are the SAME gateway route (`PUT .../pins`), so one dialog covers both row actions. */
export function PinTtlDialog({ open, onOpenChange, model }: PinTtlDialogProps) {
  const [pinned, setPinned] = useState(model?.adminPinned ?? false);
  const [ttlSeconds, setTtlSeconds] = useState(model?.ttlSeconds === null || model?.ttlSeconds === undefined ? '' : String(model.ttlSeconds));
  const mutation = useSetPin();

  // Re-seed the draft whenever a different model opens (open transitions from false->true, or the target row changes).
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const rowKey = model ? `${model.service}::${model.instance}` : null;
  if (open && rowKey !== seededFor) {
    setSeededFor(rowKey);
    setPinned(model?.adminPinned ?? false);
    setTtlSeconds(model?.ttlSeconds === null || model?.ttlSeconds === undefined ? '' : String(model.ttlSeconds));
  }

  if (!model) return null;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pin &amp; TTL — {model.modelRef}</AlertDialogTitle>
          <AlertDialogDescription>
            A pinned model is never evicted by the policy engine. TTL applies to an unpinned, idle model.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Checkbox id="residency-pin-pinned" checked={pinned} onCheckedChange={(checked) => setPinned(checked === true)} />
            <Label htmlFor="residency-pin-pinned" className="font-normal">
              Pinned
            </Label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="residency-pin-ttl">Idle TTL (seconds)</Label>
            <Input
              id="residency-pin-ttl"
              type="number"
              inputMode="numeric"
              min={0}
              value={ttlSeconds}
              onChange={(event) => setTtlSeconds(event.target.value)}
              disabled={pinned}
              className="font-mono"
            />
            <span className="text-muted-foreground text-xs">Blank inherits the service&rsquo;s own default TTL. Disabled while pinned.</span>
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <Button
            disabled={mutation.isPending}
            onClick={() =>
              mutation.mutate(
                { service: model.service, modelRef: model.modelRef, pinned, ttlSeconds: pinned || ttlSeconds === '' ? null : Number(ttlSeconds) },
                {
                  onSuccess: () => {
                    toast.success(`${model.modelRef} updated.`);
                    onOpenChange(false);
                  },
                  onError: () => toast.error(`Couldn't update ${model.modelRef}.`),
                },
              )
            }
          >
            {mutation.isPending ? <Spinner /> : null}
            Save
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
