'use client';

import { useId, useState } from 'react';
import { IconShieldCheck } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { useSession } from '@/shared/auth';
import { ErrorState } from '@/shared/state/error-state';
import { useGuardrailAvailability, useGuardrailPolicyCatalogue, useUpdateGuardrailAvailability } from '../api/hooks';
import { SYSTEM_TENANT_ID, type GuardrailAvailability, type GuardrailPolicyCatalogueEntry, type GuardrailPolicySelection } from '../api/types';

/** The editable draft: one entry per catalogue policy. */
type Draft = Record<string, GuardrailPolicySelection>;

/**
 * Seed the draft from the EFFECTIVE set, not the tenant's own.
 *
 * A tenant with no row shows what actually applies to it (the platform set) —
 * editing then starts from the truth rather than from an empty screen that
 * looks like "nothing is screened", which is the one thing that is never true.
 */
function toDraft(row: GuardrailAvailability, catalogue: GuardrailPolicyCatalogueEntry[]): Draft {
  const draft: Draft = {};
  for (const policy of catalogue) {
    const effective = row.effective[policy.id];
    draft[policy.id] = { enabled: effective?.enabled === true };
    if (policy.threshold) {
      const value = effective?.[policy.threshold.field];
      if (typeof value === 'number') draft[policy.id]![policy.threshold.field] = value;
    }
  }
  return draft;
}

/** The platform floor for a policy's threshold, read off the SYSTEM tier. */
function platformFloor(row: GuardrailAvailability, policy: GuardrailPolicyCatalogueEntry): number | null {
  if (!policy.threshold) return null;
  // When the tenant already has its own row, `effective` is the tenant's, so the
  // floor must come from somewhere else — the tenant's own row can never be its
  // own floor. The SYSTEM row is fetched separately by the gateway on write; the
  // client mirrors the rule using the effective value ONLY while inheriting.
  if (row.effectiveSourceTenantId !== SYSTEM_TENANT_ID) return null;
  const value = row.effective[policy.id]?.[policy.threshold.field];
  return typeof value === 'number' ? value : null;
}

/**
 * Mirror the gateway's two refusals so an admin is told BEFORE the round-trip.
 * The gateway stays authoritative: it re-checks both and answers 400/403.
 */
function refusalReason(draft: Draft, row: GuardrailAvailability, catalogue: GuardrailPolicyCatalogueEntry[]): string | null {
  const covered = new Set<string>();
  for (const policy of catalogue) {
    if (draft[policy.id]?.enabled) for (const direction of policy.directions) covered.add(direction);
  }
  const anyEnabled = catalogue.some((policy) => draft[policy.id]?.enabled);
  if (anyEnabled) {
    const missing = (['inbound', 'outbound'] as const).filter((direction) => !covered.has(direction));
    if (missing.length > 0) {
      return `${missing.join(' and ')} screening would have no check. Guardrail must gate every request before send and every response after receive — enable at least one policy per direction.`;
    }
  }
  for (const policy of catalogue) {
    if (!policy.threshold) continue;
    const value = draft[policy.id]?.[policy.threshold.field];
    const floor = platformFloor(row, policy);
    if (typeof value !== 'number' || floor === null) continue;
    const loosens = policy.threshold.floorDirection === 'lower-is-stricter' ? value > floor : value < floor;
    if (loosens) {
      return `${policy.label} would be looser than the platform floor (${floor}). A policy's strictness may only be tightened.`;
    }
  }
  return null;
}

function AvailabilitySkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-16 w-full" />
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-start justify-between gap-3 rounded-md border p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-full max-w-xl" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export function GuardrailAvailabilityTab() {
  const uid = useId();
  const session = useSession();
  const tenantId = session.data?.effectiveTenantId ?? null;

  const catalogueQuery = useGuardrailPolicyCatalogue();
  const availabilityQuery = useGuardrailAvailability(tenantId);
  const mutation = useUpdateGuardrailAvailability(tenantId);
  const [draft, setDraft] = useState<Draft | null>(null);

  if (catalogueQuery.isError || availabilityQuery.isError) {
    const query = catalogueQuery.isError ? catalogueQuery : availabilityQuery;
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const catalogue = catalogueQuery.data;
  const row = availabilityQuery.data;
  if (!catalogue || !row) return <AvailabilitySkeleton />;

  const saved = toDraft(row, catalogue);
  const current = draft ?? saved;
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const refusal = refusalReason(current, row, catalogue);
  const inheriting = row.effectiveSourceTenantId === SYSTEM_TENANT_ID && row.version === 0;

  function set(policyId: string, next: GuardrailPolicySelection) {
    setDraft({ ...current, [policyId]: next });
  }

  function handleSave() {
    if (!dirty || refusal) return;
    mutation.mutate(
      { body: { policies: current }, version: row!.version },
      {
        onSuccess: () => {
          toast.success('Guardrail availability saved');
          setDraft(null);
        },
        onError: (error) => {
          toast.error(error.message);
          setDraft(null);
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <IconShieldCheck aria-hidden />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          {inheriting ? 'Inheriting the platform default set' : 'Tenant-specific selection'}
          <Badge variant={inheriting ? 'outline' : 'default'} className="font-mono text-xs">
            {inheriting ? 'SYSTEM' : row.tenantId}
          </Badge>
        </AlertTitle>
        <AlertDescription>
          Availability selects which safety policies apply to this tenant. It can never switch guardrail off: every request is screened before send
          and every response after receive, and a selection with nothing enabled falls back to the platform set. Strictness may only be tightened.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-3">
        {catalogue.map((policy) => {
          const selection = current[policy.id] ?? { enabled: false };
          const floor = platformFloor(row, policy);
          return (
            <Card key={policy.id} className="gap-3 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <Label htmlFor={`${uid}-${policy.id}`} className="flex flex-wrap items-center gap-2 text-sm">
                    {policy.label}
                    {policy.directions.map((direction) => (
                      <Badge key={direction} variant="secondary" className="text-xs">
                        {direction}
                      </Badge>
                    ))}
                  </Label>
                  <p className="text-muted-foreground text-xs">{policy.description}</p>
                </div>
                <Switch
                  id={`${uid}-${policy.id}`}
                  checked={selection.enabled}
                  onCheckedChange={(checked) => set(policy.id, { ...selection, enabled: checked })}
                />
              </div>

              {policy.threshold ? (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                  <Label htmlFor={`${uid}-${policy.id}-threshold`} className="text-xs">
                    {policy.threshold.field}
                  </Label>
                  <Input
                    id={`${uid}-${policy.id}-threshold`}
                    type="number"
                    inputMode="decimal"
                    step="0.05"
                    min={policy.threshold.minimum}
                    max={policy.threshold.maximum}
                    className="max-w-40"
                    value={typeof selection[policy.threshold.field] === 'number' ? String(selection[policy.threshold.field]) : ''}
                    aria-describedby={`${uid}-${policy.id}-threshold-hint`}
                    onChange={(event) => {
                      const raw = event.target.value;
                      const next: GuardrailPolicySelection = { ...selection };
                      if (raw === '') delete next[policy.threshold!.field];
                      else next[policy.threshold!.field] = Number(raw);
                      set(policy.id, next);
                    }}
                  />
                  <p id={`${uid}-${policy.id}-threshold-hint`} className="text-muted-foreground text-xs">
                    {policy.threshold.floorDirection === 'lower-is-stricter' ? 'Lower is stricter.' : 'Higher is stricter.'} Tighten only
                    {floor === null ? '' : ` — the platform floor is ${floor}`}. A looser value is refused, never silently clamped.
                  </p>
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {refusal ? (
          <p id={`${uid}-refusal`} className="text-destructive text-sm">
            {refusal}
          </p>
        ) : null}
        <Button type="button" variant="outline" disabled={!dirty || mutation.isPending} onClick={() => setDraft(null)}>
          Discard changes
        </Button>
        <Button
          type="button"
          disabled={!dirty || mutation.isPending || refusal !== null}
          aria-describedby={refusal ? `${uid}-refusal` : undefined}
          onClick={handleSave}
        >
          {mutation.isPending ? <Spinner /> : null}
          Save availability
        </Button>
      </div>
    </div>
  );
}
