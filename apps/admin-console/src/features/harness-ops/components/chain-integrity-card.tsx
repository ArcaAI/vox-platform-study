'use client';

import Link from 'next/link';
import { IconAlertTriangle, IconShieldCheck, IconShieldQuestion, IconShieldX, IconTimeline } from '@tabler/icons-react';
import { VirtualizedDataGrid, type ColumnDef } from '@arcaai/ui';
import { Alert, AlertDescription, AlertTitle } from '@arcaai/ui/components/shadcn/alert';
import { Card, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared/status-badge';
import { formatDateTime, formatNumber } from '@/shared/format';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import type { HarnessAuditEvent, HarnessAuditList } from '../api';

/** The audit endpoint returns one page (≤50); show it all in the scroll area. */
const AUDIT_ROWS_PER_PAGE = 50;

type VerdictState = 'loading' | 'intact' | 'broken' | 'unverified';

/**
 * Frame 37 verdict badge — never color alone: icon + text pair the tone.
 * "Unverified" is the error posture (the chain could not be re-checked).
 */
export function ChainVerdictBadge({ state }: { state: VerdictState }) {
    if (state === 'loading') return <Skeleton className="h-5 w-28 rounded-full" />;
    if (state === 'intact') return <StatusBadge label="Chain intact" colorRole="success" icon={<IconShieldCheck aria-hidden />} />;
    if (state === 'broken') return <StatusBadge label="Chain broken" colorRole="destructive" icon={<IconShieldX aria-hidden />} />;
    return <StatusBadge label="Unverified" colorRole="neutral" icon={<IconShieldQuestion aria-hidden />} />;
}

function auditMatches(event: HarnessAuditEvent, needle: string): boolean {
    const haystack = [event.consultationId, event.action, event.modelName, event.gateDecision ?? '', event.clinicianId ?? '', event.hash];
    return haystack.some((value) => value.toLowerCase().includes(needle));
}

/**
 * Frame 37 panel (a) — WORM chain-integrity verdict + the newest-first audit
 * trail. The verdict is chain-global (whole tenant chain, not this page);
 * `search` narrows the loaded page client-side (the audit endpoint has no
 * search param).
 */
export function ChainIntegrityCard({
    data,
    isLoading,
    error,
    onRetry,
    search,
}: {
    data: HarnessAuditList | undefined;
    isLoading: boolean;
    error: unknown;
    onRetry: () => void;
    search: string;
}) {
    const verdict: VerdictState = isLoading ? 'loading' : error || !data ? 'unverified' : data.verification.valid ? 'intact' : 'broken';
    const items = data?.items ?? [];
    const needle = search.trim().toLowerCase();
    const rows = needle ? items.filter((event) => auditMatches(event, needle)) : items;
    const lastAnchor = items[0]?.createdAt;
    // The grid's error slot is typed `Error | null`; the query error arrives as `unknown`.
    const errorObj = error ? (error instanceof Error ? error : new Error(String(error))) : null;

    const columns: ColumnDef<HarnessAuditEvent>[] = [
        {
            accessorKey: 'createdAt',
            header: 'Time',
            meta: { label: 'Time' },
            cell: ({ row }) => (
                <span className="whitespace-nowrap tabular-nums" title={`${row.original.createdAt} (UTC)`}>
                    {formatDateTime(row.original.createdAt)}
                </span>
            ),
        },
        { accessorKey: 'action', header: 'Action', meta: { label: 'Action' }, cell: ({ row }) => <span className="font-mono text-xs">{row.original.action}</span> },
        {
            accessorKey: 'consultationId',
            header: 'Consultation',
            meta: { label: 'Consultation' },
            cell: ({ row }) => (
                <span className="block max-w-28 truncate font-mono text-xs" title={row.original.consultationId}>
                    {row.original.consultationId}
                </span>
            ),
        },
        {
            accessorKey: 'gateDecision',
            header: 'Decision',
            meta: { label: 'Decision' },
            cell: ({ row }) => row.original.gateDecision ?? <span className="text-muted-foreground">{'\u2014'}</span>,
        },
    ];

    return (
        <Card className="gap-3 py-4">
            <CardHeader className="gap-1 px-4">
                <h2 className="text-sm font-medium">Chain integrity {'\u00b7'} audit</h2>
                <div className="flex flex-wrap items-center gap-2">
                    <ChainVerdictBadge state={verdict} />
                    {data ? (
                        <span className="text-muted-foreground text-sm tabular-nums">
                            {formatNumber(data.total)} rows
                            {lastAnchor ? ` \u00b7 last anchor ${formatDateTime(lastAnchor)}` : ''}
                        </span>
                    ) : isLoading ? (
                        <Skeleton className="h-4 w-36" />
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4">
                {verdict === 'broken' ? (
                    <Alert variant="destructive">
                        <IconAlertTriangle aria-hidden />
                        <AlertTitle>Chain integrity broken {'\u2014'} tampering suspected</AlertTitle>
                        <AlertDescription>
                            {data?.verification.brokenAtIndex !== null && data?.verification.brokenAtIndex !== undefined
                                ? `The hash chain no longer links at event index ${formatNumber(data.verification.brokenAtIndex)}. `
                                : ''}
                            {data?.verification.reason ?? 'Verify the WORM store before trusting this trail.'}
                        </AlertDescription>
                    </Alert>
                ) : null}
                <VirtualizedDataGrid<HarnessAuditEvent>
                    aria-label="WORM audit trail"
                    columns={columns}
                    data={rows}
                    getRowId={(row) => row.id}
                    height={360}
                    pageSizeOptions={[AUDIT_ROWS_PER_PAGE, 100]}
                    features={{
                        columnReorder: false,
                        columnResize: false,
                        columnPinning: false,
                        columnVisibility: false,
                        rowSelection: false,
                        globalSearch: false,
                        facetedFilters: false,
                        sorting: false,
                    }}
                    isLoading={isLoading}
                    error={errorObj}
                    onRetry={onRetry}
                    errorState={(err) => <ErrorState error={err} onRetry={onRetry} />}
                    emptyState={
                        <EmptyState
                            icon={IconTimeline}
                            title={needle ? 'No audit rows match your search' : 'No WORM rows in range'}
                            description={
                                needle ? (
                                    'The search only covers the loaded page — clear it to see every row.'
                                ) : (
                                    <>
                                        No evals have run yet either {'\u2014'} the trail fills as consultations flow through the harness.{' '}
                                        <Link href="/harness/policy" className="text-primary underline-offset-4 hover:underline">
                                            Review the harness policy
                                        </Link>
                                        .
                                    </>
                                )
                            }
                        />
                    }
                />
            </CardContent>
        </Card>
    );
}
