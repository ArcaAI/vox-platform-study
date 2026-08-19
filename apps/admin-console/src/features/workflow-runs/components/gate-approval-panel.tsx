'use client';

import { useState } from 'react';
import { IconGavel, IconShieldCheck } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Button } from '@arcaai/ui/components/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@arcaai/ui/components/shadcn/dialog';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useApproveRunGate, useRunGate } from '../api/hooks';
import type { WorkflowRun } from '../api/types';

/**
 * The clinician sign-off affordance for a run parked at its human-approval gate
 * (TASK-731 Phase B).
 *
 * **Why this reads live state instead of the run row.** `WorkflowRunStatus` has no "waiting on a
 * human" member — a run parked at its gate and a run busy generating text are both `RUNNING`. So
 * `useRunGate` asks the gate child workflow directly, and `waiting` is the ONLY field this
 * component keys the action off. A decided, abandoned or absent gate renders nothing at all: an
 * Approve button that cannot approve anything is worse than no button.
 *
 * **Why a confirmation step.** Signing is irreversible and attributable — the acting user is
 * recorded as the approving clinician on a WORM `GATE_DECISION` audit event. The dialog names
 * that consequence in the words a clinician would use, rather than asking them to confirm an
 * abstraction.
 *
 * The signer is NOT sent from here. It is resolved server-side from the authenticated user, by
 * construction: the request body has no field that could name a different clinician.
 */
export function GateApprovalPanel({ run }: { run: WorkflowRun }) {
  const gateQuery = useRunGate(run.runId, run.status);
  const approve = useApproveRunGate(run.runId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const gate = gateQuery.data;

  // Nothing to show until a gate exists AND is genuinely waiting. Deliberately silent while the
  // query is loading or errored: a transient harness blip must not flash a sign-off control.
  if (!gate?.exists || !gate.waiting) return null;

  const escalations = gate.escalations ?? 0;

  async function handleApprove() {
    try {
      await approve.mutateAsync({ decision: 'SIGNED' });
      toast.success('Signed. The run has been released.');
      setConfirmOpen(false);
    } catch (error) {
      // A gate that stopped waiting between render and click (a colleague signed it, or the SLA
      // ladder abandoned it) comes back as a 400 naming exactly that — surface it verbatim
      // rather than a generic failure, because "someone else already signed" is not an error the
      // clinician should have to investigate.
      toast.error(error instanceof GatewayError ? error.message : 'Could not release the gate.');
    }
  }

  return (
    <>
      <Alert>
        <IconGavel aria-hidden />
        <AlertTitle>Waiting for clinician sign-off</AlertTitle>
        <AlertDescription>
          <div className="flex w-full flex-col gap-3">
            <p>
              This run has produced a draft and is holding at its human-approval gate. Nothing further executes until it is signed.
              {escalations > 0 ? (
                <>
                  {' '}
                  <span className="text-warning-strong font-medium">
                    {escalations} SLA {escalations === 1 ? 'escalation has' : 'escalations have'} already been raised.
                  </span>
                </>
              ) : null}
            </p>
            <div>
              <Button type="button" size="sm" onClick={() => setConfirmOpen(true)} disabled={approve.isPending}>
                {approve.isPending ? <Spinner /> : <IconShieldCheck aria-hidden />}
                Review and sign
              </Button>
            </div>
          </div>
        </AlertDescription>
      </Alert>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign this note?</DialogTitle>
            <DialogDescription>
              You will be recorded as the approving clinician for <span className="font-medium">{run.definitionName}</span>. This is written to the
              permanent audit record and cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)} disabled={approve.isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void handleApprove()} disabled={approve.isPending}>
              {approve.isPending ? <Spinner /> : null}
              {approve.isPending ? 'Signing…' : 'Sign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
