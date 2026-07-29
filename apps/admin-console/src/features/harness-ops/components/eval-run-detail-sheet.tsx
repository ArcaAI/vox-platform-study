'use client';

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/components/shadcn/sheet';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@arcaai/ui/components/shadcn/table';
import { CopyButton } from '@/shared/copy-button';
import { formatDateTime, formatNumber } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useEvalRun } from '../api';
import type { EvalRunDetail } from '../api';

const PRE_CLASS = 'bg-muted max-h-60 overflow-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap';

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function EvalRunBody({ run }: { run: EvalRunDetail }) {
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <MetaItem label="Golden set">
          <span className="font-mono text-xs break-all">{run.goldenSetId}</span>
        </MetaItem>
        <MetaItem label="Model">
          {run.modelName}
          {run.modelVersion ? (
            <span className="text-muted-foreground">
              {' '}
              {'\u00b7'} {run.modelVersion}
            </span>
          ) : null}
        </MetaItem>
        <MetaItem label="Judge">{run.judgeModel ?? '\u2014'}</MetaItem>
        <MetaItem label="Status">{run.status ?? '\u2014'}</MetaItem>
        <MetaItem label="Started">{formatDateTime(run.startedAt)}</MetaItem>
        <MetaItem label="Completed">{formatDateTime(run.completedAt)}</MetaItem>
      </dl>
      {run.notes ? <p className="text-muted-foreground text-sm">{run.notes}</p> : null}
      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">Per-case scores ({formatNumber(run.scores.length)})</h3>
        {run.scores.length === 0 ? (
          <p className="text-muted-foreground text-sm">This run recorded no individual case scores.</p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table aria-label="Per-case scores">
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-muted-foreground h-9 text-xs font-medium">Case</TableHead>
                  <TableHead className="text-muted-foreground h-9 text-xs font-medium">Metric</TableHead>
                  <TableHead className="text-muted-foreground h-9 text-right text-xs font-medium">Score</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.scores.map((score) => (
                  <TableRow key={score.id}>
                    <TableCell className="font-mono text-xs">
                      <span className="block max-w-28 truncate" title={score.goldenCaseId}>
                        {score.goldenCaseId}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm" title={score.rationale ?? undefined}>
                      {score.metric}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {score.score}
                      {score.maxScore != null ? <span className="text-muted-foreground"> / {score.maxScore}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {run.aggregateScores != null ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-sm font-medium">Aggregate scores</h3>
          <pre className={PRE_CLASS}>{JSON.stringify(run.aggregateScores, null, 4)}</pre>
        </section>
      ) : null}
    </>
  );
}

/** Frame 37 drill-down: row click on the eval grid opens the per-case scores. */
export function EvalRunDetailSheet({ evalRunId, onOpenChange }: { evalRunId: string | null; onOpenChange: (open: boolean) => void }) {
  const runQuery = useEvalRun(evalRunId);

  return (
    <Sheet open={evalRunId !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="flex items-center gap-1 font-mono text-sm break-all">
            {evalRunId}
            {evalRunId ? <CopyButton value={evalRunId} label="Copy eval run id" /> : null}
          </SheetTitle>
          <SheetDescription>Per-case claim verdicts and metric scores for this eval run.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {runQuery.isLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : runQuery.error ? (
            <ErrorState error={runQuery.error} onRetry={() => void runQuery.refetch()} />
          ) : runQuery.data ? (
            <EvalRunBody run={runQuery.data} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
