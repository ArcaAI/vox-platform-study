import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { ItemList } from '@arcaai/ui/components/collection';
import {
    DateRangeSelector,
    MetricChart,
    ServiceStatusItem,
    StatCard,
    StatusDot,
    TenantFilter,
    type DateRange,
    type RangePreset,
    type TenantOption,
} from '@arcaai/ui/components/metrics';
import {
    useAdminConsultations,
    useAuditLog,
    useDepartments,
    useHealthCheck,
    useMonitoring,
    useTenants,
    useUsers,
    type AdminConsultation,
    type AuditLogEntry,
    type TenantUsageStats,
} from '@arcaai/vox';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { endOfWeek, startOfWeek } from 'date-fns';
import { ArrowRight, CirclePlus, RotateCcw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    audioPipelineRows,
    bucketConsultations,
    CHART_SERIES,
    countPendingReview,
    filterToday,
    formatRelativeTime,
    scopeToTenant,
    splitVisits,
    summarizeServiceHealth,
    toActivityItems,
    type ActivityItem,
} from '@/features/tenant-dashboard';
import { formatCount } from '@/features/platform-dashboard';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/overview')({
    component: TenantOverviewPage,
});

/** Caption beneath the chart title + in its footer ("last 7 days" / "this month"). */
const RANGE_CAPTION: Record<RangePreset, string> = {
    week: 'last 7 days',
    month: 'this month',
    year: 'this year',
    custom: 'selected range',
};

function toError(reason: unknown): Error {
    return reason instanceof Error ? reason : new Error(String(reason));
}

function TenantOverviewPage() {
    const { tenantId } = Route.useParams();
    const tenant = useTenantDetailStore((s) => s.tenant);
    const roles = useAuthStore((s) => s.user?.roles);
    const superAdmin = isSuperAdmin(roles);
    const navigate = useNavigate();

    const { listPaginated } = useUsers();
    const { list: listDepartments } = useDepartments();
    const { list: listConsultations } = useAdminConsultations();
    const { list: listAudit } = useAuditLog();
    const { sessions, refresh: refreshMonitoring } = useMonitoring();
    const { services, lastChecked, check } = useHealthCheck();
    const { list: listTenants, getUsage } = useTenants();

    const [range, setRange] = useState<DateRange>(() => {
        const now = new Date();
        return { from: startOfWeek(now), to: endOfWeek(now), preset: 'week' };
    });

    const [usersTotal, setUsersTotal] = useState<number | undefined>(undefined);
    const [deptCount, setDeptCount] = useState<number | undefined>(undefined);
    const [consultations, setConsultations] = useState<AdminConsultation[]>([]);
    const [activity, setActivity] = useState<AuditLogEntry[]>([]);
    const [tenantOptions, setTenantOptions] = useState<TenantOption[]>([]);
    const [usage, setUsage] = useState<TenantUsageStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const load = useCallback(() => {
        setLoading(true);
        setError(null);
        // The dashboard fans out across the available list/monitoring endpoints; there
        // is no aggregate KPI endpoint (TARGET). Each source degrades independently, but
        // a failure of the focal consultations metric drives the error variant.
        void Promise.allSettled([
            listPaginated({ page: 1, limit: 1 }),
            listDepartments(),
            listConsultations({ page: 1, limit: 200 }),
            listAudit({ limit: 8 }),
            refreshMonitoring(),
            check(),
            // TASK-386 E5 — tenant usage roll-up (own settled slot; degrades the
            // Consumption tile to em-dash without touching the focal error).
            getUsage(tenantId),
        ]).then((results) => {
            const [usersRes, deptRes, consultRes, auditRes, , , usageRes] = results;
            setUsersTotal(usersRes.status === 'fulfilled' ? usersRes.value.total : undefined);
            setDeptCount(deptRes.status === 'fulfilled' ? deptRes.value.length : undefined);
            setConsultations(consultRes.status === 'fulfilled' ? consultRes.value.data : []);
            setActivity(auditRes.status === 'fulfilled' ? scopeToTenant(auditRes.value, tenantId) : []);
            setUsage(usageRes.status === 'fulfilled' ? usageRes.value : null);
            setError(consultRes.status === 'rejected' ? toError(consultRes.reason) : null);
            setLoading(false);
        });
    }, [listPaginated, listDepartments, listConsultations, listAudit, refreshMonitoring, check, getUsage, tenantId]);

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tenantId]);

    // Super-admins get a tenant switcher on the chart; selecting re-navigates to that
    // tenant's dashboard (which re-scopes every source). Tenant-admins stay pinned.
    useEffect(() => {
        if (!superAdmin) return;
        listTenants({ limit: 100 })
            .then((ts) => setTenantOptions(ts.map((t) => ({ id: t.id, name: t.name, key: String(t.key ?? '') }))))
            .catch(() => setTenantOptions([]));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [superAdmin]);

    const health = useMemo(() => summarizeServiceHealth(services), [services]);
    const pipeline = useMemo(() => audioPipelineRows(services), [services]);
    const today = useMemo(() => splitVisits(filterToday(consultations)), [consultations]);
    const pendingReview = useMemo(() => countPendingReview(consultations), [consultations]);
    const chartRows = useMemo(() => bucketConsultations(consultations, range), [consultations, range]);
    const chartTotal = useMemo(() => chartRows.reduce((sum, r) => sum + r.newVisits + r.revisits, 0), [chartRows]);
    const activityItems = useMemo(() => toActivityItems(activity), [activity]);

    const activeSessions = sessions?.activeSessions;
    const processingJobs = sessions?.processingJobs;
    const rangeCaption = RANGE_CAPTION[range.preset];
    const syncedAt = lastChecked ? formatRelativeTime(lastChecked.toISOString()) : null;

    const healthHint = health.allHealthy
        ? 'All systems operational'
        : health.degraded.length > 0
          ? `${health.degraded.join(', ')} degraded`
          : health.hasUnhealthy
            ? 'Service outage'
            : 'Awaiting health check';
    const healthRole = health.allHealthy ? 'success' : health.hasUnhealthy ? 'destructive' : 'warning';

    const isEmpty =
        !loading && !error && (usersTotal ?? 0) === 0 && (deptCount ?? 0) === 0 && consultations.length === 0 && activity.length === 0;

    const banner = superAdmin ? (
        <ActingOnBanner
            tenantName={tenant?.name ?? 'this tenant'}
            description="Full control: create, edit, disable & archive. The system tenant (__GLOBAL__) is protected — edit/disable disabled. A tenant-admin sees this tab read-only."
        />
    ) : (
        <div role="status" className="flex items-start gap-2.5 rounded-lg border bg-muted/40 px-3.5 py-2.5 text-sm">
            <StatusDot colorRole="info" className="mt-0.5" />
            <div className="min-w-0">
                <p className="font-medium text-foreground">Tenant admin · {tenant?.name ?? 'your workspace'}</p>
                <p className="text-muted-foreground">
                    Read-only metrics view scoped to your organization. Monitor activity and configuration; contact a super-admin to make
                    tenant-level changes.
                </p>
            </div>
        </div>
    );

    if (error && !loading) {
        return (
            <div className="space-y-5">
                <Card className="p-10">
                    <div role="alert" className="flex flex-col items-center justify-center gap-3 text-center">
                        <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                            <TriangleAlert className="size-6 text-destructive" />
                        </span>
                        <div className="space-y-1">
                            <p className="text-lg font-semibold">Couldn’t load tenant metrics</p>
                            <p className="mx-auto max-w-md text-sm text-muted-foreground">
                                We hit an error while fetching live metrics for {tenant?.name ?? 'this tenant'}. This is usually a transient
                                connection issue — retrying often resolves it.
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center justify-center gap-2">
                            <Button onClick={load}>
                                <RotateCcw className="size-4" />
                                Retry
                            </Button>
                            <Button variant="outline" asChild>
                                <Link to="/system-health">View status page</Link>
                            </Button>
                        </div>
                        <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
                    </div>
                </Card>
                {banner}
            </div>
        );
    }

    if (isEmpty) {
        return (
            <div className="space-y-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <StatCard label="Active users" value={0} hint="Invite the first user" />
                    <StatCard label="Departments" value={0} hint="Create a department" />
                    <StatCard label="Running sessions" value={0} hint="No live consultations" />
                    <StatCard label="Audio pipeline" value="Idle" hint="No active streams" />
                </div>
                <Card className="p-6">
                    <Empty>
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <CirclePlus />
                            </EmptyMedia>
                            <EmptyTitle>No activity in this tenant yet</EmptyTitle>
                            <EmptyDescription>
                                {tenant?.name ?? 'This tenant'} has no consultations, users, or audit history yet. Invite users and create
                                departments to start capturing activity.
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <div className="flex flex-wrap items-center justify-center gap-2">
                                <Button onClick={() => navigate({ to: '/tenants/$tenantId/users', params: { tenantId } })}>Invite users</Button>
                                <Button
                                    variant="outline"
                                    onClick={() => navigate({ to: '/tenants/$tenantId/departments', params: { tenantId } })}
                                >
                                    Create department
                                </Button>
                            </div>
                        </EmptyContent>
                    </Empty>
                </Card>
                {banner}
            </div>
        );
    }

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard label="Active users" value={usersTotal} accent="primary" isLoading={loading} hint="People & service accounts" />
                <StatCard
                    label="Departments"
                    value={deptCount}
                    isLoading={loading}
                    hint={deptCount === 1 ? '1 specialty' : `${deptCount ?? 0} specialties`}
                />
                <StatCard
                    label="Running sessions"
                    value={activeSessions}
                    isLoading={loading}
                    accent="success"
                    hint={syncedAt ? `live · synced ${syncedAt}` : 'live consultations'}
                />
                <StatCard
                    label="Services healthy"
                    value={health.total > 0 ? `${health.healthy} / ${health.total}` : undefined}
                    isLoading={loading}
                    accent={healthRole}
                    footer={<StatusDot colorRole={healthRole} label={<span className="text-xs text-muted-foreground">{healthHint}</span>} />}
                />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {/* TARGET: no concurrent-WS telemetry endpoint yet — drawn em-dash, never fabricated. */}
                <StatCard label="Open sockets" value={undefined} isLoading={loading} hint="Concurrent WS · Target" />
                <StatCard label="Processing jobs" value={processingJobs} isLoading={loading} hint="STT · SMR queue" />
                <StatCard
                    label="Consultations today"
                    value={today.total}
                    isLoading={loading}
                    hint={`${today.newVisits} new · ${today.revisits} re-visit`}
                />
                <StatCard
                    label="Pending review"
                    value={pendingReview}
                    isLoading={loading}
                    accent={pendingReview > 0 ? 'warning' : 'default'}
                    hint="Unsigned notes"
                />
                {/* TASK-386 E5 — REAL summaries-24h roll-up (scoped to this tenant). */}
                <StatCard
                    label="Consumption"
                    value={usage ? formatCount(usage.summaries24h) : undefined}
                    isLoading={loading}
                    hint="Summaries · last 24h"
                />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <Card className="p-5 lg:col-span-2">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h2 className="text-sm font-semibold">Consultation sessions</h2>
                            <p className="text-xs text-muted-foreground">
                                per day · {tenant?.name ?? 'tenant'} · {rangeCaption}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {superAdmin && tenantOptions.length > 0 ? (
                                <TenantFilter
                                    tenants={tenantOptions}
                                    value={tenantId}
                                    onChange={(id) => {
                                        if (id) navigate({ to: '/tenants/$tenantId/overview', params: { tenantId: id } });
                                    }}
                                    aria-label="Switch tenant dashboard"
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
                            height={260}
                            showLegend
                            isLoading={loading}
                            aria-label="Consultation sessions per day, new visits and re-visits"
                        />
                    </div>
                    <p className="mt-2 text-xs tabular-nums text-muted-foreground">
                        {chartTotal} session{chartTotal === 1 ? '' : 's'} · {rangeCaption}
                    </p>
                </Card>

                <Card className="flex flex-col p-5">
                    <div className="flex items-start justify-between gap-2">
                        <div>
                            <h2 className="text-sm font-semibold">Recent activity</h2>
                            <p className="text-xs text-muted-foreground">from audit log</p>
                        </div>
                        <Link
                            to="/audit-log"
                            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                        >
                            View all <ArrowRight className="size-3.5" />
                        </Link>
                    </div>
                    <div className="mt-3 flex-1">
                        <ItemList<ActivityItem>
                            aria-label="Recent tenant activity"
                            items={activityItems}
                            getItemId={(a) => a.id}
                            isLoading={loading}
                            renderRow={(a) => (
                                <span className="flex min-w-0 flex-1 items-start gap-2.5">
                                    <StatusDot colorRole={a.dotRole} className="mt-1.5 shrink-0" />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate text-sm font-medium">{a.title}</span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {a.actor} · {formatRelativeTime(a.timestamp)}
                                        </span>
                                    </span>
                                    {a.code ? (
                                        <span className="shrink-0 self-start font-mono text-[10px] text-muted-foreground">
                                            {a.code.toLowerCase()}
                                        </span>
                                    ) : null}
                                </span>
                            )}
                        />
                    </div>
                </Card>
            </div>

            <Card className="p-4">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div className="mr-2 min-w-0">
                        <h2 className="text-sm font-semibold">Audio pipeline</h2>
                        <p className="text-xs tabular-nums text-muted-foreground">
                            {activeSessions != null ? `${activeSessions} active streams` : 'Streams unavailable'}
                        </p>
                    </div>
                    {pipeline.map((row) => (
                        <ServiceStatusItem key={row.serviceKey} name={row.name} status={row.status} version={row.version} density="compact" />
                    ))}
                    <span className="ml-auto text-xs text-muted-foreground">Per-model streams · Target</span>
                </div>
            </Card>

            {banner}
        </div>
    );
}
