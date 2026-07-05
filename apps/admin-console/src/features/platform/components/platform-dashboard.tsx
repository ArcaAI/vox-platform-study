'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconArrowRight, IconChartBar, IconHistory } from '@tabler/icons-react';
import { MetricChart } from '@arcaai/ui/components/metrics/metric-chart';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import type { StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useAuditLogs } from '@/features/audit-logs/api';
import type { AuditLog } from '@/features/audit-logs/api';
import { useServicesHealth } from '@/features/monitoring/api';
import { formatNumber, formatPercent, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { usePlatformMetrics } from '../api';
import type { PlatformMetrics } from '../api';

/** Probe status → semantic role (never color-only: the label rides along). */
function serviceStatusRole(status: string): StatusColorRole {
    if (status === 'healthy') return 'success';
    if (status === 'degraded') return 'warning';
    if (status === 'down' || status === 'unhealthy') return 'destructive';
    return 'neutral';
}

function serviceStatusDetail(status: string, error?: string): string {
    return `(${status}${error ? ` · ${error}` : ''})`;
}

/** Frame 10 card title — small semantic heading under the page h1. */
function SectionTitle({ children }: { children: ReactNode }) {
    return <h2 className="text-sm leading-none font-semibold">{children}</h2>;
}

function StatStrip({ metrics }: { metrics: ReturnType<typeof usePlatformMetrics> }) {
    if (metrics.isError && !metrics.data) {
        return <ErrorState title={'Couldn\u2019t load platform metrics'} error={metrics.error} onRetry={() => void metrics.refetch()} />;
    }
    const isLoading = metrics.isPending || (metrics.isError && metrics.isFetching);
    const data: PlatformMetrics | undefined = metrics.data;
    return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Requests / min" value={data ? formatNumber(data.requestsPerMinute) : null} isLoading={isLoading} />
            <StatCard label="P95 latency" value={data ? `${formatNumber(data.p95LatencyMs)} ms` : null} isLoading={isLoading} />
            <StatCard label="Error rate" value={data ? formatPercent(data.errorRatePct) : null} isLoading={isLoading} />
            <StatCard
                label="Open sockets"
                value={data ? formatNumber(data.openSockets) : null}
                hint={data ? `${formatNumber(data.socketsPerMinute)} opened/min` : undefined}
                isLoading={isLoading}
            />
        </div>
    );
}

function ServicesStrip() {
    const health = useServicesHealth();

    if (health.isPending) {
        return (
            <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
                <Skeleton className="h-4 w-16" />
                {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} className="h-4 w-24 rounded-full" />
                ))}
            </Card>
        );
    }
    if (health.isError && !health.data) {
        return <ErrorState title={'Couldn\u2019t load service health'} error={health.error} onRetry={() => void health.refetch()} />;
    }

    const services = Object.entries(health.data?.services ?? {});
    return (
        <div className="flex flex-col gap-2">
            {health.isError ? <ErrorBanner error={health.error} onRetry={() => void health.refetch()} /> : null}
            <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
                <h2 className="text-muted-foreground text-sm font-medium">Services</h2>
                {services.length === 0 ? (
                    <span className="text-muted-foreground text-sm">No services reporting</span>
                ) : (
                    services.map(([key, probe]) => (
                        <span key={key} className="inline-flex items-center gap-2 text-sm">
                            <StatusDot colorRole={serviceStatusRole(probe.status)} label={key} />
                            {probe.status !== 'healthy' ? (
                                <span className={`text-xs ${probe.status === 'degraded' ? 'text-warning-strong' : 'text-destructive'}`}>
                                    {serviceStatusDetail(probe.status, probe.error)}
                                </span>
                            ) : null}
                        </span>
                    ))
                )}
                <span className="text-muted-foreground ml-auto hidden font-mono text-xs lg:inline">GET /health/services · 30s</span>
            </Card>
        </div>
    );
}

function RequestsByServiceCard({ metrics }: { metrics: ReturnType<typeof usePlatformMetrics> }) {
    const isLoading = metrics.isPending || (metrics.isError && metrics.isFetching);
    const chartData = (metrics.data?.services ?? []).map((service) => ({ service: service.key, requests: service.requestsPerMinute ?? 0 }));
    return (
        <Card className="gap-4">
            <CardHeader>
                <SectionTitle>Requests by service</SectionTitle>
            </CardHeader>
            <CardContent>
                <MetricChart
                    kind="bar"
                    data={chartData}
                    xKey="service"
                    series={[{ key: 'requests', label: 'Requests / min' }]}
                    height={240}
                    isLoading={isLoading}
                    error={metrics.isError && !metrics.data ? metrics.error : undefined}
                    onRetry={() => void metrics.refetch()}
                    valueFormatter={(value) => formatNumber(value)}
                    aria-label="Requests per minute by service"
                    emptyState={
                        <EmptyState
                            icon={IconChartBar}
                            title="No traffic yet"
                            description="Charts fill in once services start taking requests."
                        />
                    }
                />
            </CardContent>
        </Card>
    );
}

function auditActor(row: AuditLog): string {
    return row.responsibleUser?.email ?? row.responsibleUser?.displayName ?? row.responsibleUserId ?? '\u2014';
}

function RecentActivityCard() {
    const audit = useAuditLogs({ limit: 10 });
    const rows = audit.data?.data ?? [];

    let body: ReactNode;
    if (audit.isPending) {
        body = (
            <div className="flex flex-col gap-3">
                {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-4 w-full" />
                ))}
            </div>
        );
    } else if (audit.isError && rows.length === 0) {
        body = <ErrorState title={'Couldn\u2019t load admin activity'} error={audit.error} onRetry={() => void audit.refetch()} />;
    } else if (rows.length === 0) {
        body = <EmptyState icon={IconHistory} title="No admin activity yet" description="Administrative actions will appear here as they happen." />;
    } else {
        body = (
            <div className="flex flex-col gap-2">
                {audit.isError ? <ErrorBanner error={audit.error} onRetry={() => void audit.refetch()} /> : null}
                <ul aria-label="Recent admin activity" className="flex flex-col">
                    {rows.map((row) => (
                        <li
                            key={row.id}
                            className="grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 border-b py-2 text-sm last:border-0 sm:grid-cols-[5rem_minmax(0,1.2fr)_minmax(0,1fr)_auto]"
                        >
                            <time dateTime={row.createdAt} className="text-muted-foreground text-xs tabular-nums">
                                {formatRelativeTime(row.createdAt)}
                            </time>
                            <span className="truncate font-mono text-xs">{row.eventType ?? row.action}</span>
                            <span className="text-muted-foreground truncate text-xs" title={row.resourceId ?? undefined}>
                                {row.resourceType}
                                {row.resourceId ? <span className="font-mono"> · {row.resourceId}</span> : null}
                            </span>
                            <span className="text-muted-foreground truncate text-xs">{auditActor(row)}</span>
                        </li>
                    ))}
                </ul>
            </div>
        );
    }

    return (
        <Card className="gap-4">
            <CardHeader>
                <SectionTitle>Recent admin activity</SectionTitle>
                <CardAction>
                    <Link href="/audit-logs" className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
                        Audit Logs
                        <IconArrowRight aria-hidden className="size-3.5" />
                    </Link>
                </CardAction>
            </CardHeader>
            <CardContent>{body}</CardContent>
        </Card>
    );
}

/**
 * Frame 10 — Platform Dashboard (tier 10). Stat tiles + service health strip
 * from the 30s-polling platform/monitoring hooks, per-service request volume,
 * and the last 10 audit events. Every region owns its loading / empty / error
 * states; a failed refetch keeps stale data behind an inline banner.
 */
export function PlatformDashboard() {
    const metrics = usePlatformMetrics();

    return (
        <div className="flex flex-1 flex-col gap-4">
            <PageHeader
                title="Platform Dashboard"
                actions={
                    <span className="text-muted-foreground text-sm">
                        Auto-refresh 30s
                        {metrics.data ? ` · updated ${formatRelativeTime(metrics.data.refreshedAt)}` : ''}
                    </span>
                }
            />
            {metrics.isError && metrics.data ? <ErrorBanner error={metrics.error} onRetry={() => void metrics.refetch()} /> : null}
            <section aria-label="Key metrics">
                <StatStrip metrics={metrics} />
            </section>
            <section aria-label="Services">
                <ServicesStrip />
            </section>
            <div className="grid items-start gap-4 lg:grid-cols-2">
                <RequestsByServiceCard metrics={metrics} />
                <RecentActivityCard />
            </div>
        </div>
    );
}

/** Route-level skeleton (loading.tsx) mirroring the loaded layout (rule 10). */
export function PlatformDashboardSkeleton() {
    return (
        <div className="flex flex-1 flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
                <Skeleton className="h-8 w-56" />
                <Skeleton className="h-4 w-40" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {Array.from({ length: 4 }, (_, index) => (
                    <Card key={index} className="gap-2 px-5 py-4">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-8 w-20" />
                        <Skeleton className="h-3 w-28" />
                    </Card>
                ))}
            </div>
            <Card className="flex-row flex-wrap items-center gap-3 px-4 py-3">
                <Skeleton className="h-4 w-16" />
                {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} className="h-4 w-24 rounded-full" />
                ))}
            </Card>
            <div className="grid items-start gap-4 lg:grid-cols-2">
                <Card className="gap-4 px-6 py-6">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-[240px] w-full" />
                </Card>
                <Card className="gap-4 px-6 py-6">
                    <Skeleton className="h-4 w-40" />
                    <div className="flex flex-col gap-3">
                        {Array.from({ length: 6 }, (_, index) => (
                            <Skeleton key={index} className="h-4 w-full" />
                        ))}
                    </div>
                </Card>
            </div>
        </div>
    );
}
