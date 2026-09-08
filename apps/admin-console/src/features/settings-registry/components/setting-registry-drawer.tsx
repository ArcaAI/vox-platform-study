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
  defaultScopeFor,
  floorHint,
  isPlatformWideWrite,
  isUnsetAndFailClosed,
  killSwitchWarning,
  sourceScopeLabel,
  writableScopes,
  writeBlockFor,
} from './governance';
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
function GovernanceTab({ item, sourceScope, version }: { item: SettingCatalogItem; sourceScope: string | undefined; version: number | undefined }) {
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

  const [scope, setScope] = useState<SettingScope | null>(null);
  const activeScope = scope ?? defaultScopeFor(scopes);

  const settingQuery = useRegistrySetting(item?.key ?? null, activeScope, open);
  const putSetting = usePutRegistrySetting();

  // `null` = untouched, so the value is DERIVED from the server during render
  // rather than synced in an effect: a post-conflict re-read lands immediately
  // without stomping in-progress input.
  const [edited, setEdited] = useState<string | null>(null);
  const [confirmedKillSwitch, setConfirmedKillSwitch] = useState(false);

  const stored = settingQuery.data?.data;
  const etag = settingQuery.data?.etag ?? null;
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

  if (!item) return null;

  const onSave = () => {
    if (!parsed.ok) return;
    putSetting.mutate(
      { key: item.key, value: parsed.value, scope: activeScope, etag },
      {
        onSuccess: () => {
          reset();
          toast.success(`${item.key} saved at ${activeScope} scope.`);
        },
        onError: (error) => {
          const status = error instanceof GatewayError ? error.status : undefined;
          if (status === 412 || status === 428) {
            // Adopt whatever is now stored so the admin re-applies against the
            // winning value. Re-submitting is the overwrite OCC prevents.
            reset();
            void settingQuery.refetch();
            return;
          }
          toast.error(error instanceof GatewayError ? error.message : `Could not save ${item.key}.`);
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
          }
          onOpenChange(next);
        }}
        size="lg"
        title={<span className="font-mono text-sm">{item.key}</span>}
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
        meta={<span>{item.label ?? item.category}</span>}
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
                {scopes.length > 1 && !block ? (
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
                        // as well as its value.
                        reset();
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
            <GovernanceTab item={item} sourceScope={stored?.sourceScope} version={stored?.version} />
          </TabsContent>
        </div>
      </DetailDrawer>
    </Tabs>
  );
}
