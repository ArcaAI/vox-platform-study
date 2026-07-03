import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import {
  MetricChart,
  MetricTable,
  ServiceStatusBar,
  StatCard,
  StatusDot,
  type MetricColumn,
  type ServiceStatusItemProps,
} from '@arcaai/ui/components/metrics';
import { useHealthCheck, useMonitoring, usePlatformMetrics } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { Activity, BellRing, Download, RotateCcw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/layout/page-header';
import {
  buildRequestVolumeRows,
  buildServiceRows,
  formatCount,
  PLATFORM_MODELS,
  REQUEST_VOLUME_SERIES,
  type ServiceHealthState,
} from '@/features/platform-dashboard';
import { requireSuperAdmin } from '@/lib/route-guards';
import { formatUptime } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/system-health')({
  staticData: { crumb: [{ label: 'Platform', to: null }, { label: 'Monitoring' }] },
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: MonitoringPage,
});

const POLL_INTERVAL_MS = 30_000;

/** Human status label for the dot+label Services cell. */
const STATUS_LABEL: Record<ServiceHealthState, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unhealthy: 'Unhealthy',
  checking: 'Checking',
  unknown: 'Unknown',
};

const EM_DASH = '\u2014';

const SERVICE_COLUMNS: MetricColumn[] = [
  { key: 'service', label: 'Service' },
  { key: 'status', label: 'Status' },
  { key: 'p95', label: 'P95', format: 'numeric' },
  { key: 'uptime', label: 'Uptime', format: 'numeric' },
];

const MODEL_COLUMNS: MetricColumn[] = [
  { key: 'model', label: 'Model' },
  { key: 'service', label: 'Service' },
  { key: 'running', label: 'Running', format: 'numeric' },
  { key: 'latency', label: 'Avg latency', format: 'numeric' },
];

/** TARGET cell — a muted em-dash (no backing telemetry; never fabricated). */
function TargetCell() {
  return <span className="text-muted-foreground">{EM_DASH}</span>;
}

/** Numeric cell — REAL value when present, else the TARGET em-dash (null = not reporting). */
function NumericCell({ value, suffix }: { value: number | null | undefined; suffix?: string }) {
  if (value == null || !Number.isFinite(value)) return <TargetCell />;
  return (
    <span className="tabular-nums">
      {formatCount(Math.round(value))}
      {suffix}
    </span>
  );
}

function MonitoringPage() {
  const { services, isLoading, error, check, startPolling, stopPolling } = useHealthCheck();
  const monitoring = useMonitoring();
  // TASK-386 E1 (#16/#19) — platform runtime metrics: throughput/error/sockets
  // KPIs, per-service P95, per-model running + avg-latency (Prometheus-derived).
  const { metrics, refresh: refreshMetrics } = usePlatformMetrics();

  const refreshAll = useCallback(() => {
    void check().catch(() => undefined);
    void monitoring.refresh().catch(() => undefined);
    // TASK-386 E1 — degrades independently (Prometheus down ⇒ zeros/[]/null tiles).
    void refreshMetrics().catch(() => undefined);
  }, [check, monitoring, refreshMetrics]);

  useEffect(() => {
    refreshAll();
    startPolling(POLL_INTERVAL_MS);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const serviceRows = useMemo(() => buildServiceRows(services, monitoring.uptime), [services, monitoring.uptime]);
  const serviceCount = useMemo(() => Object.keys(services).length, [services]);
  const showSkeleton = isLoading && serviceCount === 0;

  // TASK-386 E1 — per-service P95 (ms) keyed by service key, for the Services table.
  const p95ByService = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const svc of metrics?.services ?? []) map.set(svc.key, svc.p95LatencyMs);
    return map;
  }, [metrics]);

  // TASK-386 E1/#19 — per-model running + avg-latency keyed by model id, for the Models table.
  const modelMetricById = useMemo(() => {
    const map = new Map<string, { running: number | null; avgLatencyMs: number | null }>();
    for (const m of metrics?.models.perModel ?? []) map.set(m.id, { running: m.running, avgLatencyMs: m.avgLatencyMs });
    return map;
  }, [metrics]);

  // TASK-404 (P2-1) — REAL request/socket series (TASK-386 E1, 30-min window, 1-min buckets).
  const requestVolumeRows = useMemo(() => buildRequestVolumeRows(metrics?.requestVolumeSeries), [metrics]);

  // TASK-404 (TASK-377 follow-up) — canonical footer status strip, fed by the same rows.
  const statusBarServices = useMemo<ServiceStatusItemProps[]>(
    () =>
      serviceRows.map((row) => {
        const p95 = p95ByService.get(row.key);
        return {
          name: row.name,
          status: row.status,
          ...(p95 != null && Number.isFinite(p95) ? { p95Ms: Math.round(p95) } : {}),
          ...(row.uptimeSeconds != null ? { uptimeSeconds: row.uptimeSeconds } : {}),
          ...(row.version ? { version: row.version } : {}),
        };
      }),
    [serviceRows, p95ByService],
  );

  // Services table: status + uptime (REAL); P95 REAL from E1 when reporting, else TARGET.
  const serviceTableRows = useMemo<Record<string, ReactNode>[]>(
    () =>
      serviceCount === 0
        ? []
        : serviceRows.map((row) => ({
            service: <span className="font-medium">{row.name}</span>,
            status: <StatusDot colorRole={row.role} label={<span className="text-sm">{STATUS_LABEL[row.status]}</span>} />,
            p95: <NumericCell value={p95ByService.get(row.key) ?? null} suffix=" ms" />,
            uptime: row.uptimeSeconds != null ? <span className="tabular-nums">{formatUptime(row.uptimeSeconds)}</span> : <TargetCell />,
          })),
    [serviceRows, serviceCount, p95ByService],
  );

  // Models table: model + host service (REAL identity); running + latency REAL from E1 (#19) when reporting.
  const modelTableRows = useMemo<Record<string, ReactNode>[]>(
    () =>
      PLATFORM_MODELS.map((model) => {
        const mm = modelMetricById.get(model.id);
        return {
          model: <span className="font-mono text-xs">{model.name}</span>,
          service: <span className="text-muted-foreground">{model.service}</span>,
          running: <NumericCell value={mm?.running ?? null} />,
          latency: <NumericCell value={mm?.avgLatencyMs ?? null} suffix=" ms" />,
        };
      }),
    [modelMetricById],
  );

  const headerActions = (
    <>
      <Button variant="outline" onClick={() => toast.info('Monitoring export is not available yet')}>
        <Download className="size-4" />
        Export
      </Button>
      <Button onClick={() => toast.info('Alert configuration is not available yet')}>
        <BellRing className="size-4" />
        Configure alerts
      </Button>
    </>
  );

  if (error && serviceCount === 0 && !isLoading) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Service Monitoring"
          description="Real-time health, latency, and throughput across all microservices."
          actions={headerActions}
        />
        <Card className="p-10">
          <div role="alert" className="flex flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <TriangleAlert className="size-6 text-destructive" />
            </span>
            <div className="space-y-1">
              <p className="text-lg font-semibold">Couldn’t reach the health endpoints</p>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                We couldn’t load service health right now. This is usually a transient connection issue — retrying often resolves it.
              </p>
            </div>
            <Button onClick={refreshAll}>
              <RotateCcw className="size-4" />
              Retry
            </Button>
            <p className="font-mono text-xs text-muted-foreground">{error.message}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Service Monitoring"
        description="Real-time health, latency, and throughput across all microservices."
        actions={headerActions}
      />

      {/* TASK-386 E1 — REAL throughput/error/socket KPIs (Prometheus + Redis socket aggregate). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Requests / min"
          value={metrics ? formatCount(Math.round(metrics.requestsPerMinute)) : undefined}
          isLoading={showSkeleton}
          hint="API throughput · last 1m"
        />
        <StatCard
          label="Error rate"
          value={metrics ? `${metrics.errorRatePct.toFixed(1)}%` : undefined}
          isLoading={showSkeleton}
          hint="5xx share · last 5m"
        />
        <StatCard
          label="Sockets / min"
          value={metrics ? formatCount(Math.round(metrics.socketsPerMinute)) : undefined}
          isLoading={showSkeleton}
          hint="WS open rate · last 1m"
        />
        <StatCard
          label="Total sockets"
          value={metrics ? formatCount(metrics.openSockets) : undefined}
          isLoading={showSkeleton}
          hint="STT live (multi-instance)"
        />
      </div>

      {/* Request-volume chart — REAL series (TASK-386 E1; fixed 30-min Prometheus window). */}
      <Card className="p-5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Request volume</h2>
          <p className="text-xs text-muted-foreground">All services · requests &amp; open sockets per minute · live, last 30 min</p>
        </div>
        <div className="mt-4">
          <MetricChart
            kind="area"
            data={requestVolumeRows}
            xKey="label"
            series={[...REQUEST_VOLUME_SERIES]}
            height={260}
            isLoading={showSkeleton}
            aria-label="Requests and open sockets per minute across all services, last 30 minutes"
            emptyState={
              <Empty style={{ minHeight: 240 }}>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Activity />
                  </EmptyMedia>
                  <EmptyTitle>No request-volume samples</EmptyTitle>
                  <EmptyDescription>The metrics endpoint reported an empty series — Prometheus may be unavailable.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            }
          />
        </div>
      </Card>

      {/* Services + Models tables. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">Services</h2>
            <p className="text-xs text-muted-foreground">Health, latency &amp; uptime · all microservices</p>
          </div>
          <MetricTable
            aria-label="Service health"
            columns={SERVICE_COLUMNS}
            rows={serviceTableRows}
            getRowId={(_, index) => serviceRows[index]?.key ?? String(index)}
            isLoading={showSkeleton}
            skeletonRows={6}
            emptyState="No service health reported."
          />
        </Card>

        <Card className="p-5">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">Models &amp; running tasks</h2>
            <p className="text-xs text-muted-foreground">Live inference across services</p>
          </div>
          <MetricTable
            aria-label="Models and running tasks"
            columns={MODEL_COLUMNS}
            rows={showSkeleton ? [] : modelTableRows}
            getRowId={(_, index) => PLATFORM_MODELS[index]?.id ?? String(index)}
            isLoading={showSkeleton}
            skeletonRows={6}
          />
        </Card>
      </div>

      {/* TASK-404 (TASK-377 follow-up) — canonical service-status footer strip. */}
      <ServiceStatusBar
        services={statusBarServices}
        activeSessions={monitoring.sessions?.activeSessions}
        processingJobs={monitoring.sessions?.processingJobs}
        onRefresh={refreshAll}
        isLoading={showSkeleton}
        className="rounded-xl border shadow-sm"
      />
    </div>
  );
}
