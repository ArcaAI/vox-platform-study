'use client';

import { Fragment, useId, useState } from 'react';
import { IconExternalLink, IconShieldCheck } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { useSession } from '@/shared/auth';
import { formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useGlobalHarnessPolicy, useHarnessPolicy, useUpdateHarnessPolicy, type HarnessPolicy, type HarnessPolicySource } from '../api';
import { HarnessPolicyForm } from './harness-policy-form';
import { LiveConfigTab } from './live-config-tab';
import { fieldDisplayValue, POLICY_FIELDS, TENANT_LOCKED_POLICY_KEYS } from './policy-fields';

const TAB_VALUES = ['policy', 'live', 'global'] as const;

const SOURCE_LABELS: Record<HarnessPolicySource, string> = {
  tenant: 'tenant row',
  'system-default': 'global default row',
  'code-default': 'code defaults',
};

/** Compact key/value summary of the resolved effective policy (frame 36 panel a). */
function EffectiveResolveCard({ policy }: { policy: HarnessPolicy }) {
  const uid = useId();
  const summary: { label: string; value: string }[] = [
    { label: 'safety', value: policy.safetyEnabled ? 'on' : 'off' },
    { label: 'phi', value: policy.phiEnabled ? (policy.phiFailClosed ? 'on \u00b7 fail-closed' : 'on') : 'off' },
    { label: 'safety model', value: `${policy.safetyProvider} / ${policy.safetyModel}` },
    { label: 'smr model', value: policy.smrProvider && policy.smrModel ? `${policy.smrProvider} / ${policy.smrModel}` : 'service chooses' },
    { label: 'max regen', value: String(policy.maxRegen) },
    { label: 'gate sla', value: `${policy.gateSlaSeconds} s` },
    { label: 'gate escalation', value: `${policy.gateEscalationSeconds} s` },
    { label: 'tools', value: policy.toolAllowlist && policy.toolAllowlist.length > 0 ? policy.toolAllowlist.join(', ') : 'all allowed' },
  ];
  return (
    <Card className="gap-3 p-4" aria-labelledby={`${uid}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${uid}-title`} className="text-sm font-semibold">
          Effective policy resolve
        </h2>
        <Badge variant={policy.source === 'tenant' ? 'default' : 'secondary'}>{SOURCE_LABELS[policy.source]}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        {summary.map((row) => (
          <Fragment key={row.label}>
            <dt className="text-muted-foreground font-mono text-xs">{row.label}</dt>
            <dd className="min-w-0 truncate font-mono text-xs">{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs">
        Effective = tenant row over global default (fallback)
        {policy.updatedAt ? <> &middot; updated {formatRelativeTime(policy.updatedAt)}</> : null}
      </p>
    </Card>
  );
}

/** Settings grid comparing the tenant-effective and global-default values (panel b). */
function SettingsComparisonGrid({
  policy,
  globalPolicy,
  isElevated,
}: {
  policy: HarnessPolicy;
  globalPolicy: HarnessPolicy | null;
  isElevated: boolean;
}) {
  // Fixed 3-column comparison of one resolved record's fields (design-spec Rule 3
  // "non-list display") — the shadcn Table primitive, not a data grid.
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border">
        <Table aria-label="Tenant vs global default settings">
          <TableHeader>
            <TableRow>
              <TableHead className="font-mono text-xs">Setting</TableHead>
              <TableHead className="font-mono text-xs">Tenant</TableHead>
              <TableHead className="font-mono text-xs">Global default</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {POLICY_FIELDS.map((field) => (
              <TableRow key={field.key}>
                <TableCell className="font-mono text-xs">{field.key}</TableCell>
                <TableCell className="font-mono text-xs">{fieldDisplayValue(field, policy)}</TableCell>
                <TableCell className="font-mono text-xs">
                  {globalPolicy ? fieldDisplayValue(field, globalPolicy) : <span className="text-muted-foreground">{'\u2014'}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!isElevated ? (
        <p className="text-muted-foreground text-xs">The global default column is visible to global admins only (platform-asserted read).</p>
      ) : null}
    </div>
  );
}

/** Skeletons mirroring the resolve card + grid + form (rule 10). */
function PolicyTabSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden>
      <Skeleton className="h-48 w-full max-w-xl" />
      <div className="flex flex-col gap-3 rounded-md border p-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-8 w-full" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

/** Tenant policy tab: resolve card, comparison grid and the OCC save panel. */
function TenantPolicyTab({ isElevated }: { isElevated: boolean }) {
  const uid = useId();
  const policyQuery = useHarnessPolicy();
  const globalQuery = useGlobalHarnessPolicy(isElevated);
  const updateMutation = useUpdateHarnessPolicy();
  const [customizing, setCustomizing] = useState(false);

  if (policyQuery.isPending) return <PolicyTabSkeleton />;
  if (policyQuery.error || !policyQuery.data) {
    return <ErrorState error={policyQuery.error} onRetry={() => void policyQuery.refetch()} />;
  }

  const policy = policyQuery.data.data;
  const etag = policyQuery.data.etag;
  const globalPolicy = globalQuery.data?.data ?? null;
  // No tenant override row yet — values inherit the global default (frame 36
  // empty variant). "Customize for tenant" reveals the editor; the first
  // save creates the tenant row.
  const inherited = policy.source !== 'tenant';

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <EffectiveResolveCard policy={policy} />
        <SettingsComparisonGrid policy={policy} globalPolicy={globalPolicy} isElevated={isElevated} />
      </div>
      {inherited && !customizing ? (
        <EmptyState
          icon={IconShieldCheck}
          title="No tenant override yet"
          description="All values inherit the global default row. Customizing creates a tenant policy row on first save."
          action={<Button onClick={() => setCustomizing(true)}>Customize for tenant</Button>}
        />
      ) : (
        <section aria-labelledby={`${uid}-save`} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 id={`${uid}-save`} className="text-base font-semibold">
              Tenant policy editor
            </h2>
            <p className="text-muted-foreground text-sm">
              Sparse patch over the effective policy &mdash; <span className="font-mono text-xs">PATCH /admin/harness/policy</span> with If-Match;
              drift returns 412 with reload-merge.
            </p>
          </div>
          <HarnessPolicyForm
            policy={policy}
            etag={etag}
            mutation={updateMutation}
            onReloadLatest={() => void policyQuery.refetch()}
            successMessage="Tenant harness policy saved"
            // Safety/PHI switches are global-only
            // server-side; render them read-only rather than let a
            // save 403.
            lockedKeys={TENANT_LOCKED_POLICY_KEYS}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Global default tab (elevated only) — READ-ONLY summary of the SYSTEM-tenant
 * fallback row.
 *
 * This tab used to mount a SECOND `HarnessPolicyForm` against
 * `PATCH /admin/harness/policy/global` — the same row `/agentic-policy` (tier
 * 10-19) edits. One authoritative editor per backend resource, so the form is
 * gone and this reads the row and deep-links to the owner. Keeping the READ here
 * is deliberate: the tenant-vs-global comparison only makes sense side by side.
 */
function GlobalDefaultTab() {
  const uid = useId();
  const globalQuery = useGlobalHarnessPolicy(true);

  if (globalQuery.isPending) return <PolicyTabSkeleton />;
  if (globalQuery.error || !globalQuery.data) {
    return <ErrorState error={globalQuery.error} onRetry={() => void globalQuery.refetch()} />;
  }

  const globalPolicy = globalQuery.data.data;

  return (
    <section aria-labelledby={`${uid}-global`} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${uid}-global`} className="text-base font-semibold">
          Global default
        </h2>
        <p className="text-muted-foreground text-sm">
          SYSTEM-tenant GLOBAL-DEFAULT row &mdash; the fallback for every tenant without an override. Edited from Agentic policy, which owns this row.
        </p>
      </div>

      <Card className="gap-3 p-4">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {POLICY_FIELDS.map((field) => (
            <div key={field.key} className="flex items-baseline justify-between gap-3 border-b py-1 last:border-b-0">
              <dt className="text-muted-foreground text-xs">{field.label}</dt>
              <dd className="font-mono text-xs">{fieldDisplayValue(field, globalPolicy)}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="flex justify-end">
        {/* Plain href, not a cross-feature import (rule 13 isolation). */}
        <Button variant="outline" asChild>
          <a href="/agentic-policy?tab=policy">
            <IconExternalLink aria-hidden />
            Edit in Agentic policy
          </a>
        </Button>
      </div>
    </section>
  );
}

/**
 * Frame 36 — Harness Policy & Live Config (/harness/policy, tier 30-49).
 * Tenant-scoped effective policy with the tenant-vs-global comparison grid
 * and OCC If-Match editing; the Live config (engine kill-switch) and Global
 * default tabs are platform-asserted server-side, so both render for
 * elevated sessions only.
 */
export function HarnessPolicyScreen() {
  const session = useSession();
  const isElevated = session.data?.isElevated ?? false;
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('policy'));
  const requestedTab = (TAB_VALUES as readonly string[]).includes(tabParam) ? tabParam : 'policy';
  // The live-config + global-default routes assert platform admin in code.
  const tab = requestedTab !== 'policy' && !isElevated ? 'policy' : requestedTab;

  return (
    <WorkingTenantGate
      title="Harness Policy & Live Config"
      meta={
        <span aria-hidden className="text-muted-foreground font-mono text-xs">
          GET /admin/harness/policy
        </span>
      }
    >
      <Tabs className="flex min-h-0 flex-1 flex-col" value={tab} onValueChange={(next) => void setTabParam(next === 'policy' ? null : next)}>
        <ScreenTemplate
          header={<PageHeader title="Harness Policy & Live Config" meta={<span>every edit appends a HarnessPolicyChange WORM row</span>} />}
          tabs={
            <TabsList variant="line">
              <TabsTrigger value="policy">Tenant policy</TabsTrigger>
              {isElevated ? <TabsTrigger value="live">Live config</TabsTrigger> : null}
              {isElevated ? <TabsTrigger value="global">Global default</TabsTrigger> : null}
            </TabsList>
          }
          footer={
            <StatusFooter
              end={
                <span aria-hidden className="font-mono">
                  GET /admin/harness/policy
                </span>
              }
            />
          }
        >
          <TabsContent value="policy">
            <TenantPolicyTab isElevated={isElevated} />
          </TabsContent>
          {isElevated ? (
            <TabsContent value="live">
              <LiveConfigTab />
            </TabsContent>
          ) : null}
          {isElevated ? (
            <TabsContent value="global">
              <GlobalDefaultTab />
            </TabsContent>
          ) : null}
        </ScreenTemplate>
      </Tabs>
    </WorkingTenantGate>
  );
}
