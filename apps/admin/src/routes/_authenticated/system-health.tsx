import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared';
import { useHealthCheck, useMonitoring, type UseHealthCheckReturn } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { Activity, AlertTriangle, RefreshCw, Server } from 'lucide-react';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { formatDateTime, formatUptime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/system-health')({
    component: SystemHealthPage,
});

type ServiceHealth = UseHealthCheckReturn['services'][string];

const POLL_INTERVAL_MS = 30_000;

function healthRole(status: string): StatusColorRole {
    switch (status) {
        case 'healthy':
            return 'success';
        case 'degraded':
            return 'warning';
        case 'unhealthy':
            return 'destructive';
        case 'checking':
            return 'info';
        default:
            return 'neutral';
    }
}

function serviceRole(status?: string): StatusColorRole {
    switch ((status ?? '').toLowerCase()) {
        case 'up':
        case 'healthy':
        case 'ok':
            return 'success';
        case 'degraded':
            return 'warning';
        case 'down':
        case 'unhealthy':
            return 'destructive';
        default:
            return 'neutral';
    }
}

function titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-semibold tabular-nums">{value}</div>
                {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
            </CardContent>
        </Card>
    );
}

function SystemHealthPage() {
    const { status, services, lastChecked, isLoading, error, check, startPolling, stopPolling } = useHealthCheck();
    const monitoring = useMonitoring();

    const refreshAll = useCallback(() => {
        void check().catch(() => undefined);
        void monitoring.refresh().catch(() => undefined);
    }, [check, monitoring]);

    useEffect(() => {
        refreshAll();
        startPolling(POLL_INTERVAL_MS);
        return () => stopPolling();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const uptimeByService = useMemo(() => {
        const map = new Map<string, number>();
        for (const u of monitoring.uptime ?? []) {
            if (u?.service) map.set(u.service.toLowerCase(), u.uptimeSeconds);
        }
        return map;
    }, [monitoring.uptime]);

    const serviceEntries = useMemo(() => Object.entries(services) as [string, ServiceHealth][], [services]);
    const upCount = serviceEntries.filter(([, svc]) => serviceRole(svc.status) === 'success').length;

    const sessions = monitoring.sessions;
    const showSkeleton = isLoading && serviceEntries.length === 0;

    return (
        <div>
            <PageHeader
                title="System Health"
                description="Live status across the API gateway and downstream services. Auto-refreshes every 30 seconds."
                actions={
                    <Button variant="outline" onClick={refreshAll} disabled={isLoading}>
                        <RefreshCw className="size-4" />
                        Refresh
                    </Button>
                }
            />

            <Card className="mb-4">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
                    <div className="flex items-center gap-3">
                        <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                            <Activity className="size-5" />
                        </span>
                        <div>
                            <p className="text-sm text-muted-foreground">Overall status</p>
                            <div className="mt-0.5">
                                <StatusBadge label={titleCase(status)} colorRole={healthRole(status)} />
                            </div>
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Last checked: {lastChecked ? formatDateTime(lastChecked.toISOString()) : '—'}
                    </p>
                </CardContent>
            </Card>

            {error ? (
                <Alert variant="destructive" className="mb-4">
                    <AlertTriangle className="size-4" />
                    <AlertTitle>Health check failed</AlertTitle>
                    <AlertDescription>{error.message}</AlertDescription>
                </Alert>
            ) : null}

            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Services up" value={`${upCount}/${serviceEntries.length || 0}`} hint="Reporting healthy" />
                <StatCard label="Active sessions" value={sessions?.activeSessions ?? '—'} hint="Live consultations" />
                <StatCard label="Processing jobs" value={sessions?.processingJobs ?? '—'} hint="In the pipeline" />
                <StatCard label="Total sessions" value={sessions?.total ?? '—'} hint="All-time" />
            </div>

            <h3 className="mb-2 text-sm font-semibold">Services</h3>
            {showSkeleton ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton key={i} className="h-28 w-full rounded-xl" />
                    ))}
                </div>
            ) : serviceEntries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No services reported.</p>
            ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {serviceEntries.map(([key, svc]) => {
                        const uptimeSeconds = uptimeByService.get(key.toLowerCase()) ?? svc.uptime_seconds;
                        return (
                            <Card key={key}>
                                <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
                                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                                        <Server className="size-4 text-muted-foreground" />
                                        {svc.service ?? key}
                                    </CardTitle>
                                    <StatusBadge label={titleCase(svc.status ?? 'unknown')} colorRole={serviceRole(svc.status)} />
                                </CardHeader>
                                <CardContent className="text-xs text-muted-foreground">
                                    <div className="flex justify-between py-0.5">
                                        <span>Version</span>
                                        <span className="font-mono text-foreground">{svc.version ?? '—'}</span>
                                    </div>
                                    <div className="flex justify-between py-0.5">
                                        <span>Uptime</span>
                                        <span className="tabular-nums text-foreground">{formatUptime(uptimeSeconds)}</span>
                                    </div>
                                    {svc.error ? <p className="mt-1 text-destructive">{svc.error}</p> : null}
                                </CardContent>
                            </Card>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
