'use client';

import { useState, type ReactNode } from 'react';
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
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';

export interface ForceActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  isPending: boolean;
  onConfirm: (reason: string) => void;
}

/**
 * The one reasoned-force confirmation both mutating actions need (owner
 * decision OD-3): a force-load refused 409 `OVER_BUDGET`, and a force-unload
 * of a model still serving requests (409 `IN_FLIGHT`). Both require a
 * non-empty, audited reason before the destructive button arms.
 */
export function ForceActionDialog({ open, onOpenChange, title, description, confirmLabel, isPending, onConfirm }: ForceActionDialogProps) {
  const [reason, setReason] = useState('');

  // Re-arm on every open/close transition, so a second forced action never inherits the first one's text.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setReason('');
  }

  const armed = reason.trim().length > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="residency-force-reason">Reason (required, audited)</Label>
          <Textarea id="residency-force-reason" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!armed || isPending} onClick={() => onConfirm(reason.trim())}>
            {isPending ? <Spinner /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
