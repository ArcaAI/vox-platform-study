'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@arcaai/ui/components/shadcn/dialog';
import { FieldLegend, FieldSet } from '@arcaai/ui/components/shadcn/field';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { CodeEditor } from '@arcaai/ui';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { GatewayError } from '@/shared/api';
import type { TenantPlan } from '@/features/tenants/api/types';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { usePlanEntitlement, useUpdatePlanEntitlement } from '../api/hooks';
import type { PlanEntitlement, UpdatePlanEntitlementRequest } from '../api/types';
import { LIMIT_FIELDS, LIMIT_GROUPS, PLAN_LABELS, PROVIDER_QUOTA_FIELD } from './plan-meta';
import { cx } from '@/shared/cx';
import { DIALOG_SIZE_CLASS } from '@/shared/dialog/dialog-size';

/**
 * TASK-883 retired the three display-only plan booleans, and every surviving
 * `PlanEntitlement` feature flag is enforcing and platform-owned rather than
 * plan-editable — so this form has limits and tiers, and no feature switches.
 */
interface PlanFormValues {
  limits: Record<string, string>;
  modelTier: string;
  rateLimitTier: string;
  /**
   * TASK-998 OD-4 — the platform-default cloud-ASR capacity map, held as the
   * JSON text the editor shows rather than as a parsed object: the operator's
   * in-progress (and briefly invalid) document must survive a re-render.
   */
  providerQuotas: string;
}

function toFormValues(entitlement: PlanEntitlement): PlanFormValues {
  const limits: Record<string, string> = {};
  for (const field of LIMIT_FIELDS) {
    const value = entitlement[field.key];
    limits[field.key] = value === null || value === undefined ? '' : String(value);
  }
  return {
    limits,
    modelTier: entitlement.modelTier,
    rateLimitTier: entitlement.rateLimitTier,
    // An absent platform default renders as `{}`, not as the string "null":
    // "this plan bounds nothing" is the same thing an empty map says, and it is
    // the document an operator would start editing.
    providerQuotas: JSON.stringify(entitlement.sttProviderQuotas ?? {}, null, 2),
  };
}

function isOccError(error: unknown): boolean {
  return error instanceof GatewayError && (error.isVersionConflict || error.isMissingPrecondition);
}

/**
 * Plan editor form. Field state seeds once from the loaded row; a reload
 * after a 412 refreshes the row version through the prop WITHOUT clobbering
 * local edits (the OCC alert promises "your unsaved edits are kept locally").
 */
function PlanEditForm({
  plan,
  entitlement,
  onDone,
  onCancel,
  onReloadLatest,
}: {
  plan: TenantPlan;
  entitlement: PlanEntitlement;
  onDone: () => void;
  onCancel: () => void;
  onReloadLatest: () => void;
}) {
  const update = useUpdatePlanEntitlement();
  const [values, setValues] = useState<PlanFormValues>(() => toFormValues(entitlement));
  const [fieldError, setFieldError] = useState<string | null>(null);

  function setLimit(key: string, value: string) {
    setValues((current) => ({ ...current, limits: { ...current.limits, [key]: value } }));
    setFieldError(null);
  }

  function handleSave() {
    const body: UpdatePlanEntitlementRequest = {
      expectedVersion: entitlement.version,
      modelTier: values.modelTier.trim(),
      rateLimitTier: values.rateLimitTier.trim(),
    };
    for (const field of LIMIT_FIELDS) {
      const raw = values.limits[field.key].trim();
      if (raw === '') {
        body[field.key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setFieldError(`${field.label} must be a non-negative number (or empty for unlimited).`);
        return;
      }
      body[field.key] = parsed;
    }
    // TASK-998 OD-4 — the capacity map. Parsed here only to catch malformed
    // JSON before the round trip; the gateway is the authority on which
    // provider ids and dimensions are legal (it validates against
    // `CLOUD_BYO_PROVIDERS.stt` and answers 400), so the console does not
    // duplicate that list.
    const rawQuotas = values.providerQuotas.trim();
    if (rawQuotas === '' || rawQuotas === '{}') {
      body.sttProviderQuotas = null;
    } else {
      let parsedQuotas: unknown;
      try {
        parsedQuotas = JSON.parse(rawQuotas);
      } catch {
        setFieldError(`${PROVIDER_QUOTA_FIELD.label} is not valid JSON.`);
        return;
      }
      if (!parsedQuotas || typeof parsedQuotas !== 'object' || Array.isArray(parsedQuotas)) {
        setFieldError(`${PROVIDER_QUOTA_FIELD.label} must be a JSON object keyed by provider id.`);
        return;
      }
      body.sttProviderQuotas = parsedQuotas as PlanEntitlement['sttProviderQuotas'];
    }
    update.mutate(
      { plan, body },
      {
        onSuccess: () => {
          toast.success(`${PLAN_LABELS[plan]} plan entitlements saved`);
          onDone();
        },
        onError: (error) => {
          if (!isOccError(error)) {
            toast.error(error instanceof GatewayError ? error.message : 'Could not save the plan entitlements.');
          }
        },
      },
    );
  }

  function handleReloadLatest() {
    update.reset();
    onReloadLatest();
  }

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
        {LIMIT_GROUPS.map((group) => (
          <FieldSet key={group.id} className="gap-0">
            <FieldLegend variant="label">{group.title}</FieldLegend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {group.fields.map((field) => (
                <div key={field.key} className="flex flex-col gap-2">
                  <Label htmlFor={`plan-edit-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`plan-edit-${field.key}`}
                    type="number"
                    min={0}
                    placeholder="Unlimited"
                    value={values.limits[field.key]}
                    onChange={(event) => setLimit(field.key, event.target.value)}
                  />
                </div>
              ))}
            </div>
          </FieldSet>
        ))}
        <FieldSet className="gap-0">
          <FieldLegend variant="label">Cloud ASR capacity</FieldLegend>
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">{PROVIDER_QUOTA_FIELD.help}</p>
            <CodeEditor
              aria-label={PROVIDER_QUOTA_FIELD.label}
              language="json"
              value={values.providerQuotas}
              onChange={(next) => {
                setValues((current) => ({ ...current, providerQuotas: next }));
                setFieldError(null);
              }}
              className="min-h-40"
            />
          </div>
        </FieldSet>
        <FieldSet className="gap-0">
          <FieldLegend variant="label">Tiers</FieldLegend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="plan-edit-modelTier">Model tier</Label>
              <Input
                id="plan-edit-modelTier"
                value={values.modelTier}
                onChange={(event) => setValues((current) => ({ ...current, modelTier: event.target.value }))}
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="plan-edit-rateLimitTier">Rate limit tier</Label>
              <Input
                id="plan-edit-rateLimitTier"
                value={values.rateLimitTier}
                onChange={(event) => setValues((current) => ({ ...current, rateLimitTier: event.target.value }))}
                className="font-mono"
              />
            </div>
          </div>
        </FieldSet>
      </div>
      {fieldError ? (
        <p role="alert" className="text-destructive text-sm">
          {fieldError}
        </p>
      ) : null}
      <OccConflictAlert error={update.error} onReload={handleReloadLatest} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={update.isPending}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={update.isPending}>
          {update.isPending ? <Spinner /> : null}
          Save changes
        </Button>
      </DialogFooter>
    </div>
  );
}

function PlanEditSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {/* One row per rendered field: the limits plus the two tier inputs. */}
      {Array.from({ length: LIMIT_FIELDS.length + 2 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Plan editor dialog (frame 13 row click). Reads the row fresh so the PATCH
 * carries the current expectedVersion; a 412 surfaces the OCC alert with
 * "Reload latest" (refreshing the version in place, keeping local edits).
 */
export function PlanEditDialog({ plan, onOpenChange }: { plan: TenantPlan | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={plan !== null} onOpenChange={onOpenChange}>
      <DialogContent className={cx('flex max-h-[85vh] flex-col overflow-y-auto', DIALOG_SIZE_CLASS.md)}>
        <DialogHeader>
          <DialogTitle>{plan ? `Edit ${PLAN_LABELS[plan]} plan defaults` : 'Edit plan defaults'}</DialogTitle>
          <DialogDescription>
            Leave a limit empty for unlimited. Changes are saved with optimistic concurrency (expectedVersion) and apply to every tenant on the plan
            without an override.
          </DialogDescription>
        </DialogHeader>
        {plan ? <PlanEditBody plan={plan} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PlanEditBody({ plan, onDone }: { plan: TenantPlan; onDone: () => void }) {
  const detail = usePlanEntitlement(plan);

  if (detail.isPending) return <PlanEditSkeleton />;
  if (detail.error || !detail.data) {
    return (
      <ErrorState
        error={detail.error ?? new GatewayError(404, 'This plan does not exist or is outside your access scope.')}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  return (
    <PlanEditForm
      key={detail.data.id}
      plan={plan}
      entitlement={detail.data}
      onDone={onDone}
      onCancel={onDone}
      onReloadLatest={() => void detail.refetch()}
    />
  );
}
