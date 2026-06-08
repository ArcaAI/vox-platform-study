import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@arcaai/ui';
import { AlertCircle, AlertTriangle, ClipboardCheck, FlaskConical, Inbox, RefreshCw, ScrollText, TimerReset } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { AdminApiError } from '../../api/admin-client';
import { useHarnessAudit, useHarnessEvalRuns, useHarnessGateQueue, type EvalRunResponse } from '../api/harness';
import { EmptyState } from '../components/empty-state';
import { ErrorState } from '../components/error-state';
import { formatDateTime, formatDuration, shortId } from '../lib/format';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
  loading,
  error,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: typeof Inbox;
  tone?: 'default' | 'warning' | 'danger';
  loading?: boolean;
  error?: boolean;
}) {
  const toneClass = tone === 'danger' ? 'text-red-600 dark:text-red-400' : tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : '';
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
        <Icon className={cn('size-4', toneClass || 'text-muted-foreground')} aria-hidden />
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-16" />
        ) : error ? (
          <div className="text-muted-foreground flex items-center gap-1.5 text-sm" data-testid="stat-error">
            <AlertCircle className="text-destructive size-4" aria-hidden />
            Failed to load
          </div>
        ) : (
          <>
            <div className={cn('text-2xl font-bold tabular-nums', toneClass)}>{value}</div>
            {hint && <p className="text-muted-foreground mt-1 text-xs">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function latestScoreSummary(run?: EvalRunResponse): string {
  if (!run) return '—';
  const scores = run.aggregateScores;
  if (scores && typeof scores === 'object' && !Array.isArray(scores)) {
    const entries = Object.entries(scores as Record<string, unknown>).filter(([, v]) => typeof v === 'number');
    if (entries.length > 0) {
      const [metric, value] = entries[0];
      return `${metric}: ${value}`;
    }
  }
  return run.status ?? '—';
}

export default function HarnessOverviewPage() {
  const tenantId = useAuthStore((s) => s.tenantId);

  // One shared toast id collapses concurrent failures (the three panels share a
  // backend) into a single notice, alongside each panel's inline error state.
  const onQueryError = (error: unknown) => toast.error(errorMessage(error, 'Failed to load harness data.'), { id: 'harness-overview-error' });

  const gate = useHarnessGateQueue(tenantId || undefined, { onError: onQueryError });
  const audit = useHarnessAudit({ tenantId: tenantId || undefined, limit: 5, offset: 0 }, { onError: onQueryError });
  const evals = useHarnessEvalRuns({ tenantId: tenantId || undefined, limit: 1, page: 1 }, { onError: onQueryError });

  const latestRun = evals.data?.items?.[0];
  const queueItems = gate.data?.items ?? [];
  const auditItems = audit.data?.items ?? [];

  const isFetching = gate.isFetching || audit.isFetching || evals.isFetching;
  const refreshAll = () => {
    void gate.refetch();
    void audit.refetch();
    void evals.refetch();
  };

  return (
    <section aria-label="Harness overview">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Overview</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Live health of the clinical documentation loop: the clinician gate queue, recent WORM audit activity, and the latest eval scores.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refreshAll} disabled={isFetching} data-testid="overview-refresh">
          <RefreshCw className={cn('mr-2 size-4', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* KPI row */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Awaiting review"
          value={gate.data?.total ?? 0}
          icon={ClipboardCheck}
          loading={gate.isLoading}
          error={gate.isError}
          hint="Consultations PENDING_REVIEW"
        />
        <StatCard
          label="SLA breached"
          value={gate.data?.slaBreachedCount ?? 0}
          icon={AlertTriangle}
          tone={(gate.data?.slaBreachedCount ?? 0) > 0 ? 'danger' : 'default'}
          loading={gate.isLoading}
          error={gate.isError}
          hint={`SLA ${formatDuration(gate.data?.gateSlaSeconds)}`}
        />
        <StatCard
          label="Escalated"
          value={gate.data?.escalatedCount ?? 0}
          icon={TimerReset}
          tone={(gate.data?.escalatedCount ?? 0) > 0 ? 'warning' : 'default'}
          loading={gate.isLoading}
          error={gate.isError}
          hint={`Escalates after ${formatDuration(gate.data?.gateEscalationSeconds)}`}
        />
        <StatCard
          label="Latest eval"
          value={latestScoreSummary(latestRun)}
          icon={FlaskConical}
          loading={evals.isLoading}
          error={evals.isError}
          hint={latestRun?.modelName ?? 'No runs yet'}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Gate queue preview */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Gate queue</CardTitle>
            <CardDescription>Consultations awaiting clinician sign-off (oldest first).</CardDescription>
          </CardHeader>
          <CardContent>
            {gate.isLoading ? (
              <div className="space-y-2" data-testid="overview-gate-skeleton">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : gate.isError ? (
              <ErrorState description={errorMessage(gate.error, 'Could not load the gate queue.')} />
            ) : queueItems.length === 0 ? (
              <EmptyState icon={Inbox} title="Queue is clear" description="No consultations are currently awaiting clinician review." />
            ) : (
              <div className="overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Consultation</TableHead>
                      <TableHead className="text-right">Waiting</TableHead>
                      <TableHead className="text-right">Regens</TableHead>
                      <TableHead>SLA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queueItems.slice(0, 5).map((item) => (
                      <TableRow key={item.consultationId}>
                        <TableCell className="font-mono text-xs">{shortId(item.consultationId)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatDuration(item.ageSeconds)}</TableCell>
                        <TableCell className="text-right tabular-nums">{item.regenCount}</TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-xs',
                              item.slaBreached
                                ? 'bg-red-500/15 text-red-700 dark:text-red-400'
                                : item.escalated
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400'
                                  : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
                            )}
                          >
                            {item.slaBreached ? 'Breached' : item.escalated ? 'Escalated' : 'On track'}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent audit */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Recent audit activity</CardTitle>
            <CardDescription>The latest tamper-evident WORM events, including gate decisions.</CardDescription>
          </CardHeader>
          <CardContent>
            {audit.isLoading ? (
              <div className="space-y-2" data-testid="overview-audit-skeleton">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : audit.isError ? (
              <ErrorState description={errorMessage(audit.error, 'Could not load recent audit activity.')} />
            ) : auditItems.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="No audit events"
                description="Harness activity will appear here once the loop runs for this tenant."
              />
            ) : (
              <ul className="divide-border divide-y">
                {auditItems.map((event) => (
                  <li key={event.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-[10px]">
                          {event.action}
                        </Badge>
                        {event.gateDecision && (
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px]',
                              event.gateDecision.toUpperCase().includes('APPROVE')
                                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                                : 'bg-red-500/15 text-red-700 dark:text-red-400',
                            )}
                          >
                            {event.gateDecision}
                          </Badge>
                        )}
                      </div>
                      <p className="text-muted-foreground truncate text-xs">
                        {event.modelName}
                        {event.modelVersion ? ` · ${event.modelVersion}` : ''} · {shortId(event.consultationId)}
                      </p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">{formatDateTime(event.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
