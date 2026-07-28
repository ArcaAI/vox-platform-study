'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useGenerateDnaReport } from '../api';

/**
 * Frame 33 generate flow entry: POST /generate/:doctorId returns a job id the
 * screen then tracks (SSE + poll). The doctor id prefills from the selected
 * grid row but stays editable so the first report of an empty tenant can be
 * queued too.
 */
export function GenerateReportDialog({
  open,
  onOpenChange,
  initialDoctorId,
  onQueued,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDoctorId: string;
  onQueued: (jobId: string) => void;
}) {
  const generate = useGenerateDnaReport();
  const [doctorId, setDoctorId] = useState(initialDoctorId);

  // Re-sync the prefill each time the dialog opens (render-time derived-
  // state reset, not an effect).
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) setDoctorId(initialDoctorId);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    generate.mutate(
      { doctorId: doctorId.trim() },
      {
        onSuccess: (job) => {
          onQueued(job.jobId);
          onOpenChange(false);
        },
        onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not queue the generation job.'),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate DNA report</DialogTitle>
          <DialogDescription>
            Queues a writing-style analysis for the doctor. Text samples are gathered from the {'doctor\u2019s'} context items; progress appears on
            the dashboard panel while the job runs.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="generate-doctor-id">
              Doctor ID
              <span aria-hidden className="text-destructive">
                *
              </span>
            </Label>
            <Input
              id="generate-doctor-id"
              value={doctorId}
              onChange={(event) => setDoctorId(event.target.value)}
              placeholder="Doctor UUID (a grid row prefills this)"
              className="font-mono"
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={generate.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={!doctorId.trim() || generate.isPending}>
              {generate.isPending ? <Spinner /> : null}
              Generate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
