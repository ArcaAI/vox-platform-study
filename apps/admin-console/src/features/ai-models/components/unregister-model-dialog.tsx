'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Checkbox } from '@arcaai/ui/components/shadcn/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { ErrorState } from '@/shared/state/error-state';
import { gatewayErrorCode } from '../api/errors';
import { useModelUsage, useUnregisterModel } from '../api/hooks';
import { MODEL_IN_USE, MODEL_UNLOAD_FAILED, type AiModel, type UnregisterModelResponse } from '../api/types';

const WEIGHTS_OUTCOME: Record<UnregisterModelResponse['weights'], string> = {
  deleting: 'its weights are being deleted from the bucket',
  'kept-shared': 'its weights were kept because another model shares them',
  kept: 'its weights were kept in the bucket',
};

/**
 * Replaces the row-only "Retire" (TASK-1019 OD-2/OD-3, D-10). Loads who still
 * references the model BEFORE offering the confirm: a referrer blocks it, with
 * the list shown and the reason stated beside the disabled button (rule 11 §5).
 * "Delete weights" defaults ON; "Purge all versions" defaults OFF because
 * without it the bucket keeps the old versions recoverable for 30 days.
 */
export function UnregisterModelDialog({ model, open, onOpenChange }: { model: AiModel | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const uid = useId();
  const usage = useModelUsage(model?.id ?? '', open && model !== null);
  const mutation = useUnregisterModel();
  const [deleteWeights, setDeleteWeights] = useState(true);
  const [purge, setPurge] = useState(false);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Every open starts from the safe defaults, whatever the last one left behind.
  const seedKey = open && model ? model.id : null;
  if (seedKey !== seededFor) {
    setSeededFor(seedKey);
    setDeleteWeights(true);
    setPurge(false);
    mutation.reset();
  }

  const referrers = usage.data?.referrers ?? [];
  const blocked = referrers.length > 0;
  const blockReason = usage.isPending
    ? 'Checking what still uses this model…'
    : usage.error
      ? 'Could not check what uses this model — retry before unregistering.'
      : blocked
        ? 'Remove or repoint these references first — the model cannot be unregistered while they exist.'
        : null;
  const reasonId = `${uid}-reason`;

  function confirm() {
    if (!model || blockReason) return;
    mutation.mutate(
      { id: model.id, deleteWeights, purge: deleteWeights && purge },
      {
        onSuccess: (result) => {
          toast.success(`${model.name} is being unregistered; ${WEIGHTS_OUTCOME[result.weights] ?? 'weights handled'}.`);
          onOpenChange(false);
        },
        onError: (error) => {
          const code = gatewayErrorCode(error);
          if (code === MODEL_IN_USE) {
            toast.error('Still in use — this model gained a reference. The list has been refreshed.');
            void usage.refetch();
          } else if (code === MODEL_UNLOAD_FAILED) {
            toast.error('A serving engine could not unload this model, so it was not unregistered. Try again in a moment.');
          } else {
            toast.error(error.message);
          }
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !mutation.isPending && onOpenChange(next)}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Unregister model</DialogTitle>
          <DialogDescription>
            Unregisters <span className="text-foreground font-medium">{model?.name}</span> (<span className="font-mono">{model?.slug}</span>) from the
            platform catalogue and unloads it from every serving engine.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {usage.isPending ? (
            <div role="status" className="flex flex-col gap-2" aria-label="Checking references">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : usage.error ? (
            <ErrorState error={usage.error} onRetry={() => void usage.refetch()} />
          ) : blocked ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Still used by ({referrers.length})</p>
              <ul aria-label="Referrers" className="flex flex-col gap-1 rounded-md border p-2 text-sm">
                {referrers.map((referrer) => (
                  <li key={`${referrer.kind}:${referrer.id}`} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-muted-foreground font-mono text-xs">{referrer.kind}</span>
                    <span className="font-medium">{referrer.name}</span>
                    <span className="text-muted-foreground font-mono text-xs">tenant {referrer.tenantId}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing references this model.</p>
          )}

          <div className="flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <Checkbox id={`${uid}-weights`} checked={deleteWeights} onCheckedChange={(checked) => setDeleteWeights(checked === true)} />
              <Label htmlFor={`${uid}-weights`}>Delete weights from the bucket</Label>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-start gap-2">
                <Checkbox
                  id={`${uid}-purge`}
                  checked={deleteWeights && purge}
                  disabled={!deleteWeights}
                  onCheckedChange={(checked) => setPurge(checked === true)}
                  aria-describedby={`${uid}-purge-help`}
                />
                <Label htmlFor={`${uid}-purge`}>Purge all versions now</Label>
              </div>
              <p id={`${uid}-purge-help`} className="text-muted-foreground pl-6 text-xs">
                Otherwise the deleted weights stay recoverable for 30 days.
                {!deleteWeights ? ' Only applies when the weights are deleted.' : ''}
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="sm:items-center">
          {blockReason ? (
            <p id={reasonId} className="text-muted-foreground mr-auto text-xs">
              {blockReason}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={confirm}
            disabled={mutation.isPending || blockReason !== null}
            aria-describedby={blockReason ? reasonId : undefined}
          >
            {mutation.isPending ? <Spinner /> : null}
            Unregister model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
