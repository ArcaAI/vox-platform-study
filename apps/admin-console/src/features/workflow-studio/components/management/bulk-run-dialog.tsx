'use client';

/**
 * TASK-1036 §3.3 / D-2 — the progress + per-item result list of a bulk run. It cannot be dismissed
 * while the run is in flight (the run is client-side, so closing the dialog would hide work still
 * being done); when it finishes the summary says how many failed and each lineage keeps its reason.
 */
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed } from '@tabler/icons-react';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';
import { BULK_ACTION_LABEL, type BulkAction, type BulkItem } from './lineage-bulk';

export interface BulkRun {
  action: BulkAction;
  items: BulkItem[];
  finished: boolean;
}

function ItemStatus({ item }: { item: BulkItem }) {
  if (item.status === 'running') {
    return (
      <span className="flex items-center gap-1 text-xs">
        <Spinner aria-hidden className="size-3" />
        Running…
      </span>
    );
  }
  if (item.status === 'done') {
    return (
      <span className="text-success flex items-start gap-1 text-xs">
        <IconCircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>Done — {item.message}</span>
      </span>
    );
  }
  if (item.status === 'failed') {
    return (
      <span className="text-destructive flex items-start gap-1 text-xs">
        <IconAlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span>Failed — {item.message}</span>
      </span>
    );
  }
  return (
    <span className="text-muted-foreground flex items-center gap-1 text-xs">
      <IconCircleDashed aria-hidden className="size-3.5" />
      Waiting
    </span>
  );
}

export function BulkRunDialog({ run, onClose }: { run: BulkRun | null; onClose: () => void }) {
  const items = run?.items ?? [];
  const settled = items.filter((item) => item.status === 'done' || item.status === 'failed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const label = run ? BULK_ACTION_LABEL[run.action] : '';

  return (
    <Dialog open={run !== null} onOpenChange={(next) => !next && run?.finished && onClose()}>
      <DialogContent className={DIALOG_SIZE_CLASS.md} onInteractOutside={(event) => !run?.finished && event.preventDefault()} onEscapeKeyDown={(event) => !run?.finished && event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {label} · {items.length} workflow{items.length === 1 ? '' : 's'}
          </DialogTitle>
          <DialogDescription>Each workflow is processed on its own, one after another; a failure never stops the rest.</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3">
          <Progress value={items.length === 0 ? 0 : (settled / items.length) * 100} aria-label={`${label} progress`} />
          <p className="text-sm" aria-live="polite">
            {run?.finished
              ? failed === 0
                ? `All ${items.length} succeeded.`
                : `${failed} of ${items.length} failed.`
              : `Processing ${Math.min(settled + 1, items.length)} of ${items.length}…`}
          </p>
          {/* tabIndex: a scrollable region must be keyboard-reachable on its own (WCAG 2.1.1). */}
          <ul tabIndex={0} className="focus-visible:ring-ring flex max-h-72 flex-col gap-2 overflow-y-auto rounded-md focus-visible:ring-2" aria-label="Per-workflow results">
            {items.map((item) => (
              <li key={item.slug} className="flex flex-col gap-0.5 rounded-md border p-2">
                <span className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-medium">{item.name}</span>
                  <span className="text-muted-foreground font-mono text-xs">{item.slug}</span>
                </span>
                <ItemStatus item={item} />
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter className="items-center">
          {run && !run.finished ? (
            <p id="bulk-run-close-reason" className="text-muted-foreground text-xs sm:mr-auto">
              Close is unavailable while the run is in progress.
            </p>
          ) : null}
          <Button onClick={onClose} disabled={!run?.finished} aria-describedby={run && !run.finished ? 'bulk-run-close-reason' : undefined}>
            {run?.finished ? 'Close' : 'Working…'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
