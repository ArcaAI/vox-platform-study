import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import {
  DateRangeSelector,
  MetricChart,
  StatCard,
  StatusDot,
  TenantFilter,
  type DateRange,
  type RangePreset,
  type TenantOption,
} from '@arcaai/ui/components/metrics';
import {
  useAdminConsultations,
  useHealthCheck,
  useMonitoring,
  usePlatformMetrics,
  useTenants,
  useUsers,
  type AdminConsultation,
  type ConsumptionRollup,
  type Tenant,
} from '@arcaai/vox';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { endOfWeek, startOfWeek } from 'date-fns';
import { Building2, CirclePlus, Download, RotateCcw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import { bucketConsultations, CHART_SERIES, summarizeServiceHealth } from '@/features/tenant-dashboard';
import { formatBytes, formatCount } from '@/features/platform-dashboard';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { TenantFormDialog, type TenantDraft } from '@/features/tenants/tenant-form-dialog';
import { requireSuperAdmin } from '@/lib/route-guards';
import { useAuthStore } from '@/store/auth-store';

export const Route = createFileRoute('/_authenticated/dashboard')({
  staticData: { crumb: [{ label: 'Platform', to: null }, { label: 'Dashboard' }] },
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: PlatformDashboardPage,
});

/** Caption beneath the chart title ("last 7 days" / "this month" / "this year"). */
const RANGE_CAPTION: Record<RangePreset, string> = {
  week: 'last 7 days',
  month: 'this month',
  year: 'this year',
  custom: 'selected range',
};

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function PlatformDashboardPage() {
  const roles = useAuthStore((s) => s.user?.roles);
  const superAdmin = isSuperAdmin(roles);
  const navigate = useNavigate();

  const { list: listTenants, create: createTenant } = useTenants();
  const { listPaginated } = useUsers();
  const { list: listConsultations } = useAdminConsultations();
  const { sessions, refresh: refreshMonitoring } = useMonitoring();
  const { services, check } = useHealthCheck();
  // TASK-386 E3 (#18/#4/#5) — platform-wide consumption roll-up (transcription
  // minutes, summaries-24h, storage used/quota). Cross-tenant (no scope).
  const { refreshConsumption } = usePlatformMetrics();

  const [range, setRange] = useState<DateRange>(() => {
    const now = new Date();
    return { from: startOfWeek(now), to: endOfWeek(now), preset: 'week' };
  });

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantsTotal, setTenantsTotal] = useState<number | undefined>(undefined);
  const [usersTotal, setUsersTotal] = useState<number | undefined>(undefined);
  const [consultations, setConsultations] = useState<AdminConsultation[]>([]);
  const [consumption, setConsumption] = useState<ConsumptionRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // Cross-tenant fan-out across the available list/monitoring endpoints; there is
    // no aggregate platform-KPI endpoint (TARGET). Each source degrades independently,
    // but a failure of the focal consultations chart drives the error variant.
    void Promise.allSettled([
      listTenants({ limit: 100 }),
      listPaginated({ page: 1, limit: 1 }),
      listConsultations({ page: 1, limit: 200 }),
      refreshMonitoring(),
      check(),
      // TASK-386 E3 — platform-wide consumption (own settled slot; a failure
      // degrades the three consumption tiles to em-dash, never the focal chart).
      refreshConsumption(null),
    ]).then((results) => {
      const [tenantsRes, usersRes, consultRes, , , consumptionRes] = results;
      setTenants(tenantsRes.status === 'fulfilled' ? tenantsRes.value : []);
      setTenantsTotal(tenantsRes.status === 'fulfilled' ? tenantsRes.value.length : undefined);
      setUsersTotal(usersRes.status === 'fulfilled' ? usersRes.value.total : undefined);
      setConsultations(consultRes.status === 'fulfilled' ? consultRes.value.data : []);
      setConsumption(consumptionRes.status === 'fulfilled' ? consumptionRes.value : null);
      setError(consultRes.status === 'rejected' ? toError(consultRes.reason) : null);
      setLoading(false);
    });
  }, [listTenants, listPaginated, listConsultations, refreshMonitoring, check, refreshConsumption]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const health = useMemo(() => summarizeServiceHealth(services), [services]);
  const chartRows = useMemo(() => bucketConsultations(consultations, range), [consultations, range]);
  const chartTotal = useMemo(() => chartRows.reduce((sum, r) => sum + r.newVisits + r.revisits, 0), [chartRows]);
  const tenantOptions = useMemo<TenantOption[]>(() => tenants.map((t) => ({ id: t.id, name: t.name, key: String(t.key ?? '') })), [tenants]);
  const existingKeys = useMemo(() => tenants.map((t) => String(t.key ?? '').toLowerCase()).filter(Boolean), [tenants]);

  const activeSessions = sessions?.activeSessions;
  const processingJobs = sessions?.processingJobs;
  const degradedCount = health.degraded.length;
  const rangeCaption = RANGE_CAPTION[range.preset];

  const handleCreate = async (draft: TenantDraft) => {
    setIsSaving(true);
    try {
      await createTenant({ name: draft.name, key: draft.key || undefined, description: draft.description || undefined });
      toast.success('Tenant created');
      setCreateOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create tenant');
    } finally {
      setIsSaving(false);
    }
  };

  const headerActions = (
    <>
      <Button variant="outline" onClick={() => toast.info('Platform export is not available yet')}>
        <Download className="size-4" />
        Export
      </Button>
      <Button onClick={() => setCreateOpen(true)}>
        <CirclePlus className="size-4" />
        New tenant
      </Button>
    </>
  );

  const isEmpty = !loading && !error && (tenantsTotal ?? 0) === 0 && (usersTotal ?? 0) === 0 && consultations.length === 0;

  if (error && !loading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Platform Dashboard"
          description="Cross-tenant overview across all tenants, services, and sessions."
          actions={headerActions}
        />
        <Card className="p-10">
          <div role="alert" className="flex flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <TriangleAlert className="size-6 text-destructive" />
            </span>
            <div className="space-y-1">
              <p className="text-lg font-semibold">Couldn’t load platform metrics</p>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                We hit an error while fetching live cross-tenant metrics. This is usually a transient connection issue — retrying often resolves it.
              </p>
            </div>
            <Button onClick={load}>
              <RotateCcw className="size-4" />
              Retry
            </Button>
            <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
          </div>
        </Card>
        <TenantFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          existingKeys={existingKeys}
          isSaving={isSaving}
          onSave={handleCreate}
        />
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Platform Dashboard"
          description="Cross-tenant overview across all tenants, services, and sessions."
          actions={headerActions}
        />
        <Card className="p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Building2 />
              </EmptyMedia>
              <EmptyTitle>No platform activity yet</EmptyTitle>
              <EmptyDescription>
                There are no tenants, users, or consultations on the platform yet. Create the first tenant to start onboarding organizations.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <CirclePlus className="size-4" />
                New tenant
              </Button>
            </EmptyContent>
          </Empty>
        </Card>
        <TenantFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          mode="create"
          existingKeys={existingKeys}
          isSaving={isSaving}
          onSave={handleCreate}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Platform Dashboard"
        description="Cross-tenant overview across all tenants, services, and sessions."
        actions={headerActions}
      />

      {/* Headline KPIs — "is the platform healthy & busy right now" (REAL). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Active tenants"
          value={tenantsTotal == null ? undefined : formatCount(tenantsTotal)}
          isLoading={loading}
          accent="primary"
          hint="Organizations on the platform"
        />
        <StatCard label="Live sessions" value={activeSessions} isLoading={loading} accent="success" hint="Active consultations · live" />
        <StatCard label="Processing jobs" value={processingJobs} isLoading={loading} hint="STT · SMR · Harness queue" />
        <StatCard
          label="Degraded services"
          value={degradedCount}
          isLoading={loading}
          accent={degradedCount > 0 ? 'warning' : 'success'}
          footer={
            <StatusDot
              colorRole={degradedCount > 0 ? 'warning' : 'success'}
              label={<span className="text-xs text-muted-foreground">{degradedCount > 0 ? health.degraded.join(' · ') : 'All operational'}</span>}
            />
          }
        />
      </div>

      {/* Secondary KPIs — scale · two heaviest AI pipelines · capacity. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Total users"
          value={usersTotal == null ? undefined : formatCount(usersTotal)}
          isLoading={loading}
          accent="primary"
          hint="People & service accounts"
        />
        {/* TASK-386 E3 — REAL consumption roll-up (Postgres-derived; cross-tenant). */}
        <StatCard
          label="Transcription min · 24h"
          value={consumption ? formatCount(Math.round(consumption.transcriptionMinutes)) : undefined}
          isLoading={loading}
          hint="STT pipeline · last 24h"
        />
        <StatCard
          label="Summaries · 24h"
          value={consumption ? formatCount(consumption.summaries24h) : undefined}
          isLoading={loading}
          hint="SMR · last 24h"
        />
        <StatCard
          label="Storage used"
          value={consumption ? formatBytes(consumption.storageUsedBytes) : undefined}
          isLoading={loading}
          hint={consumption?.storageQuotaBytes != null ? `of ${formatBytes(consumption.storageQuotaBytes)} quota` : 'Accounted media storage'}
        />
      </div>

      {/* Focal cross-tenant consultation chart. */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Consultation sessions</h2>
            <p className="text-xs text-muted-foreground">All tenants · sessions per day · {rangeCaption}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {superAdmin && tenantOptions.length > 0 ? (
              <TenantFilter
                tenants={tenantOptions}
                value={null}
                allowAll
                onChange={(id) => {
                  if (id) navigate({ to: '/tenants/$tenantId/overview', params: { tenantId: id } });
                }}
                aria-label="Scope to a tenant dashboard"
                className="w-44"
              />
            ) : null}
            <DateRangeSelector value={range} onChange={setRange} presets={['week', 'month', 'year']} align="end" />
          </div>
        </div>
        <div className="mt-4">
          <MetricChart
            kind="bar"
            data={chartRows}
            xKey="label"
            series={[...CHART_SERIES]}
            height={300}
            showLegend
            isLoading={loading}
            aria-label="Consultation sessions per day across all tenants, new visits and re-visits"
          />
        </div>
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {chartTotal} session{chartTotal === 1 ? '' : 's'} · {rangeCaption}
        </p>
      </Card>

      <TenantFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mode="create"
        existingKeys={existingKeys}
        isSaving={isSaving}
        onSave={handleCreate}
      />
    </div>
  );
}
