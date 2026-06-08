import { Main } from '@/components/layout/main';
import { AdminApiError } from '../api/admin-client';
import { useServiceSessions, useServiceUptime, useServicesHealth, type DownstreamServiceProbe, type ServiceHealthStatus } from './api/monitoring';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Separator } from '@arcaai/ui/separator';
import { Skeleton } from '@arcaai/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { cn } from '@/lib/utils';
import { Activity, AlertCircle, Clock, Inbox, RefreshCw, Server, Users } from 'lucide-react';

// Auto-refresh cadence — generous so the read-only ops view stays current
// without hammering the gateway (monitoring is rate-limited to 300/min).
const REFRESH_MS = 15_000;

const HEALTH_STYLES: Record<string, string> = {
  healthy: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  degraded: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  down: 'bg-red-500/15 text-red-700 dark:text-red-400',
  unhealthy: 'bg-red-500/15 text-red-700 dark:text-red-400',
  unknown: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
};

function HealthBadge({ status }: { status: string }) {
  const key = status.toLowerCase();
  return (
    <Badge variant="outline" className={cn('text-xs capitalize', HEALTH_STYLES[key] ?? HEALTH_STYLES.unknown)}>
      {status}
    </Badge>
  );
}

function formatTime(iso?: string) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString();
}

function errorMessage(error: unknown): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong while loading data.';
}

function ErrorState({ error }: { error: unknown }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <AlertCircle className="text-destructive size-6" />
      <p className="text-muted-foreground text-sm">{errorMessage(error)}</p>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <Inbox className="text-muted-foreground size-6" />
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}

function uptimeTone(status: ServiceHealthStatus): string {
  if (status === 'healthy') return 'text-emerald-600 dark:text-emerald-400';
  if (status === 'degraded') return 'text-amber-600 dark:text-amber-400';
  if (status === 'down') return 'text-red-600 dark:text-red-400';
  return 'text-muted-foreground';
}

export default function SystemHealthPage() {
  const uptime = useServiceUptime({ refetchInterval: REFRESH_MS });
  const sessions = useServiceSessions({ refetchInterval: REFRESH_MS });
  const services = useServicesHealth({ refetchInterval: REFRESH_MS });

  const isFetching = uptime.isFetching || sessions.isFetching || services.isFetching;
  const refreshedAt = uptime.data?.refreshedAt ?? sessions.data?.refreshedAt;

  const refreshAll = () => {
    void uptime.refetch();
    void sessions.refetch();
    void services.refetch();
  };

  const uptimeServices = Object.entries(uptime.data?.services ?? {});
  const sessionServices = Object.entries(sessions.data?.services ?? {});
  const downstream = Object.entries(services.data?.services ?? {});

  return (
    <Main>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">System Health</h2>
          <p className="text-muted-foreground mt-1">Live service uptime, active sessions, and downstream microservice health.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Clock className="size-3" />
            Updated {formatTime(refreshedAt)}
          </span>
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={isFetching}>
            <RefreshCw className={cn('mr-1.5 size-3.5', isFetching && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Overall + downstream services */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="text-muted-foreground size-4" />
                <CardTitle className="text-sm font-medium">Downstream Services</CardTitle>
              </div>
              {services.data && <HealthBadge status={services.data.status} />}
            </div>
            <CardDescription>Consolidated probe of SMR, NLP, STT, Guardrail, and Harness (GET /health/services).</CardDescription>
          </CardHeader>
          <CardContent>
            {services.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-3/4" />
              </div>
            ) : services.isError ? (
              <ErrorState error={services.error} />
            ) : downstream.length === 0 ? (
              <EmptyState message="No downstream services reporting." />
            ) : (
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Service</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Uptime</TableHead>
                      <TableHead className="text-right">Latency</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {downstream.map(([key, probe]: [string, DownstreamServiceProbe]) => (
                      <TableRow key={key}>
                        <TableCell className="font-medium">{probe.service || key}</TableCell>
                        <TableCell>
                          <HealthBadge status={probe.status} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {probe.uptime_seconds != null ? `${Math.round(probe.uptime_seconds)}s` : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{probe.duration_ms != null ? `${probe.duration_ms}ms` : '—'}</TableCell>
                        <TableCell className="text-muted-foreground max-w-[16rem] truncate text-xs">{probe.error ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Service uptime */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Activity className="text-muted-foreground size-4" />
              <CardTitle className="text-sm font-medium">Service Uptime</CardTitle>
            </div>
            <CardDescription>Heartbeat-derived uptime per service (GET /monitoring/uptime).</CardDescription>
          </CardHeader>
          <CardContent>
            {uptime.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : uptime.isError ? (
              <ErrorState error={uptime.error} />
            ) : uptimeServices.length === 0 ? (
              <EmptyState message="No uptime data available." />
            ) : (
              <div className="flex flex-col gap-3">
                {uptimeServices.map(([key, svc]) => (
                  <div key={key} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium uppercase">{key}</p>
                      <p className="text-muted-foreground text-xs">
                        {svc.responseTime}ms · checked {formatTime(svc.lastCheck)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cn('text-sm font-semibold tabular-nums', uptimeTone(svc.status))}>{svc.uptime.toFixed(1)}%</span>
                      <HealthBadge status={svc.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Active sessions */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Users className="text-muted-foreground size-4" />
              <CardTitle className="text-sm font-medium">Active Sessions</CardTitle>
            </div>
            <CardDescription>Live session counts per service (GET /monitoring/sessions).</CardDescription>
          </CardHeader>
          <CardContent>
            {sessions.isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-6 w-24" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : sessions.isError ? (
              <ErrorState error={sessions.error} />
            ) : (
              <div className="space-y-4">
                <div>
                  <p className="text-muted-foreground text-xs">Total users with sessions</p>
                  <p className="text-2xl font-bold tabular-nums">{sessions.data?.totalUsers ?? 0}</p>
                </div>
                <Separator />
                {sessionServices.length === 0 ? (
                  <EmptyState message="No active sessions." />
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {sessionServices.map(([key, count]) => (
                      <div key={key} className="rounded-lg border p-3">
                        <p className="text-muted-foreground text-xs uppercase">{key}</p>
                        <p className="text-xl font-semibold tabular-nums">{count.active}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Main>
  );
}
