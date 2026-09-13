'use client';

import { useId, useMemo, useState } from 'react';
import { IconAlertTriangle, IconInfoCircle, IconLock, IconWorld } from '@tabler/icons-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Label } from '@arcaai/ui/components/shadcn/label';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Spinner } from '@arcaai/ui/components/shadcn/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { ToggleGroup, ToggleGroupItem } from '@arcaai/ui/components/shadcn/toggle-group';
import { GatewayError } from '@/shared/api';
import { cx } from '@/shared/cx';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { OccConflictAlert } from '@/shared/occ/occ-alert';
import { ErrorState } from '@/shared/state/error-state';
import { useRegistrySetting, usePutRegistrySetting } from '../api/hooks';
import type { SettingCatalogItem, SettingScope } from '../api/types';
import {
  defaultPairTarget,
  defaultScopeFor,
  floorHint,
  isPlatformWideWrite,
  isUnsetAndFailClosed,
  killSwitchWarning,
  pairSummary,
  pairTargetsFor,
  sourceScopeLabel,
  writableScopes,
  writeBlockFor,
} from './governance';
import type { PairTarget } from './governance';
import { RegistryValueEditor } from './registry-value-editor';
import { fromDraft, toDraft } from './registry-value';

const SCOPE_LABEL: Record<SettingScope, string> = {
  system: 'Platform default (SYSTEM)',
  tenant: 'This tenant only',
  department: 'Department',
  doctor: 'Doctor',
};

/**
 * The scope control's label, naming the tenant a `tenant`-scope write would
 * land on.
 *
 * Saying "This tenant only" while a working tenant is selected leaves the admin
 * to remember WHICH one — and TASK-932 R-6 is precisely the class of bug where
 * the row being read and the row being written were not the same and nothing on
 * screen said so.
 */
function scopeLabel(scope: SettingScope, workingTenantName: string | null): string {
  if (scope === 'tenant' && workingTenantName) return `${workingTenantName} override`;
  return SCOPE_LABEL[scope];
}

/**
 * The pair picker's option labels.
 *
 * These name the AUDIENCE of the write, not the mechanism: an admin choosing
 * between "every tenant" and "this tenant" is answering the question they
 * actually have. The two underlying keys are still shown — under the picker and
 * in the Governance tab — so nothing is hidden, only de-emphasised.
 */
const PAIR_LABEL: Record<PairTarget, string> = {
  platform: 'Platform default (every tenant)',
  tenant: 'This tenant only',
};

function pairTargetLabel(target: PairTarget, workingTenantName: string | null): string {
  if (target === 'tenant' && workingTenantName) return `${workingTenantName} override`;
  return PAIR_LABEL[target];
}

/**
 * One governance row. `mono` is a flag rather than pre-rendered JSX so the row
 * list stays plain data — an array of elements would need a key on every entry
 * and makes the table harder to read than the thing it describes.
 */
interface GovernanceRow {
  label: string;
  value: string;
  mono?: boolean;
}

/** Metadata pane — the descriptor as governance, not as a field dump. */
function GovernanceTab({
  item,
  sourceScope,
  version,
  activeKey,
}: {
  item: SettingCatalogItem;
  sourceScope: string | undefined;
  version: number | undefined;
  /** The key the Value tab is currently editing — the twin, on the platform half. */
  activeKey: string;
}) {
  const rows: GovernanceRow[] = [
    { label: 'Key', value: item.key, mono: true },
    { label: 'Category', value: item.category },
    { label: 'Storage tier', value: item.tier, mono: true },
    { label: 'Data type', value: item.dataType, mono: true },
    { label: 'Sensitivity', value: item.sensitivity },
    { label: 'Deepest settable scope', value: SCOPE_LABEL[item.maxScope] },
    { label: 'Edit gated by', value: item.editableBy, mono: true },
    { label: 'Answered by', value: sourceScopeLabel(sourceScope) },
    { label: 'Stored row version', value: version ? `v${version}` : 'none stored — still the code default' },
  ];

  if (item.failMode) {
    rows.push({
      label: 'Fail mode',
      value:
        item.failMode === 'closed' ? 'closed — an unset value raises, it is never substituted' : 'open-to-default — an unset value falls back',
    });
  }
  if (item.killSwitch) rows.push({ label: 'Kill-switch', value: 'yes — safe position is OFF' });
  if (item.floorDirection) rows.push({ label: 'Tenant floor', value: item.floorDirection });
  if (item.default !== undefined) rows.push({ label: 'Code default', value: JSON.stringify(item.default), mono: true });
  // TASK-969 — the pair is collapsed in the Value tab; the two real keys are
  // named here, so "which row did I just write" stays answerable.
  if (item.platformTierKey) {
    rows.push({ label: 'Platform tier key', value: item.platformTierKey, mono: true });
    rows.push({ label: 'Now editing', value: activeKey, mono: true });
  }

  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className={cx('min-w-0 break-words', row.mono && 'font-mono text-xs')}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The registry key editor.
 *
 * This drawer is where the descriptor stops being an inventory entry and starts
 * governing what an admin can actually do:
 *
 *  - a key this lane cannot write says WHICH tier owns it, instead of offering
 *    a control that would 400;
 *  - the scope picker states that `system` means every tenant, BEFORE the
 *    click — the gateway's 403 is the backstop, not the explanation;
 *  - a `failMode: 'closed'` key sitting on its code default is flagged as an
 *    outage waiting to happen, not shown as a neutral default;
 *  - a kill-switch names its unsafe direction rather than rendering a bare
 *    toggle;
 *  - a floored key states that a tenant override may only tighten, so an admin
 *    is not told "no" by a 403 after the fact;
 *  - a concurrent edit surfaces as a 412 conflict with a reload, never a
 *    silent clobber.
 */
export function SettingRegistryDrawer({
  item,
  open,
  onOpenChange,
  isElevated,
  workingTenantName = null,
}: {
  item: SettingCatalogItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isElevated: boolean;
  /**
   * The shell's working tenant, or null when an elevated caller has selected
   * none. It decides two things: whether a TENANT override is addressable at
   * all, and which tenant the scope control names.
   */
  workingTenantName?: string | null;
}) {
  const uid = useId();
  const block = item ? writeBlockFor(item, isElevated) : null;
  // A tenant-bound caller always has a tenant; an elevated one has whatever the
  // shell switcher says.
  const hasWorkingTenant = !isElevated || workingTenantName !== null;
  const scopes = item ? writableScopes(item, isElevated, hasWorkingTenant) : [];

  // TASK-969 F-1 — the twin. When the descriptor declares one, this drawer
  // edits a PAIR of keys rather than two scopes of one key, and the picker
  // chooses which half. Absent for every other key, which keeps the scope
  // picker below exactly as it was.
  const twinKey = item?.platformTierKey ?? null;
  const pairTargets = item ? pairTargetsFor(item, isElevated, hasWorkingTenant) : [];

  const [scope, setScope] = useState<SettingScope | null>(null);
  const [target, setTarget] = useState<PairTarget | null>(null);
  const activeTarget = target ?? defaultPairTarget(pairTargets);

  // The scope is a CONSEQUENCE of the chosen half, not a second choice: the
  // platform half is a `maxScope: 'system'` key and the tenant half's SYSTEM row
  // has no reader, so each half has exactly one legal scope.
  const activeScope: SettingScope = twinKey ? (activeTarget === 'platform' ? 'system' : 'tenant') : (scope ?? defaultScopeFor(scopes));
  const activeKey = twinKey && activeTarget === 'platform' ? twinKey : (item?.key ?? null);

  const settingQuery = useRegistrySetting(activeKey, activeScope, open);
  // The pairing lives on the TENANT half, so its read is where `pair` (both
  // values + which one the runtime applies) comes from — even while the PLATFORM
  // half is the one being edited. Same query key as the default target's read,
  // so flipping the picker is a cache hit, not a second request.
  const pairTenantQuery = useRegistrySetting(twinKey && activeTarget === 'platform' ? (item?.key ?? null) : null, 'tenant', open);
  const putSetting = usePutRegistrySetting();

  // `null` = untouched, so the value is DERIVED from the server during render
  // rather than synced in an effect: a post-conflict re-read lands immediately
  // without stomping in-progress input.
  const [edited, setEdited] = useState<string | null>(null);
  const [confirmedKillSwitch, setConfirmedKillSwitch] = useState(false);

  const stored = settingQuery.data?.data;
  const etag = settingQuery.data?.etag ?? null;
  // Whichever read carries it — the active one when the tenant half is selected,
  // the companion read when the platform half is.
  const tenantRead = activeTarget === 'tenant' ? stored : pairTenantQuery.data?.data;
  const pair = stored?.pair ?? pairTenantQuery.data?.data?.pair ?? null;
  const summary = item && twinKey ? pairSummary(item, pair, tenantRead?.value, workingTenantName) : null;
  const serverDraft = useMemo(() => (item ? toDraft(item.dataType, stored?.value) : ''), [item, stored]);
  const draft = edited ?? serverDraft;
  const dirty = edited !== null && edited !== serverDraft;

  const parsed = useMemo(() => (item ? fromDraft(item.dataType, draft) : { ok: false }), [item, draft]);
  const killWarning = item && parsed.ok ? killSwitchWarning(item, parsed.value) : null;
  const floor = item ? floorHint(item) : null;
  const failClosedUnset = item ? isUnsetAndFailClosed(item, stored?.sourceScope) : false;

  const reset = () => {
    setEdited(null);
    setConfirmedKillSwitch(false);
  };

  /**
   * A governance refusal, shown INLINE rather than as a toast.
   *
   * The picker no longer offers the dead SYSTEM scope on a paired key, so the
   * 400 that names the twin should be unreachable from here — but the API is
   * reachable without the console, and a refusal that explains WHICH key to
   * write instead is exactly the sentence that must not vanish after four
   * seconds. 412/428 keep their own `OccConflictAlert`; everything else still
   * toasts.
   */
  const refusal = putSetting.error instanceof GatewayError && putSetting.error.status === 400 ? putSetting.error.message : null;

  if (!item) return null;

  const onSave = () => {
    if (!parsed.ok) return;
    const writeKey = activeKey ?? item.key;
    // The half NOT being written. One read carries both values, so writing
    // either half stales the other's cache entry.
    const otherHalf = twinKey ? (writeKey === twinKey ? item.key : twinKey) : null;
    putSetting.mutate(
      { key: writeKey, value: parsed.value, scope: activeScope, etag, twinKey: otherHalf },
      {
        onSuccess: () => {
          reset();
          toast.success(`${writeKey} saved at ${activeScope} scope.`);
        },
        onError: (error) => {
          const status = error instanceof GatewayError ? error.status : undefined;
          if (status === 412) {
            // `OccConflictAlert` tells the admin their unsaved edits are kept
            // locally — resetting here would make that false. Re-read the
            // winning value and leave the typed draft in place; "Reload
            // latest" is the explicit discard (M2).
            void settingQuery.refetch();
            return;
          }
          if (status === 428) {
            // A stale tab / client bug, not a conflict to compare against — the
            // draft's precondition is meaningless here either way.
            reset();
            void settingQuery.refetch();
            return;
          }
          // A 400 is a governance refusal and is rendered inline instead — see
          // `refusal` above.
          if (status === 400) return;
          toast.error(error instanceof GatewayError ? error.message : `Could not save ${writeKey}.`);
        },
      },
    );
  };

  const needsKillSwitchConfirm = killWarning !== null && !confirmedKillSwitch;
  const saveDisabled = block !== null || !dirty || !parsed.ok || putSetting.isPending || needsKillSwitchConfirm;

  return (
    <Tabs defaultValue="value">
      <DetailDrawer
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            reset();
            setScope(null);
            setTarget(null);
          }
          onOpenChange(next);
        }}
        size="lg"
        title={
          // A pair has ONE title, and it cannot be either key: while the
          // platform half is selected, a title reading the tenant half's key
          // would name a row the Save button is not going to touch. The two real
          // keys move to the meta line below, where both are visible at once.
          twinKey ? <span className="text-sm font-medium">{item.label ?? item.key}</span> : <span className="font-mono text-sm">{item.key}</span>
        }
        badges={
          <>
            <Badge variant="outline" className="font-mono text-xs">
              {item.dataType}
            </Badge>
            {item.globalOnly ? (
              <Badge variant="secondary">
                <IconWorld aria-hidden className="size-3" />
                Platform-wide
              </Badge>
            ) : null}
            {item.killSwitch ? <Badge variant="destructive">Kill-switch</Badge> : null}
            {block ? (
              <Badge variant="outline">
                <IconLock aria-hidden className="size-3" />
                {block.label}
              </Badge>
            ) : null}
          </>
        }
        meta={
          twinKey ? (
            <span className="flex flex-wrap items-center gap-1 font-mono text-xs">
              <span>{item.key}</span>
              <span aria-hidden>&middot;</span>
              <span>{twinKey}</span>
            </span>
          ) : (
            <span>{item.label ?? item.category}</span>
          )
        }
        closeBlockedReason={putSetting.isPending ? 'a save is in progress' : undefined}
        tabs={
          <TabsList variant="line">
            <TabsTrigger value="value">Value</TabsTrigger>
            <TabsTrigger value="governance">Governance</TabsTrigger>
          </TabsList>
        }
        footer={
          block ? null : (
            <div className="flex w-full items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={reset} disabled={!dirty || putSetting.isPending}>
                Discard
              </Button>
              <Button size="sm" onClick={onSave} disabled={saveDisabled}>
                {putSetting.isPending ? <Spinner /> : null}
                Save
              </Button>
            </div>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <TabsContent value="value" className="flex flex-col gap-4">
            {item.description ? <p className="text-muted-foreground text-sm">{item.description}</p> : null}

            <OccConflictAlert
              error={putSetting.error}
              onReload={() => {
                reset();
                void settingQuery.refetch();
              }}
            />

            {refusal ? (
              <Alert variant="destructive">
                <IconAlertTriangle aria-hidden />
                <AlertTitle>The gateway refused this write</AlertTitle>
                <AlertDescription>{refusal}</AlertDescription>
              </Alert>
            ) : null}

            {block ? (
              <Alert>
                <IconLock aria-hidden />
                <AlertTitle>{block.label} — not editable here</AlertTitle>
                <AlertDescription>{block.reason}</AlertDescription>
              </Alert>
            ) : null}

            {failClosedUnset ? (
              <Alert variant="destructive">
                <IconAlertTriangle aria-hidden />
                <AlertTitle>Required, and not set</AlertTitle>
                <AlertDescription>
                  This key declares <span className="font-mono text-xs">failMode: closed</span> and no tier supplies a value. An unresolved read
                  RAISES rather than falling back — this is an outage waiting to happen, not a default.
                </AlertDescription>
              </Alert>
            ) : null}

            {settingQuery.isPending ? (
              <div className="flex flex-col gap-2" aria-hidden>
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-4 w-48" />
              </div>
            ) : settingQuery.error ? (
              <ErrorState error={settingQuery.error} onRetry={() => void settingQuery.refetch()} />
            ) : (
              <>
                {/* TASK-969 — ONE row, ONE picker, and each option names the
                    audience of the write rather than the transport that made it
                    two keys. The platform option writes the twin at `system`;
                    the tenant option writes this key at `tenant`. The dead
                    SYSTEM row of the tenant half is not reachable from here at
                    all — it is not a hidden option, it is not an option. */}
                {twinKey && pairTargets.length > 1 && !block ? (
                  <div className="flex flex-col gap-1.5">
                    <Label id={`${uid}-pair-label`}>Set for</Label>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      value={activeTarget}
                      aria-labelledby={`${uid}-pair-label`}
                      onValueChange={(next) => {
                        if (!next) return;
                        // A different half means a different row, so the draft's
                        // value AND its ETag precondition both stop applying —
                        // and a refusal about the old half stops being true.
                        reset();
                        putSetting.reset();
                        setTarget(next as PairTarget);
                      }}
                    >
                      {pairTargets.map((option) => (
                        <ToggleGroupItem key={option} value={option}>
                          {pairTargetLabel(option, workingTenantName)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <p className="text-muted-foreground text-xs">
                      {activeTarget === 'platform' ? (
                        <>
                          Saving writes <span className="font-mono">{twinKey}</span> on the reserved SYSTEM tenant — the value every tenant without
                          an override of its own inherits.
                        </>
                      ) : (
                        <>
                          Saving writes <span className="font-mono">{item.key}</span> as an override on {workingTenantName ?? 'the selected tenant'}{' '}
                          only. The platform default is left untouched.
                        </>
                      )}
                    </p>
                  </div>
                ) : null}

                {/* Both halves at once, and which one the RUNTIME applies.
                    Absent when the gateway did not send a pair block: `inForce`
                    is the one fact this screen must never infer — inferring it
                    from the generic cascade is what made a dead write look
                    live. */}
                {summary ? (
                  <p className="text-sm">
                    <span className={cx(summary.inForce === 'tenant' && 'font-medium')}>{summary.tenant}</span>
                    {/* Separators are decoration: the three clauses are whole
                        phrases, so a screen reader loses nothing by skipping the
                        glyphs, and the verdict is stated in WORDS rather than
                        carried by the arrow (rule 11 §10). */}
                    <span aria-hidden className="text-muted-foreground">
                      {' '}
                      &middot;{' '}
                    </span>
                    <span className={cx(summary.inForce === 'platform' && 'font-medium')}>{summary.platform}</span>
                    <span aria-hidden className="text-muted-foreground">
                      {' '}
                      &rarr;{' '}
                    </span>
                    <span className="font-medium">{summary.verdict}</span>
                  </p>
                ) : null}

                {!twinKey && scopes.length > 1 && !block ? (
                  <div className="flex flex-col gap-1.5">
                    <Label id={`${uid}-scope-label`}>Write at scope</Label>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      value={activeScope}
                      aria-labelledby={`${uid}-scope-label`}
                      onValueChange={(next) => {
                        if (!next) return;
                        // The version/ETag belongs to a SPECIFIC row, so
                        // switching scope invalidates the draft's precondition
                        // as well as its value — and any refusal about the row
                        // being left behind.
                        reset();
                        putSetting.reset();
                        setScope(next as SettingScope);
                      }}
                    >
                      {scopes.map((option) => (
                        <ToggleGroupItem key={option} value={option}>
                          {scopeLabel(option, workingTenantName)}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <p className="text-muted-foreground text-xs">
                      {activeScope === 'system'
                        ? 'Saving writes the PLATFORM row on the reserved SYSTEM tenant — the value every tenant without an override of its own inherits.'
                        : `Saving writes an override on ${workingTenantName ?? 'the selected tenant'} only. The platform default is left untouched.`}
                    </p>
                  </div>
                ) : null}

                {/* An elevated caller with no working tenant can only reach the
                    platform row, and that is worth SAYING rather than leaving as
                    an absent control: "why can I not set this for one tenant"
                    is the question the missing option provokes. */}
                {isElevated && !hasWorkingTenant && item.maxScope !== 'system' && !block ? (
                  <Alert>
                    <IconInfoCircle aria-hidden />
                    <AlertTitle>Editing the platform default</AlertTitle>
                    <AlertDescription>
                      No working tenant is selected, so this drawer writes the platform row. Select a tenant in the header to give that tenant an
                      override instead.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {isPlatformWideWrite(activeScope) && !block ? (
                  <Alert>
                    <IconWorld aria-hidden />
                    <AlertTitle>This write changes the platform for every tenant</AlertTitle>
                    <AlertDescription>
                      At <span className="font-mono text-xs">system</span> scope the value lands on the reserved SYSTEM tenant — the fallback every
                      tenant without an override of its own inherits. Super administrators only.
                    </AlertDescription>
                  </Alert>
                ) : null}

                {floor && activeScope !== 'system' ? (
                  <Alert>
                    <IconInfoCircle aria-hidden />
                    <AlertTitle>Tighten-only key</AlertTitle>
                    <AlertDescription>{floor}</AlertDescription>
                  </Alert>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  {/* "New value", not "Value": the Radix tab panel is already
                      labelled by its "Value" trigger, and two differently-scoped
                      things sharing one accessible name is confusing to navigate
                      by label. It also reads more honestly — this field is what
                      you are about to set, and the line beneath it says what is
                      answering today. */}
                  <Label htmlFor={`${uid}-value`}>New value</Label>
                  <RegistryValueEditor
                    id={`${uid}-value`}
                    dataType={item.dataType}
                    draft={draft}
                    onChange={(next) => {
                      setEdited(next);
                      setConfirmedKillSwitch(false);
                    }}
                    disabled={block !== null || putSetting.isPending}
                    ariaLabel={item.label ?? item.key}
                    describedBy={`${uid}-source`}
                    invalid={!parsed.ok}
                  />
                  <p id={`${uid}-source`} className="text-muted-foreground text-xs">
                    Currently answered by <span className="font-medium">{sourceScopeLabel(stored?.sourceScope)}</span>
                    {stored?.version ? <> · stored row v{stored.version}</> : <> · no row stored at this scope</>}
                  </p>
                  {!parsed.ok && parsed.error ? <p className="text-destructive text-sm">{parsed.error}</p> : null}
                </div>

                {killWarning ? (
                  <Alert variant="destructive">
                    <IconAlertTriangle aria-hidden />
                    <AlertTitle>Enabling a kill-switch</AlertTitle>
                    <AlertDescription>
                      <p>{killWarning}</p>
                      <Button
                        className="mt-2"
                        variant="destructive"
                        size="sm"
                        disabled={confirmedKillSwitch}
                        onClick={() => setConfirmedKillSwitch(true)}
                      >
                        {confirmedKillSwitch ? 'Confirmed' : 'I understand — enable it'}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}
          </TabsContent>

          <TabsContent value="governance">
            <GovernanceTab item={item} sourceScope={stored?.sourceScope} version={stored?.version} activeKey={activeKey ?? item.key} />
          </TabsContent>
        </div>
      </DetailDrawer>
    </Tabs>
  );
}
