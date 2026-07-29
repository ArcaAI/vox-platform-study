'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { formatNumber } from '@/shared/format';
import { useCleanQueue } from '../api/hooks';
import type { CleanQueueRequest } from '../api/types';
import { toastRequestError } from './toasts';

type CleanStatus = CleanQueueRequest['status'];

/**
 * Destructive clean per frame 05: the API removes finished jobs of ONE state
 * (completed or failed), so the confirm carries a state selector.
 */
export function CleanQueueDialog({ queueName, open, onOpenChange }: { queueName: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [status, setStatus] = useState<CleanStatus>('completed');
  const cleanQueue = useCleanQueue();

  function handleOpenChange(next: boolean) {
    if (!next) setStatus('completed');
    onOpenChange(next);
  }

  function confirm() {
    cleanQueue.mutate(
      { queueName, body: { status, gracePeriodMs: 0 } },
      {
        onSuccess: (result) => {
          toast.success(`Removed ${formatNumber(result.count)} ${status} job${result.count === 1 ? '' : 's'} from ${queueName}`);
          handleOpenChange(false);
        },
        onError: toastRequestError,
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clean queue {queueName}</DialogTitle>
          <DialogDescription>Permanently removes finished jobs of the selected state from this queue. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="clean-queue-status">Job state to remove</Label>
          <Select value={status} onValueChange={(value) => setStatus(value as CleanStatus)}>
            <SelectTrigger id="clean-queue-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={cleanQueue.isPending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={cleanQueue.isPending} onClick={confirm}>
            {cleanQueue.isPending ? <Spinner /> : null}
            Clean queue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
