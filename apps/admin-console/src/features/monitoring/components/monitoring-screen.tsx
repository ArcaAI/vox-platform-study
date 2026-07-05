'use client';

import type { ReactNode } from 'react';
import { IconActivity, IconChartBar } from '@tabler/icons-react';
import { MetricChart } from '@arcaai/ui/components/metrics/metric-chart';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import type { StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { formatNumber, formatPercent, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorBanner, ErrorState } from '@/shared/state/error-state';
import { useRedisHealth, useServicesHealth, useSessions, useUptime } from '../api';
import type { HeartbeatRecord, ServiceProbe, ServiceUptime } from '../api';

/** Probe/uptime status → semantic role (never color-only: labels ride along). */
function serviceStatusRole(status: string): StatusColorRole {
    if (status === 'healthy') return 'success';
    if (status === 'degraded') return 'warning';
    if (status === 'down' || status === 'unhealthy') return 'destructive';
    return 'neutral';
}

function serviceStatusLabel(status: string): string {
    if (!status) return 'Unknown';
    return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Frame 11 card title — small semantic heading under the page h1. */
function SectionTitle({ children }: { children: ReactNode }) {
    return <h2 className="text-sm leading-none font-semibold">{children}</h2>;
}

const HEARTBEAT_WINDOW = 20;

/** Recent up/down ticks; dots are decorative, the sr-only summary carries meaning. */
function HeartbeatStrip({ heartbeats }: { heartbeats: HeartbeatRecord[] }) {
    const recent = heartbeats.slice(-HEARTBEAT_WINDOW);
    if (recent.length === 0) return null;
    const up = recent.filter((beat) => beat.status === 'up').length;
    return (
        <span className="inline-flex items-center gap-1">
            <span aria-hidden className="inline-flex items-center gap-0.5">
                {recent.map((beat, index) => (
                    <span key={index} className={`size-1.5 rounded-full ${beat.status === 'up' ? 'bg-success' : 'bg-destructive'}`} />
                ))}
            </span>
            <span className="sr-only">
                {up} of {recent.length} recent checks up
            </span>
        </span>
    );
}

function StatStrip({
    health,
    uptime,
    sessions,
    redis,
}: {
    health: ReturnType<typeof useServicesHealth>;
    uptime: ReturnType<typeof useUptime>;
    sessions: ReturnType<typeof useSessions>;
    redis: ReturnType<typeof useRedisHealth>;
}) {
    const probes = Object.values(health.data?.services ?? {});
    const healthyCount = probes.filter((probe) => probe.status === 'healthy').length;

    const uptimeEntries = Object.entries(uptime.data?.services ?? {});
    const lowest = uptimeEntries.reduce<[string, ServiceUptime] | null>(
        (worst, entry) => (worst === null || entry[1].uptime < worst[1].uptime ? entry : worst),
        null,
    );

    const activeSessions = sessions.data ? Object.values(sessions.data.services).reduce((sum, service) => sum + service.active, 0) : null;

    return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
                label="Services healthy"
                value={health.data ? `${healthyCount}/${probes.length}` : null}
                isLoading={health.isPending}
                error={health.isError && !health.data ? health.error : undefined}
            />
            <StatCard
                label="Lowest uptime"
                value={lowest ? formatPercent(lowest[1].uptime) : null}
                hint={lowest ? lowest[0] : undefined}
                isLoading={uptime.isPending}
                error={uptime.isError && !uptime.data ? uptime.error : undefined}
            />
            <StatCard
                label="Active sessions"
                value={activeSessions === null ? null : formatNumber(activeSessions)}
                hint={sessions.data ? `${formatNumber(sessions.data.totalUsers)} users` : undefined}
                isLoading={sessions.isPending}
                error={sessions.isError && !sessions.data ? sessions.error : undefined}
            />
            <StatCard
                label="Redis latency"
                value={redis.data ? `${formatNumber(redis.data.latencyMs)} ms` : null}
                hint={redis.data ? `${formatNumber(redis.data.connectedClients)} clients` : undefined}
                isLoading={redis.isPending}
                error={redis.isError && !redis.data ? redis.error : undefined}
            />
        </div>
    );
}

function ServiceHealthGrid({ health, uptime }: { health: ReturnType<typeof useServicesHealth>; uptime: ReturnType<typeof useUptime> }) {
    let body: ReactNode;
    if (health.isPending) {
        body = (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 5 }, (_, index) => (
                    <div key={index} className="flex flex-col gap-2 rounded-lg border p-4">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-36" />
                        <Skeleton className="h-3 w-24" />
                    </div>
                ))}
            </div>
        );
    } else if (health.isError && !health.data) {
        body = <ErrorState title={'Couldn\u2019t load service health'} error={health.error} onRetry={() => void health.refetch()} />;
    } else {
        const probes = health.data?.services ?? {};
        const uptimes = uptime.data?.services ?? {};
        const keys = [...new Set([...Object.keys(probes), ...Object.keys(uptimes)])];
        if (keys.length === 0) {
            body = <EmptyState icon={IconActivity} title="No services reporting" description="Probes will appear once downstream services register." />;
        } else {
            body = (
                <div className="flex flex-col gap-2">
                    {health.isError ? <ErrorBanner error={health.error} onRetry={() => void health.refetch()} /> : null}
                    <ul aria-label="Service health" className="grid list-none gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {keys.map((key) => {
                            const probe: ServiceProbe | undefined = probes[key];
                            const serviceUptime: ServiceUptime | undefined = uptimes[key];
                            const status = probe?.status ?? serviceUptime?.status ?? 'unknown';
                            const responseMs = serviceUptime?.responseTime ?? probe?.duration_ms;
                            return (
                                <li key={key} className="flex flex-col gap-1.5 rounded-lg border p-4 text-sm">
                                    <span className="flex items-center gap-2">
                                        <StatusDot colorRole={serviceStatusRole(status)} label={<span className="font-medium">{key}</span>} />
                                        <span className="text-muted-foreground text-xs">{serviceStatusLabel(status)}</span>
                                    </span>
                                    {probe?.error ? <span className="text-destructive text-xs">{probe.error}</span> : null}
                                    <span className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums">
                                        {responseMs !== undefined ? <span>{formatNumber(Math.round(responseMs))} ms</span> : null}
                                        {serviceUptime ? <span>{formatPercent(serviceUptime.uptime)}</span> : null}
                                        {serviceUptime ? <span>checked {formatRelativeTime(serviceUptime.lastCheck)}</span> : null}
                                    </span>
                                    {serviceUptime ? <HeartbeatStrip heartbeats={serviceUptime.heartbeats} /> : null}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            );
        }
    }

    return (
        <Card className="gap-4">
            <CardHeader>
                <SectionTitle>Service health</SectionTitle>
            </CardHeader>
            <CardContent>{body}</CardContent>
        </Card>
    );
}

function ResponseTimeCard({ uptime }: { uptime: ReturnType<typeof useUptime> }) {
    const isLoading = uptime.isPending || (uptime.isError && uptime.isFetching);
    const chartData = Object.entries(uptime.data?.services ?? {}).map(([key, service]) => ({
        service: key,
        ms: Math.round(service.responseTime),
    }));
    return (
        <Card className="gap-4">
            <CardHeader>
                <SectionTitle>Response time by service</SectionTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
                {uptime.isError && uptime.data ? <ErrorBanner error={uptime.error} onRetry={() => void uptime.refetch()} /> : null}
                <MetricChart
                    kind="bar"
                    data={chartData}
                    xKey="service"
                    series={[{ key: 'ms', label: 'Response time (ms)' }]}
                    height={240}
                    isLoading={isLoading}
                    error={uptime.isError && !uptime.data ? uptime.error : undefined}
                    onRetry={() => void uptime.refetch()}
                    valueFormatter={(value) => `${formatNumber(value)} ms`}
                    aria-label="Latest response time by service"
                    emptyState={
                        <EmptyState
                            icon={IconChartBar}
                            title="No samples in window"
                            description="Uptime probes fill this chart in as heartbeats arrive."
                        />
                    }
                />
            </CardContent>
        </Card>
    );
}

function RedisHealthCard({ redis }: { redis: ReturnType<typeof useRedisHealth> }) {
    let body: ReactNode;
    if (redis.isPending) {
        body = (
            <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-4 w-full" />
                ))}
            </div>
        );
    } else if (redis.isError && !redis.data) {
        body = <ErrorState title={'Couldn\u2019t load Redis health'} error={redis.error} onRetry={() => void redis.refetch()} />;
    } else if (redis.data) {
        const data = redis.data;
        body = (
            <div className="flex flex-col gap-2">
                {redis.isError ? <ErrorBanner error={redis.error} onRetry={() => void redis.refetch()} /> : null}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Status</dt>
                        <dd>
                            <StatusDot colorRole={serviceStatusRole(data.status)} label={serviceStatusLabel(data.status)} />
                        </dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Latency</dt>
                        <dd className="tabular-nums">{formatNumber(data.latencyMs)} ms</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Clients</dt>
                        <dd className="tabular-nums">{formatNumber(data.connectedClients)}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Memory</dt>
                        <dd className="tabular-nums">{data.usedMemory}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Version</dt>
                        <dd className="font-mono text-xs">{data.version}</dd>
                    </div>
                    <div className="flex flex-col gap-0.5">
                        <dt className="text-muted-foreground text-xs">Queues</dt>
                        <dd className="tabular-nums">{formatNumber(data.queuesRegistered)}</dd>
                    </div>
                </dl>
            </div>
        );
    }

    return (
        <Card role="region" aria-label="Redis health" className="gap-4">
            <CardHeader>
                <SectionTitle>Redis health</SectionTitle>
            </CardHeader>
            <CardContent>{body}</CardContent>
        </Card>
    );
}

function ActiveSessionsCard({ sessions }: { sessions: ReturnType<typeof useSessions> }) {
    let body: ReactNode;
    if (sessions.isPending) {
        body = (
            <div className="flex flex-col gap-3">
                {Array.from({ length: 5 }, (_, index) => (
                    <Skeleton key={index} className="h-4 w-full" />
                ))}
            </div>
        );
    } else if (sessions.isError && !sessions.data) {
        body = <ErrorState title={'Couldn\u2019t load sessions'} error={sessions.error} onRetry={() => void sessions.refetch()} />;
    } else if (sessions.data) {
        const entries = Object.entries(sessions.data.services);
        body = (
            <div className="flex flex-col gap-2">
                {sessions.isError ? <ErrorBanner error={sessions.error} onRetry={() => void sessions.refetch()} /> : null}
                <ul aria-label="Active sessions by service" className="flex list-none flex-col">
                    {entries.map(([key, service]) => (
                        <li key={key} className="flex items-center justify-between border-b py-1.5 text-sm last:border-0">
                            <span>{key}</span>
                            <span className="tabular-nums">{formatNumber(service.active)}</span>
                        </li>
                    ))}
                </ul>
                <p className="text-muted-foreground text-xs">{formatNumber(sessions.data.totalUsers)} unique users</p>
            </div>
        );
    }

    return (
        <Card role="region" aria-label="Active sessions" className="gap-4">
            <CardHeader>
                <SectionTitle>Active sessions</SectionTitle>
            </CardHeader>
            <CardContent>{body}</CardContent>
        </Card>
    );
}

/**
 * Frame 11 — Monitoring (tier 10). Service probes + uptime/heartbeats, latest
 * response times, Redis health and live session counts, all on the hooks'
 * 30s poll. Every region owns its loading / empty / error states; a failed
 * refetch keeps stale data behind an inline banner.
 */
export function MonitoringScreen() {
    const health = useServicesHealth();
    const uptime = useUptime();
    const sessions = useSessions();
    const redis = useRedisHealth();

    return (
        <div className="flex flex-1 flex-col gap-4">
            <PageHeader
                title="Monitoring"
                actions={
                    <span className="text-muted-foreground text-sm">
                        Auto-refresh 30s
                        {uptime.data ? ` · updated ${formatRelativeTime(uptime.data.refreshedAt)}` : ''}
                    </span>
                }
            />
            <section aria-label="Key metrics">
                <StatStrip health={health} uptime={uptime} sessions={sessions} redis={redis} />
            </section>
            <ServiceHealthGrid health={health} uptime={uptime} />
            <div className="grid items-start gap-4 lg:grid-cols-2">
                <ResponseTimeCard uptime={uptime} />
                <div className="flex flex-col gap-4">
                    <RedisHealthCard redis={redis} />
                    <ActiveSessionsCard sessions={sessions} />
                </div>
            </div>
        </div>
    );
}

/** Route-level skeleton (loading.tsx) mirroring the loaded layout (rule 10). */
export function MonitoringScreenSkeleton() {
    return (
        <div className="flex flex-1 flex-col gap-4">
            <div className="flex items-start justify-between gap-4">
                <Skeleton className="h-8 w-40" />
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
            <Card className="gap-4 px-6 py-6">
                <Skeleton className="h-4 w-32" />
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {Array.from({ length: 5 }, (_, index) => (
                        <div key={index} className="flex flex-col gap-2 rounded-lg border p-4">
                            <Skeleton className="h-4 w-28" />
                            <Skeleton className="h-3 w-36" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                    ))}
                </div>
            </Card>
            <div className="grid items-start gap-4 lg:grid-cols-2">
                <Card className="gap-4 px-6 py-6">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-[240px] w-full" />
                </Card>
                <div className="flex flex-col gap-4">
                    <Card className="gap-4 px-6 py-6">
                        <Skeleton className="h-4 w-28" />
                        <div className="grid grid-cols-2 gap-3">
                            {Array.from({ length: 6 }, (_, index) => (
                                <Skeleton key={index} className="h-4 w-full" />
                            ))}
                        </div>
                    </Card>
                    <Card className="gap-4 px-6 py-6">
                        <Skeleton className="h-4 w-32" />
                        <div className="flex flex-col gap-3">
                            {Array.from({ length: 5 }, (_, index) => (
                                <Skeleton key={index} className="h-4 w-full" />
                            ))}
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}
