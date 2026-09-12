'use client';

import type { ReactNode } from 'react';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useSession } from '@/shared/auth';
import { useTenantNames } from '@/shared/catalog';
import { formatBytes, formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { useTenantUsage } from '../api';
import type { TenantUsage } from '../api';
import { RecentActivityCard, ServicesStrip } from './platform-dashboard';

/** Card title — small semantic heading under the page h1. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm leading-none font-medium">{children}</h2>;
}

function storageHint(usage: TenantUsage): string {
  return usage.storageQuotaBytes === null ? 'no quota set' : `of ${formatBytes(usage.storageQuotaBytes)}`;
}

function UsageStrip({ usage }: { usage: ReturnType<typeof useTenantUsage> }) {
  if (usage.isError && !usage.data) {
    return <ErrorState title={'Couldn’t load tenant usage'} error={usage.error} onRetry={() => void usage.refetch()} />;
  }
  const isLoading = usage.isPending || (usage.isError && usage.isFetching);
  const data: TenantUsage | undefined = usage.data;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Consultations" value={data ? formatNumber(data.totalConsultations) : null} isLoading={isLoading} />
      <StatCard label="Transcription minutes" value={data ? formatNumber(data.transcriptionMinutes) : null} isLoading={isLoading} />
      <StatCard label="Summaries (24h)" value={data ? formatNumber(data.summaries24h) : null} isLoading={isLoading} />
      <StatCard
        label="Storage used"
        value={data ? formatBytes(data.storageUsedBytes) : null}
        hint={data ? storageHint(data) : undefined}
        isLoading={isLoading}
      />
    </div>
  );
}

function FootprintCard({ usage }: { usage: ReturnType<typeof useTenantUsage> }) {
  let body: ReactNode;
  if (usage.isPending) {
    body = (
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-4 w-full" />
        ))}
      </div>
    );
  } else if (usage.isError && !usage.data) {
    body = <ErrorState title={'Couldn’t load tenant usage'} error={usage.error} onRetry={() => void usage.refetch()} />;
  } else if (usage.data) {
    const rows: Array<[label: string, value: number]> = [
      ['Users', usage.data.totalUsers],
      ['Departments', usage.data.totalDepartments],
      ['Prompt templates', usage.data.totalPromptTemplates],
    ];
    body = (
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium tabular-nums">{formatNumber(value)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <Card className="gap-4">
      <CardHeader>
        <SectionTitle>Tenant footprint</SectionTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/**
 * Tenant Dashboard (`/dashboard` for a non-elevated session — TASK-954).
 *
 * Everything on it is a read the gateway already serves a tenant admin, scoped
 * to its OWN tenant: the usage snapshot (`admin/tenants/:id/usage`), the
 * downstream services it depends on (`admin/health/services`,
 * `read:TenantTelemetry`) and its own recent admin activity (`admin/audit-logs`,
 * tenant-scoped). Deliberately NO platform-wide numbers — requests/min, P95,
 * error rate and sockets are `manage:PlatformMetrics` and describe the whole
 * platform, not this tenant. Every region owns its loading / empty / error
 * states; a failed refetch keeps stale data behind an inline banner.
 */
export function TenantDashboard() {
  const session = useSession();
  // The effective identity's tenant: the impersonated target's, else the
  // caller's own (a tenant admin never has a working tenant).
  const tenantId = session.data ? (session.data.effectiveTenantId ?? session.data.effectiveUser.tenantId) : null;
  const tenantNames = useTenantNames();
  const usage = useTenantUsage(tenantId);
  const tenantName = tenantId ? (tenantNames.get(tenantId) ?? tenantId) : null;

  return (
    <ScreenTemplate
      header={<PageHeader title="Tenant Dashboard" meta={tenantName ? <span>{tenantName}</span> : <Skeleton className="h-4 w-40" />} />}
      stats={
        <section aria-label="Key metrics">
          <UsageStrip usage={usage} />
        </section>
      }
      statusBanner={usage.isError && usage.data ? <ErrorBanner error={usage.error} onRetry={() => void usage.refetch()} /> : null}
      footer={
        <StatusFooter
          start={
            <span>
              Auto-refresh 30s
              {usage.data ? ` · updated ${formatRelativeTime(new Date(usage.dataUpdatedAt))}` : ''}
            </span>
          }
          end={
            <span aria-hidden className="font-mono">
              GET /admin/tenants/:id/usage · 30s
            </span>
          }
        />
      }
    >
      <div className="flex flex-col gap-4">
        <section aria-label="Services">
          <ServicesStrip />
        </section>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <FootprintCard usage={usage} />
          {/* No "Audit Logs" link: `/audit-logs` is a tier-10-19 screen a tenant admin cannot open. */}
          <RecentActivityCard />
        </div>
      </div>
    </ScreenTemplate>
  );
}
