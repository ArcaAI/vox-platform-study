'use client';

import { useState, type FormEvent } from 'react';
import { IconAlertTriangle, IconUserSearch } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/components/shadcn/select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Textarea } from '@arcaai/ui/components/shadcn/textarea';
import { GatewayError } from '@/shared/api';
import type { TenantPlan } from '@/features/tenants/api/types';
import { ConfirmDialog } from '@/shared/confirm/confirm-dialog';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useClearTenantOverride, useTenantEntitlements, useTenantOverride, useTriggerDowngrade, useUpsertTenantOverride } from '../api/hooks';
import type { CapabilityUsageRow, TenantEntitlement, UpsertTenantEntitlementRequest } from '../api/types';
import { PLAN_LABELS, PLAN_VALUES, formatLimit } from './plan-meta';

/**
 * Display names for the resolved capability keys. The payload is rendered
 * key-driven rather than field-by-field: TASK-883 retired three of them, and
 * the response DTO under-declares others it actually carries, so an unknown
 * key shows as itself instead of silently disappearing.
 */
const FEATURE_LABELS: Record<string, string> = {
  platformDefaultCredential: 'Platform-default credential',
  paletteStt: 'STT palette',
  agenticLoop: 'Agentic loop',
};

/** The PUT-able subset of the override row (id/tenantId/version stay out). */
const OVERRIDE_KEYS = [
  'maxUsers',
  'maxDepartments',
  'maxPromptTemplates',
  'maxAsrPipelines',
  'maxApiKeys',
  'maxWorkflowDefinitions',
  'maxAiProviderConnections',
  'storageQuotaBytes',
  'maxConcurrentSessions',
  'monthlyConsultations',
  'monthlyTranscriptionMinutes',
  'monthlySummaries',
  'monthlyWorkflowInvocations',
  'monthlySttSessionSeconds',
  'monthlyLlmTokens',
  'monthlyTtsCharacters',
  'monthlyNlpTextUnits',
  'monthlyEmbeddingTokens',
  'modelTier',
  'rateLimitTier',
  'rateLimitPerMinute',
] as const;

function toEditableJson(override: TenantEntitlement | null): string {
  if (!override) return '{}';
  const subset: Record<string, unknown> = {};
  for (const key of OVERRIDE_KEYS) subset[key] = override[key] ?? null;
  return JSON.stringify(subset, null, 2);
}

function UsageRow({ row }: { row: CapabilityUsageRow }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b py-1.5 text-sm last:border-b-0">
      <span className="font-mono text-xs">{row.key}</span>
      <span className="flex items-center gap-2 tabular-nums">
        {row.unlimited ? 'Unlimited' : `${formatNumber(row.used ?? 0)} / ${formatLimit(row.limit)}`}
        {row.exceeded ? (
          <span className="text-destructive flex items-center gap-1 text-xs font-medium">
            <IconAlertTriangle aria-hidden className="size-3.5" />
            Exceeded
          </span>
        ) : row.nearLimit ? (
          <span className="text-warning-strong flex items-center gap-1 text-xs font-medium">
            <IconAlertTriangle aria-hidden className="size-3.5" />
            Near limit
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Effective plan + override merge, usage counters and trial state. */
function EffectiveEntitlementsCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, error, refetch } = useTenantEntitlements(tenantId);

  if (isPending) {
    return (
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-44" />
        <Skeleton className="h-5 w-72" />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }
  if (error || !data) {
    return <ErrorState title={'Couldn\u2019t load the tenant entitlements'} error={error} onRetry={() => refetch()} />;
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Effective entitlements</h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{data.plan ? PLAN_LABELS[data.plan] : 'No plan'}</Badge>
          <Badge variant="outline">{data.gated ? 'Gated' : 'Not gated'}</Badge>
          <Badge variant="outline">{data.enforcementEnabled ? 'Enforcement on' : 'Enforcement off'}</Badge>
          <span className="text-muted-foreground font-mono text-xs">
            {`${data.modelTier} \u00b7 ${data.rateLimitTier}${data.rateLimitPerMinute != null ? ` \u00b7 ${data.rateLimitPerMinute}/min` : ''}`}
          </span>
        </div>
        {data.trial.isTrial ? (
          <p className={data.trial.expired ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
            {data.trial.expired
              ? 'Trial expired'
              : `Trial ends ${formatDateTime(data.trial.trialEndsAt, 'date')} (${formatNumber(data.trial.daysRemaining)} days left)`}
          </p>
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-muted-foreground text-xs font-medium">Quantities</h3>
          {data.quantities.length === 0 ? (
            <p className="text-muted-foreground text-sm">{'\u2014'}</p>
          ) : (
            data.quantities.map((row) => <UsageRow key={row.key} row={row} />)
          )}
        </div>
        <div className="flex flex-col gap-1">
          <h3 className="text-muted-foreground text-xs font-medium">Meters (this period)</h3>
          {data.meters.length === 0 ? (
            <p className="text-muted-foreground text-sm">{'\u2014'}</p>
          ) : (
            data.meters.map((row) => <UsageRow key={row.key} row={row} />)
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(data.features).map(([key, on]) => (
          <Badge key={key} variant={on ? 'secondary' : 'outline'}>
            {FEATURE_LABELS[key] ?? key} {on ? 'on' : 'off'}
          </Badge>
        ))}
      </div>
    </Card>
  );
}

/** Override editor: one JSON document, PUT upsert with expectedVersion, DELETE clear. */
function OverrideEditorCard({ tenantId }: { tenantId: string }) {
  const { data, isPending, error, refetch } = useTenantOverride(tenantId);
  const upsert = useUpsertTenantOverride();
  const clear = useClearTenantOverride();
  const [draft, setDraft] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'save' | 'clear' | null>(null);
  const [pendingBody, setPendingBody] = useState<UpsertTenantEntitlementRequest | null>(null);

  if (isPending) {
    return (
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-56 w-full" />
      </Card>
    );
  }
  if (error) {
    return <ErrorState title={'Couldn\u2019t load the tenant override'} error={error} onRetry={() => refetch()} />;
  }

  const override = data ?? null;
  const serialized = toEditableJson(override);
  const value = draft ?? serialized;

  function requestSave() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      setParseError('The document is not valid JSON. Fix it before saving.');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setParseError('The document must be a JSON object.');
      return;
    }
    setParseError(null);
    setPendingBody({ ...(parsed as UpsertTenantEntitlementRequest), ...(override ? { expectedVersion: override.version } : {}) });
    setConfirm('save');
  }

  function handleSaveConfirmed() {
    if (!pendingBody) return;
    upsert.mutate(
      { tenantId, body: pendingBody },
      {
        onSuccess: () => {
          toast.success('Tenant override saved');
          setDraft(null);
          setConfirm(null);
        },
        onError: (mutationError) => {
          toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not save the override.');
          setConfirm(null);
        },
      },
    );
  }

  function handleClearConfirmed() {
    clear.mutate(tenantId, {
      onSuccess: () => {
        toast.success('Tenant override cleared');
        setDraft(null);
        setConfirm(null);
      },
      onError: (mutationError) => {
        toast.error(mutationError instanceof GatewayError ? mutationError.message : 'Could not clear the override.');
        setConfirm(null);
      },
    });
  }

  return (
    <Card className="gap-4 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Tenant override</h2>
        <p className="text-muted-foreground text-xs">
          {override
            ? `v${override.version} \u2014 null values inherit from the plan default.`
            : 'No override yet \u2014 saving creates one. null values inherit from the plan default.'}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="override-json">Override JSON</Label>
        <Textarea
          id="override-json"
          value={value}
          onChange={(event) => {
            setDraft(event.target.value);
            setParseError(null);
          }}
          spellCheck={false}
          className="min-h-56 resize-y font-mono text-xs"
        />
        {parseError ? (
          <p role="alert" className="text-destructive text-sm">
            {parseError}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" disabled={!override || clear.isPending} onClick={() => setConfirm('clear')}>
          Clear override
        </Button>
        <Button onClick={requestSave} disabled={upsert.isPending}>
          Save override
        </Button>
      </div>
      <ConfirmDialog
        open={confirm === 'save'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Apply tenant override?"
        description={`The override replaces the ${override ? 'existing' : 'plan-default'} entitlements for this tenant on the next request.`}
        confirmLabel="Apply override"
        onConfirm={handleSaveConfirmed}
        isPending={upsert.isPending}
      />
      <ConfirmDialog
        open={confirm === 'clear'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title="Clear tenant override?"
        description="The tenant falls back to its plan defaults. This cannot be undone."
        confirmLabel="Clear override"
        destructive
        onConfirm={handleClearConfirmed}
        isPending={clear.isPending}
      />
    </Card>
  );
}

/**
 * Ops actions scoped to the loaded tenant (matrix row 4 downgrade sweep).
 *
 * TASK-986 W2 (R1) — RE-LABELLED. The route is `POST …/downgrade` and still is,
 * but the control offered all four plans, so an UPGRADE through it was headed
 * "Operations", styled as a destructive "Trigger downgrade" and reported
 * "Downgrade to Enterprise complete". The wording now says what the operation
 * does — apply a plan's limits and disable what is over quota — and points at
 * the ONE authoritative plan editor on the tenant detail screen (rule 13), by
 * plain href rather than a cross-feature import.
 */
function DowngradeCard({ tenantId }: { tenantId: string }) {
  const downgrade = useTriggerDowngrade();
  const [plan, setPlan] = useState<TenantPlan>('STARTER');
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleConfirmed() {
    downgrade.mutate(
      { tenantId, plan },
      {
        onSuccess: (report) => {
          toast.success(`Plan limits applied: ${PLAN_LABELS[report.toPlan]} \u2014 ${formatNumber(report.totalDisabled)} resources disabled`);
          setConfirmOpen(false);
        },
        onError: (error) => {
          toast.error(error instanceof GatewayError ? error.message : 'Could not apply the plan limits.');
          setConfirmOpen(false);
        },
      },
    );
  }

  return (
    <Card className="gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Change plan</h2>
        <p className="text-muted-foreground text-xs">
          Sets the tenant&apos;s plan and re-applies its limits, disabling any resource over quota (audited, reversible per resource). To change the
          plan without the quota sweep, use{' '}
          <a className="underline underline-offset-2" href={`/tenants/${tenantId}`}>
            the tenant detail screen
          </a>
          .
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="downgrade-plan">Target plan</Label>
          <Select value={plan} onValueChange={(next) => setPlan(next as TenantPlan)}>
            <SelectTrigger id="downgrade-plan" className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLAN_VALUES.map((option) => (
                <SelectItem key={option} value={option}>
                  {PLAN_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={() => setConfirmOpen(true)} disabled={downgrade.isPending}>
          Change plan
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Change plan to ${PLAN_LABELS[plan]}?`}
        description={`Sets this tenant to ${PLAN_LABELS[plan]}, re-applies that plan's limits and disables anything over quota.`}
        confirmLabel="Change plan"
        onConfirm={handleConfirmed}
        isPending={downgrade.isPending}
      />
    </Card>
  );
}

/**
 * Frame 13 tenant-overrides tab. The frame leaves tenant selection open, so a
 * plain tenant-id input + Load acts as the selector (URL-synced via nuqs).
 */
export function TenantOverridePanel() {
  const [tenantId, setTenantId] = useQueryState('tenant', parseAsString.withDefault(''));
  const [draftId, setDraftId] = useState(tenantId);
  const [lastTenantId, setLastTenantId] = useState(tenantId);

  // Re-sync when the URL state changes externally (back/forward) — the
  // render-time derived-state reset pattern, not an effect.
  if (tenantId !== lastTenantId) {
    setLastTenantId(tenantId);
    setDraftId(tenantId);
  }

  function handleLoad(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void setTenantId(draftId.trim() || null);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <form onSubmit={handleLoad} className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-col gap-2">
            <Label htmlFor="override-tenant-id">Tenant ID</Label>
            <Input
              id="override-tenant-id"
              value={draftId}
              onChange={(event) => setDraftId(event.target.value)}
              placeholder="Tenant UUID from the Tenants list"
              className="font-mono"
            />
          </div>
          <Button type="submit">Load tenant</Button>
        </form>
      </Card>
      {tenantId ? (
        <div className="flex flex-col gap-4">
          <EffectiveEntitlementsCard tenantId={tenantId} />
          <OverrideEditorCard tenantId={tenantId} />
          <DowngradeCard tenantId={tenantId} />
        </div>
      ) : (
        <EmptyState
          icon={IconUserSearch}
          title="No tenant loaded"
          description="Enter a tenant ID to inspect its effective entitlements and manage its override."
        />
      )}
    </div>
  );
}
