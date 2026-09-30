'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { gatewayErrorCode } from '../api/errors';
import { useCancelModelDownload } from '../api/hooks';
import { JOB_NOT_ACTIVE, type CancelModelDownloadResponse } from '../api/types';

export interface CancelDownloadTarget {
  id: string;
  name: string;
}

function successMessage(name: string, removeRegistration: boolean, result: CancelModelDownloadResponse): string {
  const stopped = result.outcome === 'removed' ? 'was taken off the queue' : 'is being stopped';
  return removeRegistration ? `The download of ${name} ${stopped}; its registration is being removed.` : `The download of ${name} ${stopped}. Retry it from the model’s edit drawer.`;
}

/**
 * Confirms cancelling a model download (TASK-1023). The registration is KEPT by default — a cancelled download is
 * recoverable with Retry; removing the registration too is an explicit tick.
 */
export function CancelDownloadDialog({ target, open, onOpenChange }: { target: CancelDownloadTarget | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const uid = useId();
  const mutation = useCancelModelDownload();
  const [removeRegistration, setRemoveRegistration] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Every open starts from the safe default (keep the registration), whatever the last one left behind.
  const seedKey = open && target ? target.id : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    setRemoveRegistration(false);
    mutation.reset();
  }

  function confirm() {
    if (!target) return;
    mutation.mutate(
      { id: target.id, removeRegistration },
      {
        onSuccess: (result) => {
          toast.success(successMessage(target.name, removeRegistration, result));
          onOpenChange(false);
        },
        onError: (error) => {
          if (gatewayErrorCode(error) === JOB_NOT_ACTIVE) {
            toast.error(`The download of ${target.name} has already finished — nothing to cancel.`);
            onOpenChange(false);
          } else {
            toast.error(error.message);
          }
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel download</DialogTitle>
          <DialogDescription>
            Stops downloading <span className="text-foreground font-medium">{target?.name}</span> into the model bucket. Partial files are cleaned up.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-2">
          <Checkbox id={`${uid}-remove`} checked={removeRegistration} onCheckedChange={(checked) => setRemoveRegistration(checked === true)} />
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${uid}-remove`}>Also remove the registration</Label>
            <p className="text-muted-foreground text-xs">Otherwise the model stays in the registry as “Download cancelled” and you can retry it.</p>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Keep downloading
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner /> : null}
            Cancel download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
