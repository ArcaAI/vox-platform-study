'use client';

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
import type { HoldResolution } from '@arcaai/types';
import { GuardrailCheckList } from '@/shared/guardrail/guardrail-check-list';
import { guardrailNoticeCopy, type GuardrailNotice } from '@/shared/guardrail/notice';

const ACTION_LABELS: Record<HoldResolution, string> = {
  item_excluded: 'Exclude the flagged content, resolve & sign',
  acknowledged: 'Override once, resolve & sign',
  item_edited: 'Resolve & sign',
};

/**
 * TASK-1050 W3b round 2 — OD-24 (README §9.8.3): an INBOUND guardrail hold can be resolved and the
 * note signed in ONE action (`approve` with `resolveHold` + `acknowledgeGuardrailNotices`). The step
 * shows the hold and any outstanding warnings, and offers only the resolutions the hold allows — the
 * locked medical check never offers the override.
 */
export function ResolveAndSignDialog({
  open,
  onOpenChange,
  hold,
  resolutions,
  warnings,
  onResolveAndSign,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hold: GuardrailNotice;
  resolutions: readonly HoldResolution[];
  warnings: readonly GuardrailNotice[];
  onResolveAndSign: (resolution: HoldResolution) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="flex max-h-[70vh] flex-col">
        <AlertDialogHeader>
          <AlertDialogTitle>Resolve the safety hold and sign</AlertDialogTitle>
          <AlertDialogDescription>
            A safety check stopped part of the input. Choose how to resolve it; the hold is resolved and the note signed in one step, and every
            outstanding warning is acknowledged on the approval.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="flex flex-col gap-1.5 rounded-md border p-3">
            <p className="text-sm">{guardrailNoticeCopy(hold)}</p>
            <GuardrailCheckList checks={hold.checks} />
          </div>
          {warnings.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {warnings.length === 1
                ? '1 outstanding warning will be acknowledged.'
                : `${warnings.length} outstanding warnings will be acknowledged.`}
            </p>
          ) : null}
        </div>
        <AlertDialogFooter className="flex-wrap">
          <AlertDialogCancel>Back to the note</AlertDialogCancel>
          {resolutions.map((resolution) => (
            <Button
              key={resolution}
              type="button"
              variant={resolution === 'item_excluded' ? 'default' : 'outline'}
              onClick={() => onResolveAndSign(resolution)}
            >
              {ACTION_LABELS[resolution]}
            </Button>
          ))}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
