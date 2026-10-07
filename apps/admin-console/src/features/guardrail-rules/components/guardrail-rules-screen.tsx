'use client';

import { useId, useState } from 'react';
import { IconLock, IconShieldCheck } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/components/shadcn/tooltip';
import { GatewayError } from '@/shared/api';
import { useSession } from '@/shared/auth';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { TenantScopeBanner } from '@/shared/tenant-scope/tenant-scope-banner';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useGuardrailPolicy, useUpdateGuardrailPolicy } from '../api/hooks';
import type { GuardrailCheckState, GuardrailDirection, TenantGuardrailPolicy, UpdateTenantGuardrailPolicyRequest } from '../api/types';

const TITLE = 'Guardrail rules';

const DIRECTIONS: { id: GuardrailDirection; label: string; blurb: string }[] = [
  { id: 'inbound', label: 'Inbound', blurb: 'Screens what is sent to the AI — prompts, notes and patient data — before it leaves.' },
  { id: 'outbound', label: 'Outbound', blurb: 'Screens what the AI sends back — generated text and summaries — before it reaches users.' },
];

const LOCK_REASON = {
  catalogue: 'Required by the platform',
  platform: 'Locked by your platform administrator',
} as const;

const ACTION_LABEL = { ignore: 'Ignore', warn: 'Warn', block: 'Block' } as const;

/** Local edits against the server state: only flags that differ are ever sent. */
interface Draft {
  directions: Partial<Record<GuardrailDirection, boolean>>;
  checks: Record<string, boolean>;
}

const EMPTY_DRAFT: Draft = { directions: {}, checks: {} };

function isChecked(draftValue: boolean | undefined, serverValue: boolean): boolean {
  return draftValue ?? serverValue;
}

/** Strips draft entries equal to the server value, so toggling back clears the dirty state. */
function normalise(draft: Draft, policy: TenantGuardrailPolicy): Draft {
  const directions = Object.fromEntries(
    Object.entries(draft.directions).filter(([id, value]) => value !== policy.directions[id as GuardrailDirection].enabled),
  );
  const checks = Object.fromEntries(
    Object.entries(draft.checks).filter(([id, value]) => value !== policy.checks.find((check) => check.checkId === id)?.enabled),
  );
  return { directions, checks };
}

function toRequest(draft: Draft): UpdateTenantGuardrailPolicyRequest {
  const body: UpdateTenantGuardrailPolicyRequest = {};
  const directionEntries = Object.entries(draft.directions) as [GuardrailDirection, boolean][];
  if (directionEntries.length > 0) {
    body.directions = Object.fromEntries(directionEntries.map(([id, enabled]) => [id, { enabled }]));
  }
  const checkEntries = Object.entries(draft.checks);
  if (checkEntries.length > 0) {
    body.checks = Object.fromEntries(checkEntries.map(([id, enabled]) => [id, { enabled }]));
  }
  return body;
}

function errorBody(error: unknown): { code?: string; fields?: string[] } {
  if (error instanceof GatewayError && error.details && typeof error.details === 'object') {
    const details = error.details as { code?: unknown; fields?: unknown };
    return {
      code: typeof details.code === 'string' ? details.code : undefined,
      fields: Array.isArray(details.fields) ? details.fields.filter((field): field is string => typeof field === 'string') : undefined,
    };
  }
  return {};
}

function RulesSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <div className="grid gap-3 md:grid-cols-2">
        {[0, 1].map((card) => (
          <Card key={card} className="gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-5 w-9 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-28" />
          </Card>
        ))}
      </div>
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

function DirectionCard({
  direction,
  checked,
  activeCount,
  onChange,
}: {
  direction: (typeof DIRECTIONS)[number];
  checked: boolean;
  activeCount: number;
  onChange: (next: boolean) => void;
}) {
  const uid = useId();
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${uid}-switch`} className="text-base font-medium">
          {direction.label}
        </Label>
        <div className="flex items-center gap-2">
          {checked ? (
            <span className="text-sm">On</span>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-muted-foreground cursor-help text-sm underline decoration-dotted" tabIndex={0}>
                  Off (monitor only)
                </span>
              </TooltipTrigger>
              <TooltipContent>Checks still run and record what they find, but never affect users.</TooltipContent>
            </Tooltip>
          )}
          <Switch id={`${uid}-switch`} checked={checked} onCheckedChange={onChange} aria-describedby={`${uid}-blurb`} />
        </div>
      </div>
      <p id={`${uid}-blurb`} className="text-muted-foreground text-sm">
        {direction.blurb}
      </p>
      <p className="text-sm font-medium tabular-nums">
        {activeCount} active {activeCount === 1 ? 'check' : 'checks'}
      </p>
    </Card>
  );
}

function CheckRow({ check, checked, onChange }: { check: GuardrailCheckState; checked: boolean; onChange: (next: boolean) => void }) {
  const uid = useId();
  const readOnly = check.locked || !check.editable;
  const reason = check.lockReason ? LOCK_REASON[check.lockReason] : readOnly ? 'You cannot change this check' : null;
  return (
    <Card className="gap-2 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${uid}-switch`} className="flex flex-wrap items-center gap-2 text-sm">
            {check.label}
            {check.directions.map((direction) => (
              <Badge key={direction} variant="secondary" className="text-xs">
                {direction}
              </Badge>
            ))}
            {check.inherited ? (
              <Badge variant="outline" className="text-xs">
                Inherited
              </Badge>
            ) : null}
          </Label>
          <p className="text-muted-foreground text-xs">{check.description}</p>
        </div>
        <Switch
          id={`${uid}-switch`}
          checked={checked}
          disabled={readOnly}
          onCheckedChange={onChange}
          aria-describedby={readOnly ? `${uid}-reason` : undefined}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant="outline" className="text-xs">
          Platform action: {ACTION_LABEL[check.action]}
        </Badge>
        {readOnly && reason ? (
          <span id={`${uid}-reason`} className="text-muted-foreground flex items-center gap-1 text-xs">
            <IconLock aria-hidden className="size-3.5" />
            {reason}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

function RulesBody({ tenantId }: { tenantId: string }) {
  const query = useGuardrailPolicy(tenantId);
  const mutation = useUpdateGuardrailPolicy(tenantId);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const policy = query.data;
  const dirty = policy ? Object.keys(draft.directions).length + Object.keys(draft.checks).length > 0 : false;

  function edit(update: (current: Draft) => Draft) {
    if (!policy) return;
    setSaved(false);
    setInlineError(null);
    setDraft((current) => normalise(update(current), policy));
  }

  function handleSave() {
    if (!policy || !dirty) return;
    setInlineError(null);
    mutation.mutate(
      { body: toRequest(draft), version: policy.version },
      {
        onSuccess: () => {
          setDraft(EMPTY_DRAFT);
          setSaved(true);
          toast.success('Guardrail rules saved');
        },
        onError: (error) => {
          if (error instanceof GatewayError && error.isVersionConflict) {
            toast.error('Changed by someone else — reload');
            setDraft(EMPTY_DRAFT);
          } else if (error instanceof GatewayError && error.status === 400) {
            setInlineError(error.message);
          } else if (error instanceof GatewayError && error.status === 403) {
            const { code, fields } = errorBody(error);
            const labels = (fields ?? []).join(', ');
            toast.error(labels ? `${error.message} (${labels})` : error.message, { description: code });
          } else {
            toast.error(error.message);
          }
        },
      },
    );
  }

  let content;
  if (query.isError) {
    content = <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  } else if (!policy) {
    content = <RulesSkeleton />;
  } else if (policy.checks.length === 0) {
    content = <EmptyState icon={IconShieldCheck} title="No guardrail checks available" description="The platform has not published any checks for this tenant yet." />;
  } else {
    content = (
      <TooltipProvider>
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            {DIRECTIONS.map((direction) => {
              const checked = isChecked(draft.directions[direction.id], policy.directions[direction.id].enabled);
              const activeCount = policy.checks.filter(
                (check) => check.directions.includes(direction.id) && isChecked(draft.checks[check.checkId], check.enabled),
              ).length;
              return (
                <DirectionCard
                  key={direction.id}
                  direction={direction}
                  checked={checked}
                  activeCount={activeCount}
                  onChange={(next) => edit((current) => ({ ...current, directions: { ...current.directions, [direction.id]: next } }))}
                />
              );
            })}
          </div>

          <section aria-label="Checks" className="flex flex-col gap-3">
            <h2 className="text-base font-medium">Checks ({policy.checks.length})</h2>
            {policy.checks.map((check) => (
              <CheckRow
                key={check.checkId}
                check={check}
                checked={isChecked(draft.checks[check.checkId], check.enabled)}
                onChange={(next) => edit((current) => ({ ...current, checks: { ...current.checks, [check.checkId]: next } }))}
              />
            ))}
          </section>

          {inlineError ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{inlineError}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {saved ? (
              <p role="status" className="text-muted-foreground text-sm">
                Changes apply immediately.
              </p>
            ) : null}
            <Button type="button" variant="outline" disabled={!dirty || mutation.isPending} onClick={() => setDraft(EMPTY_DRAFT)}>
              Discard changes
            </Button>
            <Button type="button" disabled={!dirty || mutation.isPending} onClick={handleSave}>
              {mutation.isPending ? <Spinner /> : null}
              Save rules
            </Button>
          </div>
        </div>
      </TooltipProvider>
    );
  }

  return (
    <ScreenTemplate
      header={<PageHeader title={TITLE} meta={<span>What is screened before data leaves HOPE and before AI output reaches users</span>} />}
      statusBanner={<TenantScopeBanner />}
      footer={<StatusFooter start={<span>{query.isFetching && !query.isLoading ? 'Refreshing' : 'Up to date'}</span>} end={<span aria-hidden className="font-mono">admin/guardrail/policy</span>} />}
    >
      {content}
    </ScreenTemplate>
  );
}

/** Guardrail rules (/guardrails, tier 30-49): a tenant admin switches directions and checks on or off; actions and locks stay platform-owned. */
export function GuardrailRulesScreen() {
  const session = useSession();
  const tenantId = session.data?.effectiveTenantId ?? null;
  return <WorkingTenantGate title={TITLE}>{tenantId ? <RulesBody tenantId={tenantId} /> : <RulesSkeleton />}</WorkingTenantGate>;
}
