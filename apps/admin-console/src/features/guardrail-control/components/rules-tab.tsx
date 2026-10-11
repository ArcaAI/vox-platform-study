'use client';

import { useId, useState } from 'react';
import { IconBuilding, IconLock, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Input } from '@arcaai/ui/components/shadcn/input';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { NativeSelect, NativeSelectOption } from '@arcaai/ui/components/shadcn/native-select';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Switch } from '@arcaai/ui/components/shadcn/switch';
import { useSession } from '@/shared/auth';
import { EmptyState } from '@/shared/state/empty-state';
import { useGuardrailAvailability, useGuardrailCatalogue, useUpdateGuardrailAvailability } from '../api/hooks';
import {
  SYSTEM_TENANT_ID,
  type GuardrailAction,
  type GuardrailAvailabilityRow,
  type GuardrailCatalogueEntry,
  type GuardrailDirection,
  type GuardrailEffectivePolicy,
} from '../api/types';
import { ControlErrorState } from './control-states';
import {
  buildPolicyWrite,
  draftFromView,
  sameDraft,
  toStoredPolicy,
  withoutCheck,
  writeErrorMessage,
  type PolicyDraft,
} from './guardrail-control-logic';

const ACTION_LABEL: Record<GuardrailAction, string> = { ignore: 'Ignore (record only)', warn: 'Warn', block: 'Block' };
const DIRECTION_LABEL: Record<GuardrailDirection, string> = { inbound: 'Inbound screening', outbound: 'Outbound screening' };

/**
 * TODO(W2b seam): a gateway that predates the v2 availability response carries no `effectivePolicy`.
 * The editor then rebuilds the view from the catalogue defaults and the legacy flat `effective` set, so the
 * screen still renders; actions shown are the catalogue defaults.
 */
function viewFromCatalogue(row: GuardrailAvailabilityRow, catalogue: GuardrailCatalogueEntry[]): GuardrailEffectivePolicy {
  return {
    directions: { inbound: { enabled: true }, outbound: { enabled: true } },
    checks: catalogue.map((entry) => {
      const flat = row.effective[entry.id] as { enabled?: boolean } | undefined;
      return {
        checkId: entry.id,
        label: entry.label,
        description: entry.description,
        directions: entry.directions,
        enabled: flat?.enabled ?? entry.defaultEnabled ?? false,
        action: entry.platformDefaultAction ?? 'block',
        allowedActions: entry.allowedActions ?? [],
        locked: entry.locked ?? false,
        lockReason: entry.locked ? 'catalogue' : null,
        editable: !entry.locked,
        ...(entry.platformDefaultDataRegionAction ? { dataRegionAction: entry.platformDefaultDataRegionAction } : {}),
        ...(entry.platformDefaultCategoryActions ? { categoryActions: entry.platformDefaultCategoryActions } : {}),
        inherited: row.effectiveSourceTenantId === SYSTEM_TENANT_ID,
        setBy: null,
      };
    }),
  };
}

/**
 * TASK-1062 E-1 — per-category action overrides of one check (`{ label: action }`; relax only, platform admin
 * only — this whole screen is). Lists the labels in force and adds a new one by name.
 */
function CategoryActionsEditor({
  base,
  allowed,
  value,
  disabled,
  onChange,
}: {
  base: string;
  allowed: GuardrailAction[];
  value: Record<string, GuardrailAction>;
  disabled: boolean;
  onChange: (next: Record<string, GuardrailAction>) => void;
}) {
  const [label, setLabel] = useState('');
  const options = allowed.length > 0 ? allowed : (['ignore', 'warn', 'block'] as GuardrailAction[]);
  const entries = Object.entries(value);
  const add = () => {
    const key = label.trim().toLowerCase();
    if (!key || key in value) return;
    onChange({ ...value, [key]: options.includes('ignore') ? 'ignore' : options[0]! });
    setLabel('');
  };
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <p id={`${base}-categories`} className="text-xs font-medium">
        Category actions {entries.length > 0 ? `(${entries.length})` : ''}
      </p>
      <p className="text-muted-foreground text-xs">
        A flag whose labels are all listed here takes that action instead of the check&apos;s. It only relaxes.
      </p>
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-labelledby={`${base}-categories`}>
          {entries.map(([name, action]) => (
            <li key={name} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
              <NativeSelect
                aria-label={`${name} action`}
                value={action}
                disabled={disabled}
                onChange={(event) => onChange({ ...value, [name]: event.target.value as GuardrailAction })}
              >
                {options.map((option) => (
                  <NativeSelectOption key={option} value={option}>
                    {ACTION_LABEL[option]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={`Remove ${name}`}
                onClick={() => onChange(Object.fromEntries(entries.filter(([key]) => key !== name)))}
              >
                <IconTrash aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          aria-label="New category label"
          className="max-w-56 font-mono text-xs"
          placeholder="category label"
          value={label}
          disabled={disabled}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || !label.trim()} onClick={add}>
          <IconPlus aria-hidden />
          Add category
        </Button>
      </div>
    </div>
  );
}

function PolicySkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <div className="grid gap-3 sm:grid-cols-2">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-full max-w-xl" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * One policy row editor: the SYSTEM row (platform defaults, `scope="platform"`) or one tenant's override
 * row (`scope="tenant"`). Both write `PUT admin/guardrail/availability/:tenantId` — the whole v2 row under
 * `If-Match` — stating only the fields that differ from the policy in force, so anything left alone keeps
 * following SYSTEM / the catalogue.
 */
export function PolicyEditor({
  tenantId,
  scope,
  catalogue,
}: {
  tenantId: string;
  scope: 'platform' | 'tenant';
  catalogue: GuardrailCatalogueEntry[];
}) {
  const uid = useId();
  const query = useGuardrailAvailability(tenantId);
  const mutation = useUpdateGuardrailAvailability(tenantId);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);

  if (query.isError) return <ControlErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const row = query.data;
  if (!row) return <PolicySkeleton />;

  const view = row.effectivePolicy ?? viewFromCatalogue(row, catalogue);
  const saved = draftFromView(view);
  const current = draft ?? saved;
  const dirty = !sameDraft(current, saved);
  const stored = toStoredPolicy(row.policies);
  const byId = new Map(catalogue.map((entry) => [entry.id, entry]));

  function save(policies: ReturnType<typeof buildPolicyWrite> | Record<string, never>, success: string) {
    mutation.mutate(
      { policies, version: row!.version },
      {
        onSuccess: () => {
          toast.success(success);
          setDraft(null);
        },
        onError: (error) => {
          toast.error(writeErrorMessage(error));
          setDraft(null);
        },
      },
    );
  }

  function setCheck(checkId: string, patch: Partial<PolicyDraft['checks'][string]>) {
    setDraft({ ...current, checks: { ...current.checks, [checkId]: { ...current.checks[checkId]!, ...patch } } });
  }

  const lockLabel = scope === 'platform' ? 'Lock for every tenant' : 'Lock for this tenant';

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">Screening directions</legend>
        {(['inbound', 'outbound'] as const).map((direction) => (
          <div key={direction} className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <Label htmlFor={`${uid}-${direction}`}>{DIRECTION_LABEL[direction]}</Label>
              <p className="text-muted-foreground text-xs">Off = monitor only: every check still runs and is recorded, at Ignore.</p>
            </div>
            <Switch
              id={`${uid}-${direction}`}
              checked={current.directions[direction].enabled}
              onCheckedChange={(checked) => setDraft({ ...current, directions: { ...current.directions, [direction]: { enabled: checked } } })}
            />
          </div>
        ))}
      </fieldset>

      <ul className="flex flex-col gap-3" aria-label={scope === 'platform' ? 'Platform default per check' : 'Tenant override per check'}>
        {view.checks.map((check) => {
          const entry = byId.get(check.checkId);
          const value = current.checks[check.checkId]!;
          const catalogueLocked = check.lockReason === 'catalogue';
          const allowed = check.allowedActions.length > 0 ? check.allowedActions : (entry?.allowedActions ?? []);
          const hasDataRegion = check.dataRegionAction !== undefined || Boolean(entry?.platformDefaultDataRegionAction);
          const overridden = scope === 'tenant' && stored.checks[check.checkId] !== undefined;
          const base = `${uid}-${check.checkId}`;
          return (
            <li key={check.checkId}>
              <Card className="gap-3 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span id={`${base}-label`} className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {check.label}
                      {check.directions.map((direction) => (
                        <Badge key={direction} variant="secondary" className="text-xs">
                          {direction}
                        </Badge>
                      ))}
                      {catalogueLocked ? (
                        <Badge variant="outline" className="gap-1 text-xs">
                          <IconLock aria-hidden className="size-3" />
                          Locked by catalogue · always on
                        </Badge>
                      ) : check.lockReason === 'platform' ? (
                        <Badge variant="outline" className="gap-1 text-xs">
                          <IconLock aria-hidden className="size-3" />
                          Platform lock
                        </Badge>
                      ) : null}
                      {scope === 'tenant' ? (
                        <Badge variant={overridden ? 'default' : 'outline'} className="text-xs">
                          {overridden ? 'Tenant override' : 'Platform default'}
                        </Badge>
                      ) : null}
                    </span>
                    <p className="text-muted-foreground text-xs">{check.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`${base}-enabled`} className="text-xs">
                      Enabled
                    </Label>
                    <Switch
                      id={`${base}-enabled`}
                      checked={value.enabled}
                      disabled={catalogueLocked}
                      aria-describedby={`${base}-label`}
                      onCheckedChange={(checked) => setCheck(check.checkId, { enabled: checked })}
                    />
                  </div>
                </div>

                <div className="grid gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${base}-action`} className="text-xs">
                      Action on violation
                    </Label>
                    <NativeSelect
                      id={`${base}-action`}
                      value={value.action}
                      disabled={catalogueLocked || allowed.length === 0}
                      onChange={(event) => setCheck(check.checkId, { action: event.target.value as GuardrailAction })}
                    >
                      {(allowed.length > 0 ? allowed : [value.action]).map((action) => (
                        <NativeSelectOption key={action} value={action}>
                          {ACTION_LABEL[action]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  {hasDataRegion ? (
                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor={`${base}-data`} className="text-xs">
                        Data-region cap (inbound data)
                      </Label>
                      <NativeSelect
                        id={`${base}-data`}
                        value={value.dataRegionAction ?? entry?.platformDefaultDataRegionAction ?? 'ignore'}
                        disabled={catalogueLocked}
                        onChange={(event) => setCheck(check.checkId, { dataRegionAction: event.target.value as GuardrailAction })}
                      >
                        {(allowed.length > 0 ? allowed : (['ignore', 'warn', 'block'] as GuardrailAction[])).map((action) => (
                          <NativeSelectOption key={action} value={action}>
                            {ACTION_LABEL[action]}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : null}
                  {!catalogueLocked ? (
                    <div className="flex items-center gap-2 self-end">
                      <Switch
                        id={`${base}-lock`}
                        checked={value.locked}
                        onCheckedChange={(checked) => setCheck(check.checkId, { locked: checked })}
                      />
                      <Label htmlFor={`${base}-lock`} className="text-xs">
                        {lockLabel}
                      </Label>
                    </div>
                  ) : null}
                  {scope === 'tenant' && overridden ? (
                    <div className="flex items-end justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() => save(withoutCheck(stored, check.checkId), `${check.label} follows the platform again`)}
                      >
                        <IconRestore aria-hidden />
                        Reset to platform
                      </Button>
                    </div>
                  ) : null}
                </div>
                {!catalogueLocked ? (
                  <CategoryActionsEditor
                    base={base}
                    allowed={allowed}
                    value={value.categoryActions ?? {}}
                    disabled={mutation.isPending}
                    onChange={(next) => setCheck(check.checkId, { categoryActions: next })}
                  />
                ) : null}
              </Card>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {scope === 'tenant' && Object.keys(stored.checks).length + Object.keys(stored.directions).length > 0 ? (
          <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={() => save({}, 'Tenant now follows the platform defaults')}>
            <IconRestore aria-hidden />
            Reset whole tenant to platform
          </Button>
        ) : null}
        <Button type="button" variant="outline" disabled={!dirty || mutation.isPending} onClick={() => setDraft(null)}>
          Discard changes
        </Button>
        <Button
          type="button"
          disabled={!dirty || mutation.isPending}
          onClick={() => save(buildPolicyWrite(stored, view, current), scope === 'platform' ? 'Platform defaults saved' : 'Tenant overrides saved')}
        >
          {mutation.isPending ? <Spinner /> : null}
          {scope === 'platform' ? 'Save platform defaults' : 'Save tenant overrides'}
        </Button>
      </div>
    </div>
  );
}

/**
 * The tenant half reads the WORKING tenant (rule 13 sub-pattern: a `(global)` screen over per-tenant rows).
 * Same decision as `WorkingTenantGate`, rendered inline because that gate repeats the page h1.
 */
function TenantOverrides({ catalogue }: { catalogue: GuardrailCatalogueEntry[] }) {
  const session = useSession();
  if (!session.data) return <Skeleton className="h-40 w-full" />;
  const tenantId = session.data.effectiveTenantId;
  if (!tenantId) {
    return (
      <EmptyState
        icon={IconBuilding}
        title="Select a working tenant"
        description="Per-tenant overrides are per tenant. Pick a working tenant from the switcher in the top bar to override or lock its checks."
      />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Acting on: <span className="text-foreground font-medium">{session.data.workingTenantName ?? tenantId}</span>
      </p>
      <PolicyEditor tenantId={tenantId} scope="tenant" catalogue={catalogue} />
    </div>
  );
}

export function RulesTab() {
  const catalogue = useGuardrailCatalogue();
  if (catalogue.isError) return <ControlErrorState error={catalogue.error} onRetry={() => void catalogue.refetch()} />;
  if (!catalogue.data) return <PolicySkeleton />;
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="rules-platform" className="flex flex-col gap-3">
        <div>
          <h2 id="rules-platform" className="text-base font-medium">
            Platform defaults
          </h2>
          <p className="text-muted-foreground text-sm">
            The SYSTEM row every tenant inherits when it has no opinion. Tenant admins can only switch unlocked checks on or off; the action and the
            data-region cap are yours.
          </p>
        </div>
        <PolicyEditor tenantId={SYSTEM_TENANT_ID} scope="platform" catalogue={catalogue.data} />
      </section>
      <section aria-labelledby="rules-tenant" className="flex flex-col gap-3">
        <div>
          <h2 id="rules-tenant" className="text-base font-medium">
            Per-tenant overrides
          </h2>
          <p className="text-muted-foreground text-sm">
            Override the action or lock a check for one tenant. Reset returns a check to the platform default.
          </p>
        </div>
        <TenantOverrides catalogue={catalogue.data} />
      </section>
    </div>
  );
}
