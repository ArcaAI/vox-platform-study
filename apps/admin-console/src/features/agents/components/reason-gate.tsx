'use client';

import { useState, type ReactNode } from 'react';
import { useActionConfirmation } from '@/shared/action-confirmations/use-action-confirmation';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';

interface PendingRequest {
  title: string;
  description: string;
  confirmLabel: string;
  run: (reason: string) => Promise<unknown>;
}

/**
 * TASK-1057 (owner decision OD-8) — assignment writes used to send a hard-coded reason. When the
 * platform marks the row REQUIRED the admin is asked for a real one (a policy-driven dialog);
 * otherwise the write runs straight away with `defaultReason`, exactly as before.
 */
export function useReasonGate(actionId: string, defaultReason: string): { request: (request: PendingRequest) => void; dialog: ReactNode } {
  const policy = useActionConfirmation(actionId);
  const [pending, setPending] = useState<PendingRequest | null>(null);
  const [busy, setBusy] = useState(false);

  function request(next: PendingRequest) {
    if (policy.isRequired()) setPending(next);
    else void next.run(defaultReason);
  }

  const dialog = pending ? (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) setPending(null);
      }}
      title={pending.title}
      description={pending.description}
      confirmLabel={pending.confirmLabel}
      reasonActionId={actionId}
      isPending={busy}
      onConfirm={async ({ reason }) => {
        setBusy(true);
        try {
          await pending.run(reason ?? defaultReason);
        } finally {
          setBusy(false);
          setPending(null);
        }
      }}
    />
  ) : null;

  return { request, dialog };
}
