'use client';

import { useMemo, useState } from 'react';
import { IconFlask } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { useEvalRuns } from '../api';
import type { EvalRun } from '../api';
import { EvalRunDetailSheet } from './eval-run-detail-sheet';

const PAGE_SIZE = 10;
const EM_DASH = '\u2014';

/**
 * `aggregateScores` is free-form JSON on the DTO — there is no first-class
 * pass-rate field. The frame's Cases/Pass/Score columns are therefore a
 * best-effort projection over common key spellings, falling back to the first
 * finite numeric metric for the score.
 */
function numericField(scores: unknown, keys: string[]): number | null {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return null;
  const record = scores as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function firstNumeric(scores: unknown): number | null {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) return null;
  for (const value of Object.values(scores as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export function evalCases(run: EvalRun): number | null {
  return numericField(run.aggregateScores, ['caseCount', 'cases', 'totalCases', 'n']);
}

export function evalPass(run: EvalRun): number | null {
  return numericField(run.aggregateScores, ['passCount', 'passed', 'pass']);
}

export function evalScore(run: EvalRun): number | null {
  return numericField(run.aggregateScores, ['overall', 'score', 'mean', 'average']) ?? firstNumeric(run.aggregateScores);
}

function numberCell(value: number | null) {
  return value === null ? <span className="text-muted-foreground">{EM_DASH}</span> : <span className="tabular-nums">{formatNumber(value)}</span>;
}

/** How the run was triggered (EvalRun.triggerType) — MANUAL (run-now) | PROMOTION (approve/pin gate) | CI. */
function triggerTypeVariant(triggerType: string | null): 'default' | 'secondary' | 'outline' {
  if (triggerType === 'PROMOTION') return 'default';
  if (triggerType === 'CI') return 'secondary';
  return 'outline';
}

/** Right-aligned numeric column header (the grid header cell is left-aligned by default). */
function NumericHeader({ label }: { label: string }) {
  return <span className="w-full text-right">{label}</span>;
}

/** Frame 37 panel (b) — eval runs grid; row click opens the per-case scores. */
export function EvalRunsPanel() {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  // Server offset pagination; this endpoint's `page` is 1-based (unlike the
  // platform's 0-based lists), so the 0-based grid page maps with +1.
  const [queryState, setQueryState] = useState<DataQueryState>(() => ({
    pagination: { mode: 'offset', page: 0, limit: PAGE_SIZE },
    sorting: [],
    filters: [],
    globalSearch: undefined,
  }));
  const page = queryState.pagination.mode === 'offset' ? queryState.pagination.page : 0;
  const limit = queryState.pagination.limit;
  const runsQuery = useEvalRuns({ page: page + 1, limit });

  const runs = runsQuery.data?.items ?? [];
  const total = runsQuery.data?.total ?? 0;

  const columns = useMemo<ColumnDef<EvalRun>[]>(
    () => [
      {
        accessorKey: 'startedAt',
        header: 'Eval run',
        meta: { label: 'Eval run' },
        cell: ({ row }) => (
          <span className="whitespace-nowrap tabular-nums" title={row.original.id}>
            {formatDateTime(row.original.startedAt ?? row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'triggerType',
        header: 'Trigger',
        meta: { label: 'Trigger' },
        cell: ({ row }) =>
          row.original.triggerType ? (
            <Badge variant={triggerTypeVariant(row.original.triggerType)}>{row.original.triggerType}</Badge>
          ) : (
            <span className="text-muted-foreground">{EM_DASH}</span>
          ),
      },
      {
        id: 'cases',
        header: () => <NumericHeader label="Cases" />,
        meta: { label: 'Cases' },
        cell: ({ row }) => <div className="w-full text-right">{numberCell(evalCases(row.original))}</div>,
      },
      {
        id: 'pass',
        header: () => <NumericHeader label="Pass" />,
        meta: { label: 'Pass' },
        cell: ({ row }) => <div className="w-full text-right">{numberCell(evalPass(row.original))}</div>,
      },
      {
        id: 'score',
        header: () => <NumericHeader label="Score" />,
        meta: { label: 'Score' },
        cell: ({ row }) => {
          const score = evalScore(row.original);
          return (
            <div className="w-full text-right">
              {score === null ? (
                <span className="text-muted-foreground">{EM_DASH}</span>
              ) : (
                <span className="tabular-nums">{Math.round(score * 100) / 100}</span>
              )}
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <Card className="gap-3 py-4">
      <CardHeader className="gap-1 px-4">
        <h2 className="text-sm font-medium">Eval runs</h2>
        <span className="text-muted-foreground text-sm">
          {runsQuery.data ? `${formatNumber(total)} runs` : '\u00a0'}
          <span aria-hidden className="font-mono text-xs">
            {' '}
            {'\u00b7'} GET eval-runs {'\u00b7'} row click {'\u2192'} per-case scores
          </span>
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4">
        <VirtualizedDataGrid<EvalRun>
          aria-label="Eval runs"
          columns={columns}
          data={runs}
          getRowId={(row) => row.id}
          height={360}
          persistence={gridPersistence('harness-eval-runs')}
          manual={{ pagination: true }}
          rowCount={total}
          pageSizeOptions={[PAGE_SIZE, 25, 50]}
          queryState={queryState}
          onQueryStateChange={setQueryState}
          features={{
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
            rowSelection: false,
            globalSearch: false,
            facetedFilters: false,
            sorting: false,
          }}
          isLoading={runsQuery.isLoading}
          isBusy={runsQuery.isFetching && !runsQuery.isLoading}
          error={runsQuery.error}
          onRetry={() => void runsQuery.refetch()}
          errorState={(err) => <ErrorState error={err} onRetry={() => void runsQuery.refetch()} />}
          emptyState={
            <EmptyState icon={IconFlask} title="No evals run yet" description="Golden-set evaluation runs appear here once they execute." />
          }
          onRowClick={(row) => setOpenRunId(row.id)}
        />
        <EvalRunDetailSheet evalRunId={openRunId} onOpenChange={(open) => !open && setOpenRunId(null)} />
      </CardContent>
    </Card>
  );
}
