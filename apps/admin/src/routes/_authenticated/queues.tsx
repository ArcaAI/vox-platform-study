import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/alert';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useQueueAdmin, type JobStatusFilter, type QueueStats } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, Eraser, ListTree, Pause, RefreshCw, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/layout/page-header';
import { JobsPanel } from '@/features/queues/jobs-panel';
import { depthSegments, deriveQueueState, formatBacklogged, formatLatency, formatUptime } from '@/features/queues/queue-format';
import { requireSuperAdmin } from '@/lib/route-guards';

export const Route = createFileRoute('/_authenticated/queues')({
  beforeLoad: ({ context }) => requireSuperAdmin(context),
  component: QueuesPage,
});

const REDIS_STATUS_ROLE = { healthy: 'success', degraded: 'warning', unhealthy: 'destructive' } as const;

/** Non-destructive constraint (TASK-403): these queue actions exist server-side but are disabled in this console. */
const DISABLED_ACTION_TOOLTIP = 'Disabled in this console — destructive/operational queue actions are restricted (TASK-403).';

/** Inline depth visualization: stacked waiting/active/failed bar (design frame `15` v2). */
function DepthBar({ queue }: { queue: QueueStats }) {
  const segs = depthSegments(queue.counts);
  return (
    <div className="w-40 max-lg:w-24">
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Queue depth: ${segs.total} jobs in waiting/active/failed`}
      >
        {segs.total > 0 ? (
          <>
            <div className="bg-info" style={{ width: `${segs.waitingPct}%` }} />
            <div className="bg-success" style={{ width: `${segs.activePct}%` }} />
            <div className="bg-destructive" style={{ width: `${segs.failedPct}%` }} />
          </>
        ) : null}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{formatBacklogged(queue.counts)}</div>
    </div>
  );
}

/**
 * TASK-403 — Queues & Jobs (design §5.4, frame `15` v2): Redis-health strip
 * card over the 15-queue table with per-queue depth visualization, state
 * dot+label (Running/Backlogged/Failing/Paused) and `Retry failed`. Jobs open
 * in a drawer (full-screen sheet on mobile). Pause/Clean render disabled with
 * tooltips per the non-destructive constraint.
 */
function QueuesPage() {
  const { queues, redisHealth, isLoading, error, refresh, refreshRedisHealth, listJobs, getJob, retryJob, bulkRetry } = useQueueAdmin();
  const [panelQueue, setPanelQueue] = useState<string | null>(null);
  const [panelStatus, setPanelStatus] = useState<JobStatusFilter | 'all'>('all');

  const loadAll = () => {
    void refresh().catch(() => undefined);
    void refreshRedisHealth().catch(() => undefined);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  useEffect(loadAll, []);

  const openJobs = (queueName: string, status: JobStatusFilter | 'all') => {
    setPanelStatus(status);
    setPanelQueue(queueName);
  };

  return (
    <TooltipProvider>
      <div>
        <PageHeader
          title="Queues & Jobs"
          description="BullMQ queues and workers — platform infrastructure. Super-admin only."
          actions={
            <Button variant="outline" onClick={loadAll} disabled={isLoading}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          }
        />

        {error ? (
          <Alert variant="destructive" className="mb-4">
            <AlertTriangle className="size-4" />
            <AlertTitle>Couldn’t load queue data</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        ) : null}

        {/* Redis health strip (design: ● healthy · 1.4 ms · 312 clients · 48 MB · v7.2 · 15 queues). */}
        <Card className="mb-4 p-4" data-testid="redis-health-card">
          {redisHealth ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <StatusBadge label={`Redis ${redisHealth.status}`} colorRole={REDIS_STATUS_ROLE[redisHealth.status]} />
              <span className="tabular-nums">{formatLatency(redisHealth.latencyMs)}</span>
              <span className="tabular-nums max-sm:hidden">{redisHealth.connectedClients} clients</span>
              <span className="tabular-nums max-sm:hidden">{redisHealth.usedMemory}</span>
              <span className="font-mono text-xs text-muted-foreground">v{redisHealth.version}</span>
              <span className="tabular-nums text-muted-foreground max-sm:hidden">up {formatUptime(redisHealth.uptime)}</span>
              <span className="tabular-nums text-muted-foreground">{redisHealth.queuesRegistered} queues</span>
            </div>
          ) : (
            <div className="h-5 w-72 animate-pulse rounded bg-muted" />
          )}
        </Card>

        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Queue</TableHead>
                <TableHead className="max-md:hidden">Depth</TableHead>
                <TableHead className="text-right">Waiting</TableHead>
                <TableHead className="text-right">Active</TableHead>
                <TableHead className="text-right max-lg:hidden">Completed</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="text-right max-lg:hidden">Delayed</TableHead>
                <TableHead className="text-right max-lg:hidden">Workers</TableHead>
                <TableHead>State</TableHead>
                <TableHead className="w-40 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && queues.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : queues.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                    No queues registered.
                  </TableCell>
                </TableRow>
              ) : (
                queues.map((queue) => {
                  const state = deriveQueueState(queue);
                  return (
                    <TableRow key={queue.name} data-testid={`queue-row-${queue.name}`}>
                      <TableCell>
                        <button type="button" className="font-mono text-xs font-medium" onClick={() => openJobs(queue.name, 'all')}>
                          {queue.name}
                        </button>
                      </TableCell>
                      <TableCell className="max-md:hidden">
                        <DepthBar queue={queue} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{queue.counts.waiting}</TableCell>
                      <TableCell className="text-right tabular-nums">{queue.counts.active}</TableCell>
                      <TableCell className="text-right tabular-nums max-lg:hidden">{queue.counts.completed}</TableCell>
                      <TableCell className={`text-right tabular-nums ${queue.counts.failed > 0 ? 'font-medium text-destructive' : ''}`}>
                        {queue.counts.failed}
                      </TableCell>
                      <TableCell className="text-right tabular-nums max-lg:hidden">{queue.counts.delayed}</TableCell>
                      <TableCell className="text-right tabular-nums max-lg:hidden">{queue.workerCount}</TableCell>
                      <TableCell>
                        <StatusBadge label={state.label} colorRole={state.colorRole} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => openJobs(queue.name, 'all')}
                            aria-label={`View jobs in ${queue.name}`}
                          >
                            <ListTree className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8"
                            disabled={queue.counts.failed === 0}
                            onClick={() => openJobs(queue.name, 'failed')}
                            aria-label={`Retry failed jobs in ${queue.name}`}
                          >
                            <RotateCcw className="size-4" />
                            <span className="max-xl:hidden">Retry failed</span>
                          </Button>
                          {/* Design shows Pause/Clean — rendered disabled per the non-destructive constraint. */}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Button variant="ghost" size="icon" className="size-8" disabled aria-label={`Pause ${queue.name} (disabled)`}>
                                  <Pause className="size-4" />
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{DISABLED_ACTION_TOOLTIP}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Button variant="ghost" size="icon" className="size-8" disabled aria-label={`Clean ${queue.name} (disabled)`}>
                                  <Eraser className="size-4" />
                                </Button>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>{DISABLED_ACTION_TOOLTIP}</TooltipContent>
                          </Tooltip>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          <span className="tabular-nums">{queues.length}</span> queues · live. Job payloads are PII-redacted; destructive queue operations are
          disabled in this console.
        </p>

        <JobsPanel
          queueName={panelQueue}
          initialStatus={panelStatus}
          open={panelQueue !== null}
          onOpenChange={(o) => !o && setPanelQueue(null)}
          listJobs={listJobs}
          getJob={getJob}
          retryJob={retryJob}
          bulkRetry={bulkRetry}
          onMutated={() => void refresh().catch(() => undefined)}
        />
      </div>
    </TooltipProvider>
  );
}
