'use client';

import type { MouseEvent } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@arcaai/ui/components/shadcn/alert-dialog';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GuardrailCheckList } from './guardrail-check-list';
import { guardrailDirectionShortLabel } from './labels';
import { guardrailNoticeCopy, mergeGuardrailNotices, type GuardrailNotice } from './notice';

/**
 * TASK-1050 W3b — the ONE modal of the guardrail UI (README OD-15): a warning on the FINAL note. Live
 * and partial summaries refresh every few seconds and get a toast + inline badge instead — a modal on
 * every refresh would trap the clinician. "Acknowledge and continue" acknowledges every listed notice in
 * one action; "Review later" keeps them open (approve acknowledges them anyway, README §9.8.3).
 */
export function GuardrailWarningDialog({
  open,
  onOpenChange,
  notices,
  onAcknowledge,
  pending = false,
  title = 'Safety warnings on the final note',
  description = 'The note was generated, and these checks flagged it. Review the note before you rely on it or sign it.',
  actionLabel = 'Acknowledge and continue',
  cancelLabel = 'Review later',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notices: readonly GuardrailNotice[];
  /** The notice ids to acknowledge. */
  onAcknowledge: (noticeIds: string[]) => void;
  pending?: boolean;
  title?: string;
  description?: string;
  actionLabel?: string;
  cancelLabel?: string;
}) {
  const list = mergeGuardrailNotices([], notices);
  function handleAcknowledge(event: MouseEvent<HTMLButtonElement>) {
    // Keep the dialog open until the caller settles (it closes it on success).
    event.preventDefault();
    onAcknowledge(list.map((notice) => notice.noticeId));
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="flex max-h-[70vh] flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {list.map((notice) => (
            <li key={notice.noticeId} className="flex flex-col gap-1.5 rounded-md border p-3">
              <p className="text-sm">{guardrailNoticeCopy(notice)}</p>
              <p className="text-muted-foreground text-xs">{`${guardrailDirectionShortLabel(notice.direction)} check`}</p>
              <GuardrailCheckList checks={notice.checks} />
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={handleAcknowledge}>
            {pending ? <Spinner /> : null}
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
