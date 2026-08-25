'use client';

import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import { PURPOSE_META, useRevokeConsentGrant } from '../api';
import type { ConsentGrant } from '../api';

export interface RevokeConsentDialogProps {
  grant: ConsentGrant | null;
  onOpenChange: (open: boolean) => void;
  onRevoked?: () => void;
}

/**
 * Withdraw a consent grant.
 *
 * Revocation is never a delete — the row is kept and stamped, so the ledger
 * can show that consent existed and when it ended. The write is under RFC 7232
 * optimistic concurrency (`@RequiresIfMatch()`), so a stale row surfaces a 412
 * with an explicit "reload" instruction rather than silently clobbering a
 * concurrent revoke.
 */
export function RevokeConsentDialog({ grant, onOpenChange, onRevoked }: RevokeConsentDialogProps) {
  return (
    <Dialog open={Boolean(grant)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {grant ? (
          <RevokeForm
            key={grant.id}
            grant={grant}
            onCancel={() => onOpenChange(false)}
            onDone={() => {
              onOpenChange(false);
              onRevoked?.();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function RevokeForm({ grant, onCancel, onDone }: { grant: ConsentGrant; onCancel: () => void; onDone: () => void }) {
  const uid = useId();
  const [reason, setReason] = useState('');
  const [conflict, setConflict] = useState(false);
  const revokeMutation = useRevokeConsentGrant();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConflict(false);
    revokeMutation.mutate(
      { id: grant.id, body: reason.trim() ? { reason: reason.trim() } : {}, expectedVersion: grant.version },
      {
        onSuccess: () => {
          toast.success('Consent withdrawn — it takes effect immediately');
          onDone();
        },
        onError: (error) => {
          if (error instanceof GatewayError && error.isVersionConflict) {
            setConflict(true);
            return;
          }
          toast.error(error.message);
        },
      },
    );
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Withdraw consent?</DialogTitle>
        <DialogDescription>
          Blocks <span className="font-medium">{PURPOSE_META[grant.purpose].label}</span> for{' '}
          <span className="font-mono">{grant.externalPatientId}</span> from the next request onward. The grant is kept on record as withdrawn, not
          deleted.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${uid}-reason`}>Reason (optional)</Label>
        <Textarea
          id={`${uid}-reason`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          className="resize-none"
          placeholder="e.g. Patient withdrew consent by phone on 25 Aug"
        />
      </div>

      {conflict ? (
        <p role="alert" className="border-warning/40 bg-warning/10 rounded-md border px-3 py-2 text-sm">
          This grant changed since it was loaded — someone else may have already withdrawn it. Close this dialog and reload the register before trying
          again.
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={revokeMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={revokeMutation.isPending || conflict}>
          {revokeMutation.isPending ? <Spinner aria-hidden data-icon="inline-start" /> : null}
          Withdraw consent
        </Button>
      </DialogFooter>
    </form>
  );
}
