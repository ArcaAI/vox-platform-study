'use client';

import { useId, useState, type FormEvent } from 'react';
import { IconPencil, IconReceipt2 } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useRateLimitPlans, useSetRateLimitPlan } from '../api/hooks';
import type { RateLimitPlan, SetRateLimitPlanRequest } from '../api/types';

const TIERS = ['default', 'strict', 'heavy', 'relaxed'];

/**
 * A plan states its limit one of two ways, and which one is in force is the
 * thing an admin most needs to see at a glance.
 */
function planMode(plan: RateLimitPlan): 'absolute' | 'tier' {
  return plan.rateLimitPerMinute != null ? 'absolute' : 'tier';
}

function PlanDialog({
  plan,
  isPending,
  onOpenChange,
  onSave,
}: {
  plan: RateLimitPlan;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (body: SetRateLimitPlanRequest) => void;
}) {
  const uid = useId();
  const [mode, setMode] = useState<'absolute' | 'tier'>(planMode(plan));
  const [tier, setTier] = useState(plan.rateLimitTier);
  const [limit, setLimit] = useState(plan.rateLimitPerMinute != null ? String(plan.rateLimitPerMinute) : '100');
  const [windowMs, setWindowMs] = useState(plan.rateLimitWindowMs != null ? String(plan.rateLimitWindowMs) : '60000');

  const limitNum = Number(limit);
  const windowNum = Number(windowMs);
  const valid = mode === 'tier' || (Number.isInteger(limitNum) && limitNum >= 1 && Number.isInteger(windowNum) && windowNum >= 1);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onSave(
      mode === 'tier'
        ? // Clearing the absolute value is what makes the tier authoritative
          // again, so it must be sent explicitly as null rather than omitted.
          { rateLimitTier: tier, rateLimitPerMinute: null, rateLimitWindowMs: null, expectedVersion: plan.version }
        : { rateLimitPerMinute: limitNum, rateLimitWindowMs: windowNum, expectedVersion: plan.version },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col sm:max-w-[40rem]">
        <DialogHeader>
          <DialogTitle>{plan.plan} rate limit</DialogTitle>
          <DialogDescription>
            Applies to every tenant on this plan that has no rule and no override of its own. A tenant-scoped rule always wins over it.
          </DialogDescription>
        </DialogHeader>
        <form id={`${uid}-form`} onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <fieldset className="flex flex-col gap-3">
            <legend className="text-sm font-medium">How this plan states its limit</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={`${uid}-mode`} value="tier" checked={mode === 'tier'} onChange={() => setMode('tier')} />
              Named tier — inherits whatever that tier is set to
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name={`${uid}-mode`} value="absolute" checked={mode === 'absolute'} onChange={() => setMode('absolute')} />
              Absolute — this plan’s own requests per window
            </label>
          </fieldset>

          {mode === 'tier' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${uid}-tier`}>Tier</Label>
              <select
                id={`${uid}-tier`}
                value={tier}
                onChange={(event) => setTier(event.target.value)}
                className="border-input bg-background h-9 w-48 rounded-md border px-3 text-sm"
              >
                {TIERS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="text-muted-foreground text-sm">Tier baselines are edited on the Policy tab.</p>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-limit`}>Requests</Label>
                <Input id={`${uid}-limit`} value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="numeric" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${uid}-window`}>Window (ms)</Label>
                <Input id={`${uid}-window`} value={windowMs} onChange={(event) => setWindowMs(event.target.value)} inputMode="numeric" required />
              </div>
            </div>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${uid}-form`} disabled={!valid || isPending}>
            {isPending ? <Spinner /> : null}
            Save plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Plans tab (TASK-785 US-3) — rank 3 of the precedence chain.
 *
 * The rows live on `PlanEntitlement`, whose full CRUD is the entitlements
 * screen; this projects only the rate-limit fields. A super admin managing rate
 * limits should not have to know that one of the five levels happens to be
 * modelled as an entitlement.
 */
export function RateLimitPlansPanel() {
  const [editing, setEditing] = useState<RateLimitPlan | null>(null);
  const plansQuery = useRateLimitPlans();
  const mutation = useSetRateLimitPlan();

  if (plansQuery.isPending) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (plansQuery.error) return <ErrorState error={plansQuery.error} onRetry={() => void plansQuery.refetch()} />;

  const plans = plansQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm">
        Rank 3. Applied to every tenant subscribing to the plan, unless that tenant has a rule or an override of its own.
      </p>

      {plans.length === 0 ? (
        <EmptyState icon={IconReceipt2} title="No subscription plans" description="Plan entitlements have not been seeded for this environment." />
      ) : (
        <ul className="flex flex-col gap-2">
          {plans.map((plan) => (
            <li key={plan.id} className="bg-card flex flex-wrap items-center gap-3 rounded-md border p-3">
              <Badge>{plan.plan}</Badge>
              {planMode(plan) === 'absolute' ? (
                <>
                  <span className="font-mono text-sm">
                    {plan.rateLimitPerMinute} / {Math.round((plan.rateLimitWindowMs ?? 60_000) / 1000)}s
                  </span>
                  <Badge variant="secondary">Absolute</Badge>
                </>
              ) : (
                <>
                  <span className="font-mono text-sm">{plan.rateLimitTier}</span>
                  <Badge variant="outline">Named tier</Badge>
                </>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ms-auto"
                aria-label={`Edit ${plan.plan} rate limit`}
                onClick={() => setEditing(plan)}
              >
                <IconPencil aria-hidden />
                Edit
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <PlanDialog
          key={editing.id}
          plan={editing}
          isPending={mutation.isPending}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSave={(body) =>
            mutation.mutate(
              { plan: editing.plan, body },
              {
                onSuccess: () => {
                  toast.success(`${editing.plan} rate limit updated`);
                  setEditing(null);
                },
                onError: (error) => toast.error(error.message),
              },
            )
          }
        />
      ) : null}
    </div>
  );
}
