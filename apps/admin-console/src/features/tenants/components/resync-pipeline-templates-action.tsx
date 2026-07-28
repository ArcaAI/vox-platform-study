'use client';

import { useState } from 'react';
import { IconRefresh } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { GatewayError } from '@/shared/api';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { useSession } from '@/shared/auth';
import { useResyncTenantPipelineTemplates } from '../api/hooks';
import type { Tenant } from '../api/types';

/**
 * "Resync pipeline templates" on the tenant detail header.
 *
 * Reconciles the tenant's ASR pipeline catalog against the 9 SYSTEM templates:
 * templates the tenant never received are cloned in, and pristine locked copies
 * are fast-forwarded to the template's current config. Customized (unlocked)
 * pipelines are never touched, and re-running is a no-op.
 *
 * Confirm-gated because it mutates another tenant's data, and gated on the
 * elevated session because the endpoint is `manage:Tenant` (global admin) —
 * showing a button that can only 403 is worse than not showing it.
 */
export function ResyncPipelineTemplatesAction({ tenant }: { tenant: Tenant }) {
  const session = useSession();
  const resync = useResyncTenantPipelineTemplates();
  const [confirming, setConfirming] = useState(false);

  if (!session.data?.isElevated) return null;

  function handleConfirm() {
    resync.mutate(tenant.id, {
      onSuccess: (summary) => {
        setConfirming(false);
        const { added, fastForwarded, skipped } = summary;
        if (added === 0 && fastForwarded === 0) {
          toast.success(`${tenant.name} is already up to date with the SYSTEM templates`);
          return;
        }
        toast.success(`Resynced ${tenant.name}: ${added} added, ${fastForwarded} updated, ${skipped} left unchanged`);
      },
      onError: (error) => toast.error(error instanceof GatewayError ? error.message : 'Could not resync the pipeline templates.'),
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setConfirming(true)}>
        <IconRefresh aria-hidden />
        Resync pipeline templates
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={`Resync pipeline templates for ${tenant.name}?`}
        description="Adds any SYSTEM templates this tenant is missing and updates its unmodified template copies to the current configuration. Pipelines the tenant has customized are left untouched."
        confirmLabel="Resync templates"
        isPending={resync.isPending}
        onConfirm={handleConfirm}
      />
    </>
  );
}
