import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@arcaai/ui';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import { AdminApiError } from '../../api/admin-client';
import { useHarnessEvalRun, useHarnessEvalRuns, type EvalRunResponse } from '../api/harness';
import { EmptyState } from '../components/empty-state';
import { ErrorState } from '../components/error-state';
import { formatDateTime, shortId } from '../lib/format';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

const PAGE_SIZE = 20;

/** The first numeric aggregate metric of a run, used as the headline/trend value. */
function primaryAggregate(run: EvalRunResponse): { metric: string; value: number } | null {
  const scores = run.aggregateScores;
  if (scores && typeof scores === 'object' && !Array.isArray(scores)) {
    for (const [metric, value] of Object.entries(scores as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) return { metric, value };
    }
  }
  return null;
}

function statusTone(status?: string | null): string {
  const s = (status ?? '').toUpperCase();
  if (s === 'COMPLETED' || s === 'PASSED') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400';
  if (s === 'FAILED' || s === 'ERROR') return 'bg-red-500/15 text-red-700 dark:text-red-400';
  if (s === 'RUNNING') return 'bg-blue-500/15 text-blue-700 dark:text-blue-400';
  return 'bg-muted';
}

function TrendCard({ runs }: { runs: EvalRunResponse[] }) {
  // Oldest → newest, last 10, with a primary numeric metric.
  const points = useMemo(
    () =>
      [...runs]
        .reverse()
        .map((run) => ({ run, primary: primaryAggregate(run) }))
        .filter((p): p is { run: EvalRunResponse; primary: { metric: string; value: number } } => p.primary !== null)
        .slice(-10),
    [runs],
  );

  if (points.length === 0) return null;

  const max = Math.max(...points.map((p) => p.primary.value), 0.0001);
  const metricLabel = points[points.length - 1].primary.metric;

  return (
    <Card className="mb-6">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Score trend</CardTitle>
        <CardDescription>
          Latest runs by <span className="font-medium">{metricLabel}</span> (oldest → newest).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex h-24 items-end gap-1.5" data-testid="evals-trend">
          {points.map(({ run, primary }) => (
            <div key={run.id} className="flex flex-1 flex-col items-center gap-1" title={`${primary.metric}: ${primary.value}`}>
              <div className="bg-primary/70 w-full rounded-t" style={{ height: `${Math.max(4, (primary.value / max) * 100)}%` }} />
              <span className="text-muted-foreground text-[10px] tabular-nums">{primary.value.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default function HarnessEvalsPage() {
  const tenantId = useAuthStore((s) => s.tenantId);

  const [goldenSetDraft, setGoldenSetDraft] = useState('');
  const [goldenSetId, setGoldenSetId] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading, isFetching, isError, error } = useHarnessEvalRuns(
    {
      tenantId: tenantId || undefined,
      goldenSetId: goldenSetId.trim() || undefined,
      page,
      limit: PAGE_SIZE,
    },
    { onError: (e) => toast.error(errorMessage(e, 'Failed to load eval runs.')) },
  );

  const runs = data?.items ?? [];
  const total = data?.total ?? 0;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useHarnessEvalRun(selectedId ?? undefined, tenantId || undefined);

  const applyFilters = () => {
    setPage(1);
    setGoldenSetId(goldenSetDraft);
  };
  const resetFilters = () => {
    setGoldenSetDraft('');
    setGoldenSetId('');
    setPage(1);
  };

  const showSkeleton = isLoading && runs.length === 0;
  const showError = isError && runs.length === 0;
  const showEmpty = !isLoading && !isError && runs.length === 0;
  const nextDisabled = page * PAGE_SIZE >= total;

  return (
    <section aria-label="Harness eval runs">
      <div className="mb-4">
        <h2 className="text-xl font-semibold tracking-tight">Eval runs</h2>
        <p className="text-muted-foreground mt-1 text-sm">Golden-set evaluation history. Open a run to inspect its per-case metric scores.</p>
      </div>

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border p-3" data-testid="evals-filter-bar">
        <div className="flex min-w-56 flex-1 flex-col gap-1">
          <Label htmlFor="evals-golden-set">Golden set ID</Label>
          <Input
            id="evals-golden-set"
            value={goldenSetDraft}
            placeholder="filter by golden set"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setGoldenSetDraft(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter') applyFilters();
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={applyFilters} data-testid="evals-apply">
            Apply
          </Button>
          <Button variant="outline" onClick={resetFilters} data-testid="evals-reset">
            Reset
          </Button>
        </div>
      </div>

      {!showSkeleton && !showError && !showEmpty && <TrendCard runs={runs} />}

      {/* Results */}
      <div className="rounded-md border" data-testid="evals-results">
        {showSkeleton ? (
          <div className="space-y-2 p-3" data-testid="evals-skeleton">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : showError ? (
          <ErrorState description={errorMessage(error, 'Eval runs could not be loaded for this tenant.')} />
        ) : showEmpty ? (
          <EmptyState icon={FlaskConical} title="No eval runs" description="Golden-set evaluations for this tenant will appear here once they run." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Golden set</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Primary score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const primary = primaryAggregate(run);
                return (
                  <TableRow key={run.id} className="cursor-pointer" data-testid="evals-row" onClick={() => setSelectedId(run.id)}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(run.startedAt ?? run.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{shortId(run.goldenSetId)}</TableCell>
                    <TableCell className="max-w-40 truncate text-sm">
                      {run.modelName}
                      {run.modelVersion ? <span className="text-muted-foreground"> · {run.modelVersion}</span> : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('text-xs', statusTone(run.status))}>
                        {run.status ?? '—'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{primary ? `${primary.value}` : '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <span className="text-muted-foreground text-sm" data-testid="evals-pagination-info">
          {total > 0 ? `Page ${page} · ${total} runs` : '0 runs'}
        </span>
        <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={nextDisabled || isFetching} onClick={() => setPage((p) => p + 1)}>
          Next
        </Button>
      </div>

      {/* Drill-in: per-case scores */}
      <Sheet open={selectedId !== null} onOpenChange={(open: boolean) => !open && setSelectedId(null)}>
        <SheetContent className="w-full overflow-hidden sm:max-w-2xl" data-testid="evals-detail-drawer">
          <SheetHeader>
            <SheetTitle>Eval run</SheetTitle>
            {detail.data ? (
              <SheetDescription>{`${detail.data.modelName} · ${detail.data.goldenSetId}`}</SheetDescription>
            ) : (
              <SheetDescription asChild>
                <Skeleton className="mt-1 h-4 w-48" data-testid="evals-detail-desc-skeleton" />
              </SheetDescription>
            )}
          </SheetHeader>
          <ScrollArea className="h-[calc(100vh-8rem)] px-4 pb-6">
            {detail.isLoading ? (
              <div className="space-y-2" data-testid="evals-detail-skeleton">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-40 w-full" />
              </div>
            ) : detail.data ? (
              <>
                <dl className="mb-4 grid grid-cols-3 gap-2 text-sm">
                  <DetailRow label="Run ID" value={detail.data.id} mono />
                  <DetailRow label="Golden set" value={detail.data.goldenSetId} mono />
                  <DetailRow label="Model" value={`${detail.data.modelName}${detail.data.modelVersion ? ` · ${detail.data.modelVersion}` : ''}`} />
                  <DetailRow label="Judge" value={detail.data.judgeModel ?? '—'} />
                  <DetailRow label="Status" value={detail.data.status ?? '—'} />
                  <DetailRow label="Started" value={formatDateTime(detail.data.startedAt)} />
                  <DetailRow label="Completed" value={formatDateTime(detail.data.completedAt)} />
                </dl>
                {detail.data.scores.length === 0 ? (
                  <EmptyState icon={FlaskConical} title="No per-case scores" description="This run did not record individual case scores." />
                ) : (
                  <div className="overflow-auto rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Case</TableHead>
                          <TableHead>Metric</TableHead>
                          <TableHead className="text-right">Score</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detail.data.scores.map((score) => (
                          <TableRow key={score.id}>
                            <TableCell className="font-mono text-xs">{shortId(score.goldenCaseId)}</TableCell>
                            <TableCell>{score.metric}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {score.score}
                              {score.maxScore != null ? <span className="text-muted-foreground"> / {score.maxScore}</span> : null}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </>
            ) : (
              <EmptyState icon={FlaskConical} title="Run unavailable" description="The selected eval run could not be loaded." />
            )}
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </section>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-muted-foreground col-span-1">{label}</dt>
      <dd className={cn('col-span-2 break-all', mono && 'font-mono text-xs')}>{value}</dd>
    </>
  );
}
