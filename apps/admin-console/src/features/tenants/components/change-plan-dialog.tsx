'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import { useUpdateTenant } from '../api/hooks';
import type { Tenant, TenantPlan } from '../api/types';
import { PLAN_LABELS } from './plan-badge';

const PLAN_CHOICES: Array<{ value: TenantPlan; hint: string }> = [
  { value: 'STARTER', hint: 'Small practices' },
  { value: 'TRIAL', hint: 'Time-boxed evaluation' },
  { value: 'PRO', hint: 'Multi-department organizations' },
  { value: 'ENTERPRISE', hint: 'Full platform capabilities' },
];

function errorMessage(error: unknown): string {
  if (error instanceof GatewayError) {
    // The OCC contract: the row moved under us, so the version we read is stale.
    if (error.status === 412) return 'This tenant changed while you were editing. Reload and try again.';
    // The plan field is SUPER_ADMIN-only in the gateway (TASK-986 / D-1).
    if (error.status === 403) return 'Only a platform administrator can change a tenant plan.';
    return error.message;
  }
  return 'Could not change the plan.';
}

/**
 * TASK-986 W2 (R1) — the console's ONE plan editor, on the tenant detail
 * screen (owner decision D-2: one authoritative editor per backend resource,
 * rule 13). `PATCH /admin/tenants/:id` already accepted `plan`; nothing in the
 * console ever sent it, so `useUpdateTenant()`'s only caller was its own test.
 *
 * `etag` is the tenant detail ETag from `useTenant`; the API client derives the
 * body's `expectedVersion` from it and sends it as `If-Match` (428 when
 * missing, 412 on drift).
 */
export function ChangePlanDialog({
  tenant,
  etag,
  open,
  onOpenChange,
}: {
  tenant: Tenant;
  etag: string | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const updateTenant = useUpdateTenant();
  const [plan, setPlan] = useState<TenantPlan>(tenant.plan ?? 'STARTER');

  function handleOpenChange(next: boolean) {
    if (!next) {
      setPlan(tenant.plan ?? 'STARTER');
      updateTenant.reset();
    }
    onOpenChange(next);
  }

  function handleSubmit() {
    if (!etag) {
      toast.error('The tenant version is unknown — reload the page and try again.');
      return;
    }
    updateTenant.mutate(
      { id: tenant.id, patch: { plan }, etag },
      {
        onSuccess: () => {
          toast.success(`Plan changed to ${PLAN_LABELS[plan]}`);
          handleOpenChange(false);
        },
        onError: (error) => toast.error(errorMessage(error)),
      },
    );
  }

  const unchanged = plan === (tenant.plan ?? null);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>
            {`Sets the commercial plan for ${tenant.name}. Entitlement limits follow the plan; existing resources over a lower plan's quota are not disabled here.`}
          </DialogDescription>
        </DialogHeader>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">
            Plan{' '}
            <span aria-hidden className="text-destructive">
              *
            </span>
          </legend>
          {PLAN_CHOICES.map((choice) => (
            <label
              key={choice.value}
              className="border-input has-[:checked]:border-primary has-[:checked]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-md border p-3"
            >
              <input
                type="radio"
                name="tenant-plan"
                value={choice.value}
                checked={plan === choice.value}
                onChange={() => setPlan(choice.value)}
                className="accent-primary mt-0.5"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium">{PLAN_LABELS[choice.value]}</span>
                <span className="text-muted-foreground text-xs">{choice.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {unchanged ? <p className="text-muted-foreground text-xs">{`${tenant.name} is already on this plan.`}</p> : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={unchanged || updateTenant.isPending}>
            {updateTenant.isPending ? <Spinner /> : null}
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
