'use client';

import { useId } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { IconBuildingHospital } from '@tabler/icons-react';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@arcaai/ui/components/shadcn/tabs';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { GatewayError } from '@/shared/api';
import { CopyButton } from '@/shared/copy-button';
import { formatBytes, formatDateTime, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import { useSession } from '@/shared/auth';
import type { CapabilityUsageRow, EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { TenantPlan } from '@/features/tenants/api/types';
import { useMyEntitlements, useMyTenant } from '../api/hooks';
import { TenantSettingsTab } from './tenant-settings-tab';

const EM_DASH = '—';

const PLAN_LABELS: Record<TenantPlan, string> = {
  ENTERPRISE: 'Enterprise',
  PRO: 'Pro',
  STARTER: 'Starter',
  TRIAL: 'Trial',
};

/** Display names for the gateway's stable capability keys (unknown keys render as-is). */
const CAPABILITY_LABELS: Record<string, string> = {
  users: 'Users',
  departments: 'Departments',
  promptTemplates: 'Prompt templates',
  asrPipelines: 'ASR pipelines',
  apiKeys: 'API keys',
  storageBytes: 'Storage',
  concurrentSessions: 'Concurrent sessions',
  monthlyConsultations: 'Consultations',
  monthlyTranscriptionMinutes: 'Transcription minutes',
  monthlySummaries: 'Summaries',
};

const FEATURE_LABELS: { key: keyof EntitlementCapabilities['features']; label: string }[] = [
  { key: 'dnaReports', label: 'DNA reports' },
  { key: 'voiceEnrollment', label: 'Voice enrollment' },
  { key: 'monitoringAccess', label: 'Monitoring access' },
];

const ALL_TABS = [
  { value: 'organization', label: 'Organization' },
  { value: 'plan', label: 'Plan & usage' },
  { value: 'settings', label: 'Settings' },
] as const;

/**
 * GET /tenant/me answers 400 for a session without tenant context (and a
 * cross-tenant read would surface as 404) — both mean "pick a working
 * tenant", not a failure (frame 25 NoTenant variant).
 */
function isNoTenantError(error: unknown): boolean {
  return error instanceof GatewayError && (error.status === 400 || error.isNotFound);
}

function capabilityUsage(row: CapabilityUsageRow): string {
  const format = row.key === 'storageBytes' ? formatBytes : formatNumber;
  const used = format(row.used ?? null);
  return row.unlimited ? `${used} / Unlimited` : `${used} / ${format(row.limit ?? null)}`;
}

function IdentityField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground text-xs font-medium">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1 text-sm">{children}</dd>
    </div>
  );
}

function CapabilityList({ title, rows }: { title: string; rows: CapabilityUsageRow[] }) {
  return (
    <Card className="gap-3 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <dl className="flex flex-col gap-2">
        {rows.map((row) => (
          <div key={row.key} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-muted-foreground text-sm">{CAPABILITY_LABELS[row.key] ?? row.key}</dt>
            <dd className="flex items-center gap-2 text-sm">
              <span className="tabular-nums">{capabilityUsage(row)}</span>
              {row.exceeded ? (
                <StatusBadge label="Exceeded" colorRole="destructive" icon={<StatusDot colorRole="destructive" size="sm" />} />
              ) : row.nearLimit ? (
                <StatusBadge label="Near limit" colorRole="warning" icon={<StatusDot colorRole="warning" size="sm" />} />
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Skeletons mirroring the loaded identity region (rule 10). */
function TenantProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      <Card className="p-6">
        <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-40 max-w-full" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/** Plan & usage tab body — entitlement badges + capability/feature cards. */
function PlanUsagePanel() {
  const entitlementsQuery = useMyEntitlements();
  const capabilities = entitlementsQuery.data;

  if (entitlementsQuery.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-40" />
        ))}
      </div>
    );
  }
  if (entitlementsQuery.error || !capabilities) {
    return <ErrorState error={entitlementsQuery.error} onRetry={() => void entitlementsQuery.refetch()} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">Resolved limits and live usage for this tenant. Limits are managed by the platform team.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
          model: {capabilities.modelTier}
        </Badge>
        <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
          rate tier: {capabilities.rateLimitTier}
        </Badge>
        <Badge variant="outline" className="text-muted-foreground font-mono text-[10px]">
          enforcement: {capabilities.enforcementEnabled ? 'on' : 'off'}
        </Badge>
        {capabilities.trial.isTrial ? (
          capabilities.trial.expired ? (
            <StatusBadge label="Trial expired" colorRole="destructive" icon={<StatusDot colorRole="destructive" size="sm" />} />
          ) : (
            <StatusBadge
              label={`Trial ends ${formatDateTime(capabilities.trial.trialEndsAt, 'date')}`}
              colorRole="warning"
              icon={<StatusDot colorRole="warning" size="sm" />}
            />
          )
        ) : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <CapabilityList title="Quantity limits" rows={capabilities.quantities} />
        <CapabilityList title="Monthly meters" rows={capabilities.meters} />
        <Card className="gap-3 p-4">
          <h3 className="text-sm font-semibold">Features</h3>
          <dl className="flex flex-col gap-2">
            {FEATURE_LABELS.map((feature) => (
              <div key={feature.key} className="flex flex-wrap items-center justify-between gap-2">
                <dt className="text-muted-foreground text-sm">{feature.label}</dt>
                <dd>
                  {capabilities.features[feature.key] ? (
                    <StatusBadge label="Enabled" colorRole="success" icon={<StatusDot colorRole="success" size="sm" />} />
                  ) : (
                    <StatusBadge label="Disabled" colorRole="neutral" icon={<StatusDot colorRole="neutral" size="sm" />} />
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}

/**
 * Frame 25 (tenant half) — Tenant profile (/tenant-profile, tier 20-29).
 * Self-service view of the working tenant, reframed into three tabs:
 * Organization (read-only identity — no self-serve tenant PATCH exists), Plan &
 * usage (entitlement/usage snapshot), and Settings (category sub-nav over the
 * editable tenant/me/config rows). Tenant-less global admins get the frame's
 * NoTenant empty state.
 */
export function TenantProfileScreen() {
  const uid = useId();
  const tenantQuery = useMyTenant();
  const session = useSession();
  // While impersonating (or for a real end-user), only the
  // basic org identity + a read-only Settings tab render; Plan & usage
  // (limits/meters/entitlements) is admin-only. Defaults to false (safe)
  // until the session resolves, matching the harness-policy-screen pattern.
  const effectiveIsElevated = session.data?.effectiveIsElevated ?? false;
  const tabs = effectiveIsElevated ? ALL_TABS : ALL_TABS.filter((t) => t.value !== 'plan');
  const entitlementsQuery = useMyEntitlements(effectiveIsElevated);
  const [tabParam, setTabParam] = useQueryState('tab', parseAsString.withDefault('organization'));

  const tenant = tenantQuery.data;
  const tab = tabs.some((t) => t.value === tabParam) ? tabParam : 'organization';
  const isBusy = tenantQuery.isFetching || entitlementsQuery.isFetching;

  const header = (
    <PageHeader
      title="Tenant profile"
      meta={
        tenant ? (
          <>
            <span>{tenant.name}</span>
            <span aria-hidden>&middot;</span>
            <span className="font-mono text-xs">{tenant.key}</span>
          </>
        ) : null
      }
    />
  );
  const footer = (
    <StatusFooter
      start={<span>{isBusy ? 'Refreshing' : 'Up to date'}</span>}
      end={
        <span aria-hidden className="font-mono">
          GET /tenant/me
        </span>
      }
    />
  );

  // Gate the whole screen on the identity read (skeleton / no-tenant / error);
  // the tabbed content only mounts once a working tenant resolves.
  if (tenantQuery.isPending) {
    return (
      <ScreenTemplate header={header} footer={footer}>
        <TenantProfileSkeleton />
      </ScreenTemplate>
    );
  }
  if (isNoTenantError(tenantQuery.error)) {
    return (
      <ScreenTemplate header={header} footer={footer}>
        <EmptyState
          icon={IconBuildingHospital}
          title="No working tenant selected"
          description="Select a working tenant to view its profile. Global admins act on one tenant at a time — pick one from the tenant switcher in the top bar."
        />
      </ScreenTemplate>
    );
  }
  if (tenantQuery.error || !tenant) {
    return (
      <ScreenTemplate header={header} footer={footer}>
        <ErrorState error={tenantQuery.error} onRetry={() => void tenantQuery.refetch()} />
      </ScreenTemplate>
    );
  }

  return (
    <Tabs value={tab} onValueChange={(next) => void setTabParam(next === 'organization' ? null : next)} className="flex min-h-0 flex-1 flex-col">
      <ScreenTemplate
        contentMode={tab === 'settings' ? 'fill' : 'scroll'}
        header={header}
        tabs={
          <TabsList variant="line">
            {tabs.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        }
        footer={footer}
      >
        <TabsContent value="organization">
          <section aria-labelledby={`${uid}-identity`} className="flex flex-col gap-3">
            <h2 id={`${uid}-identity`} className="sr-only">
              Organization
            </h2>
            <Card className="p-6">
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
                <IdentityField label="Organization name">
                  <span className="font-medium">{tenant.name}</span>
                </IdentityField>
                <IdentityField label="Status">
                  <ResourceStatusBadge status={tenant.resourceStatus} />
                </IdentityField>
                {effectiveIsElevated ? (
                  <>
                    <IdentityField label="Tenant key">
                      <span className="truncate font-mono text-xs">{tenant.key}</span>
                      <CopyButton value={tenant.key} label="Copy tenant key" />
                    </IdentityField>
                    <IdentityField label="Plan">
                      {tenant.plan ? (
                        <Badge variant="secondary">{PLAN_LABELS[tenant.plan]}</Badge>
                      ) : (
                        <span className="text-muted-foreground">{EM_DASH}</span>
                      )}
                    </IdentityField>
                    <IdentityField label="Description">
                      {tenant.description ? tenant.description : <span className="text-muted-foreground">{EM_DASH}</span>}
                    </IdentityField>
                    <IdentityField label="Tags">
                      {tenant.tags.length > 0 ? (
                        tenant.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted-foreground">{EM_DASH}</span>
                      )}
                    </IdentityField>
                    <IdentityField label="Created">{formatDateTime(tenant.createdAt)}</IdentityField>
                    <IdentityField label="Updated">{formatRelativeTime(tenant.updatedAt)}</IdentityField>
                  </>
                ) : null}
              </dl>
            </Card>
          </section>
        </TabsContent>
        {effectiveIsElevated ? (
          <TabsContent value="plan">
            <section aria-labelledby={`${uid}-entitlements`} className="flex flex-col gap-3">
              <h2 id={`${uid}-entitlements`} className="sr-only">
                Plan &amp; usage
              </h2>
              <PlanUsagePanel />
            </section>
          </TabsContent>
        ) : null}
        <TabsContent value="settings" className="flex min-h-0 flex-1 flex-col">
          <section aria-labelledby={`${uid}-settings`} className="flex min-h-0 flex-1 flex-col gap-3">
            <h2 id={`${uid}-settings`} className="sr-only">
              Tenant settings
            </h2>
            <TenantSettingsTab readOnly={!effectiveIsElevated} />
          </section>
        </TabsContent>
      </ScreenTemplate>
    </Tabs>
  );
}
