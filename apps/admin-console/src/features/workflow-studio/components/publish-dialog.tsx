'use client';

/**
 * `PublishDialog` (TASK-719 Task 15) — a SHORT confirmation dialog (rule 11 §1: dialogs stay
 * for short confirmations and break-glass step-up, not record detail). Publish is a destructive,
 * effectively-irreversible action (the published row becomes immutable — design.md §Plane 1),
 * so it gets an explicit confirm step per rule 11 §5.
 */
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Field, FieldContent, FieldDescription, FieldLabel, Switch } from '@arcaai/ui';
import { useState } from 'react';

export interface PublishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (activate: boolean) => void;
  confirming?: boolean;
}

export function PublishDialog({ open, onOpenChange, onConfirm, confirming }: PublishDialogProps) {
  const [activate, setActivate] = useState(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this version?</DialogTitle>
          <DialogDescription>
            Publishing compiles the graph and freezes this version — it can no longer be edited. Further changes create a new version.
          </DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="publish-activate">Make this the active version</FieldLabel>
            <FieldDescription>New runs resolve this version immediately, demoting the current active version.</FieldDescription>
          </FieldContent>
          <Switch id="publish-activate" checked={activate} onCheckedChange={setActivate} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            Cancel
          </Button>
          <Button type="button" onClick={() => onConfirm(activate)} disabled={confirming}>
            {confirming ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
