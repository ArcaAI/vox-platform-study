'use client';

import { useState } from 'react';
import { IconFlask } from '@tabler/icons-react';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { useEvalRuns } from '../api';
import type { EvalRun } from '../api';
import { EvalRunDetailSheet } from './eval-run-detail-sheet';

const PAGE_SIZE = 10;
const EM_DASH = '\u2014';

/**
 * `aggregateScores` is free-form JSON on the DTO — there is no first-class
 * pass-rate field. The frame's Cases/Pass/Score columns are therefore a
 * best-effort projection over common key spellings, falling back to the first
 * finite numeric metric (the ui-playground precedent) for the score.
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

/** Frame 37 panel (b) — eval runs grid; row click opens the per-case scores. */
export function EvalRunsPanel() {
    const [page, setPage] = useState(1);
    const [openRunId, setOpenRunId] = useState<string | null>(null);
    // NOTE: this endpoint's `page` is 1-based (unlike the platform's 0-based lists).
    const runsQuery = useEvalRuns({ page, limit: PAGE_SIZE });

    const runs = runsQuery.data?.items ?? [];
    const total = runsQuery.data?.total ?? 0;

    const columns: DataTableColumn<EvalRun>[] = [
        {
            key: 'run',
            header: 'Eval run',
            cell: (row) => (
                <span className="whitespace-nowrap tabular-nums" title={row.id}>
                    {formatDateTime(row.startedAt ?? row.createdAt)}
                </span>
            ),
        },
        { key: 'cases', header: 'Cases', className: 'text-right', headerClassName: 'text-right', cell: (row) => numberCell(evalCases(row)) },
        { key: 'pass', header: 'Pass', className: 'text-right', headerClassName: 'text-right', cell: (row) => numberCell(evalPass(row)) },
        {
            key: 'score',
            header: 'Score',
            className: 'text-right',
            headerClassName: 'text-right',
            cell: (row) => {
                const score = evalScore(row);
                return score === null ? (
                    <span className="text-muted-foreground">{EM_DASH}</span>
                ) : (
                    <span className="tabular-nums">{Math.round(score * 100) / 100}</span>
                );
            },
        },
    ];

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
                <DataTable
                    aria-label="Eval runs"
                    columns={columns}
                    rows={runs}
                    rowKey={(row) => row.id}
                    isLoading={runsQuery.isLoading}
                    error={runsQuery.error}
                    onRetry={() => void runsQuery.refetch()}
                    skeletonRows={5}
                    empty={<EmptyState icon={IconFlask} title="No evals run yet" description="Golden-set evaluation runs appear here once they execute." />}
                    onRowClick={(row) => setOpenRunId(row.id)}
                />
                <TablePagination page={page - 1} limit={PAGE_SIZE} total={total} onPageChange={(zeroBased) => setPage(zeroBased + 1)} />
                <EvalRunDetailSheet evalRunId={openRunId} onOpenChange={(open) => !open && setOpenRunId(null)} />
            </CardContent>
        </Card>
    );
}
