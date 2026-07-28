'use client';

import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { useUpdateSchedulerCron } from '../api/hooks';
import type { SchedulerInfo } from '../api/types';
import { toastRequestError } from './toasts';

/** Frame 17.1 "Edit cron": PATCH /admin/schedulers/:name/cron. */
export function EditCronDialog({ scheduler, onOpenChange }: { scheduler: SchedulerInfo | null; onOpenChange: (open: boolean) => void }) {
  const inputId = useId();
  const updateCron = useUpdateSchedulerCron();
  const [draft, setDraft] = useState('');
  const [lastName, setLastName] = useState<string | null>(null);

  // Render-time derived-state reset (FilterSearch pattern): re-seed the
  // draft whenever the dialog targets a different scheduler.
  if (scheduler && scheduler.name !== lastName) {
    setLastName(scheduler.name);
    setDraft(scheduler.cronExpression ?? '');
  }

  function handleOpenChange(next: boolean) {
    if (!next) setLastName(null);
    onOpenChange(next);
  }

  function save() {
    if (!scheduler || !draft.trim()) return;
    updateCron.mutate(
      { name: scheduler.name, cronExpression: draft.trim() },
      {
        onSuccess: () => {
          toast.success(`Cron for ${scheduler.name} updated`);
          handleOpenChange(false);
        },
        onError: toastRequestError,
      },
    );
  }

  return (
    <Dialog open={scheduler !== null} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit cron {scheduler ? `for ${scheduler.name}` : ''}</DialogTitle>
          <DialogDescription>
            The new expression takes effect on the next scheduler tick.
            {scheduler?.timeZone ? ` Time zone: ${scheduler.timeZone}.` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor={inputId}>Cron expression</Label>
          <Input
            id={inputId}
            className="font-mono"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="0 3 * * *"
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={updateCron.isPending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!draft.trim() || updateCron.isPending} onClick={save}>
            {updateCron.isPending ? <Spinner /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
