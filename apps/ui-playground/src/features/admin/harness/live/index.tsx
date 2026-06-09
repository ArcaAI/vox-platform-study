import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@arcaai/ui';
import { Activity, RadioTower, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { LiveSummaryPanel } from '@/features/clinical-workspace/components/live-summary-panel';
import { AdminApiError } from '../../api/admin-client';
import { ConfirmDialog } from '../../components';
import { EmptyState } from '../components/empty-state';
import { ErrorState } from '../components/error-state';
import { RelativeTime } from '../components/relative-time';
import { shortId } from '../lib/format';
import { useLiveEngineConfig, useLiveSessions, useUpdateLiveEngineConfig, type LiveDocSessionStats } from '../api/live';
import { useAdminLiveSummaryStream } from './use-admin-live-summary-stream';

/** Tight poll so the active-session stats stay fresh (a live console). */
const POLL_MS = 5000;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/**
 * Engine kill-switch card (TASK-341 B3/B6). Reading + toggling the
 * live-documentation engine is platform-scoped (super-admin / global scope) —
 * the endpoint 403s for tenant admins — so the toggle is disabled with a reason
 * for them and never fetches the config. A toggle requires confirmation, then
 * PATCHes the Redis override and toasts.
 */
function EngineControlsCard({ isGlobalScope }: { isGlobalScope: boolean }) {
  const config = useLiveEngineConfig({ enabled: isGlobalScope });
  const update = useUpdateLiveEngineConfig();
  const [pendingTarget, setPendingTarget] = useState<boolean | null>(null);

  const enabled = config.data?.enabled ?? false;
  const source = config.data?.source;

  const confirmToggle = () => {
    if (pendingTarget === null) return;
    const target = pendingTarget;
    update.mutate(
      { enabled: target },
      {
        onSuccess: () => {
          toast.success(target ? 'Live documentation engine enabled' : 'Live documentation engine disabled (kill-switch engaged)');
          setPendingTarget(null);
        },
        onError: (e) => toast.error(errorMessage(e, 'Failed to update the engine kill-switch')),
      },
    );
  };

  return (
    <Card className="mb-6" data-testid="live-engine-controls">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <RadioTower className="size-4" aria-hidden />
          Engine kill-switch
        </CardTitle>
        <CardDescription>
          The live-documentation engine powers real-time SOAP. Disabling it refuses new recordings across all instances (no redeploy); in-flight
          sessions drain.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!isGlobalScope ? (
          <div className="flex items-center gap-3">
            <Switch checked={false} disabled data-testid="live-engine-switch" aria-label="Live documentation engine" />
            <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <ShieldAlert className="size-4 shrink-0" aria-hidden />
              Toggling the engine kill-switch requires platform (super-admin) scope.
            </p>
          </div>
        ) : config.isLoading ? (
          <Skeleton className="h-6 w-48" />
        ) : config.isError ? (
          <ErrorState description={errorMessage(config.error, 'Could not read the engine kill-switch.')} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Switch
              checked={enabled}
              disabled={update.isPending}
              onCheckedChange={(next: boolean) => setPendingTarget(next)}
              data-testid="live-engine-switch"
              aria-label="Live documentation engine"
            />
            <span className="text-sm font-medium">{enabled ? 'Engine enabled' : 'Kill-switch engaged'}</span>
            {source && (
              <Badge variant="outline" className="text-[10px]">
                {source === 'redis-override' ? 'Runtime override' : 'Env default'}
              </Badge>
            )}
            {config.data?.updatedAt && (
              <span className="text-muted-foreground text-xs">
                changed <RelativeTime iso={config.data.updatedAt} />
                {config.data.updatedBy ? ` by ${shortId(config.data.updatedBy)}` : ''}
              </span>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={pendingTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPendingTarget(null);
        }}
        title={pendingTarget === false ? 'Disable live documentation engine?' : 'Enable live documentation engine?'}
        description={
          pendingTarget === false
            ? 'Engaging the kill-switch refuses new live-documentation sessions across all API instances while in-flight sessions drain. No redeploy is required.'
            : 'Re-enable live documentation so new recordings start the real-time SOAP engine.'
        }
        confirmLabel={pendingTarget === false ? 'Disable engine' : 'Enable engine'}
        cancelLabel="Keep current"
        variant={pendingTarget === false ? 'destructive' : 'default'}
        isLoading={update.isPending}
        onConfirm={confirmToggle}
      />
    </Card>
  );
}

/** Live SOAP viewer: reuses the doctor cockpit's `LiveSummaryPanel`, fed by the admin SSE hook. */
function LiveSoapViewer({ consultationId, tenantId, onClose }: { consultationId: string; tenantId?: string; onClose: () => void }) {
  const { event, status, error, lastUpdatedAt } = useAdminLiveSummaryStream({ consultationId, enabled: true, tenantId });

  return (
    <Card className="mt-6" data-testid="live-soap-viewer">
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <div>
          <CardTitle className="text-sm font-medium">Live SOAP</CardTitle>
          <CardDescription>
            Observing consultation <span className="font-mono">{shortId(consultationId)}</span>
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close live SOAP viewer">
          <X className="size-4" />
        </Button>
      </CardHeader>
      <CardContent>
        <div className="h-[60vh]">
          <LiveSummaryPanel event={event} status={status} error={error} lastUpdatedAt={lastUpdatedAt} />
        </div>
      </CardContent>
    </Card>
  );
}

function latencyTone(ms: number, failed: boolean): string {
  if (failed) return 'bg-red-500/15 text-red-700 dark:text-red-400';
  if (ms >= 4000) return 'bg-amber-500/15 text-amber-700 dark:text-amber-400';
  return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
}

export default function HarnessLivePage() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const isGlobalScope = useAuthStore((s) => s.isGlobalScope());

  const sessions = useLiveSessions(tenantId || undefined, { refetchInterval: POLL_MS });
  const items: LiveDocSessionStats[] = sessions.data?.items ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const showSkeleton = sessions.isLoading && items.length === 0;

  return (
    <section aria-label="Harness live sessions">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Live sessions</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Active consultations under live documentation, their real-time engine stats, and the live SOAP they are producing.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void sessions.refetch()} disabled={sessions.isFetching} data-testid="live-refresh">
          <RefreshCw className={cn('mr-2 size-4', sessions.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <EngineControlsCard isGlobalScope={isGlobalScope} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Active sessions ({sessions.isError ? 0 : items.length})</CardTitle>
          <CardDescription>Recording consultations publishing live SOAP. Select one to observe its stream.</CardDescription>
        </CardHeader>
        <CardContent>
          {showSkeleton ? (
            <div className="space-y-2" data-testid="live-sessions-skeleton">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : sessions.isError ? (
            <ErrorState description={errorMessage(sessions.error, 'Could not load the active live sessions.')} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={RadioTower}
              title="No active sessions"
              description="No consultations are currently recording. Active live-documentation sessions will appear here."
            />
          ) : (
            <div className="overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Consultation</TableHead>
                    <TableHead className="text-right">Flushes</TableHead>
                    <TableHead className="text-right">SMR</TableHead>
                    <TableHead className="text-right">NLP</TableHead>
                    <TableHead className="text-right">Entities</TableHead>
                    <TableHead>Health</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => {
                    const isSelected = s.consultationId === selectedId;
                    return (
                      <TableRow
                        key={s.consultationId}
                        data-testid="live-session-row"
                        onClick={() => setSelectedId(s.consultationId)}
                        className={cn('cursor-pointer', isSelected && 'bg-muted')}
                      >
                        <TableCell className="font-mono text-xs" title={s.consultationId}>
                          {shortId(s.consultationId)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{s.flushCount}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className={cn('text-[10px] tabular-nums', latencyTone(s.smrLatencyMs, s.smrFailed))}>
                            {s.smrFailed ? 'failed' : `${s.smrLatencyMs} ms`}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className={cn('text-[10px] tabular-nums', latencyTone(s.nlpLatencyMs, s.nlpFailed))}>
                            {s.nlpFailed ? 'failed' : `${s.nlpLatencyMs} ms`}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{s.entityCount}</TableCell>
                        <TableCell>
                          {s.smrFailed || s.nlpFailed ? (
                            <Badge variant="outline" className="bg-red-500/15 text-red-700 text-[10px] dark:text-red-400">
                              Degraded
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 text-[10px] dark:text-emerald-400">
                              <Activity className="mr-1 size-3" />
                              Healthy
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-sm">
                          <RelativeTime iso={s.lastUpdatedAt} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedId && <LiveSoapViewer consultationId={selectedId} tenantId={tenantId || undefined} onClose={() => setSelectedId(null)} />}
    </section>
  );
}
