'use client';

import { useState } from 'react';
import { IconDna, IconFilterOff } from '@tabler/icons-react';
import { parseAsInteger, parseAsString, useQueryStates } from 'nuqs';
import { toast } from 'sonner';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { DataTable, type DataTableColumn } from '@/shared/data/data-table';
import { FilterBar, FilterSearch, FilterSelect, type FilterOption } from '@/shared/data/filter-bar';
import { TablePagination } from '@/shared/data/table-pagination';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import type { StreamStatus } from '@/shared/streams';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDnaDashboard, useDnaJobProgress, useDnaReports } from '../api';
import type { DnaJobStatus, DnaReport, ListDnaReportsParams, UseDnaJobProgressResult } from '../api';
import { DoctorDetailPanel } from './doctor-detail-panel';
import { GenerateReportDialog } from './generate-report-dialog';

const DEFAULT_LIMIT = 25;

/**
 * Frame 33 freshness note: the list endpoint has no freshness/staleness param
 * — the only real toggle is `includeDisabled`, surfaced here instead.
 */
const DISABLED_OPTIONS: FilterOption[] = [{ value: 'true', label: 'Shown' }];

const JOB_STATE_LABELS: Record<DnaJobStatus['status'], string> = {
    queued: 'Queued',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
};

/**
 * Transport badge for the progress strip: Live while the SSE stream is open,
 * Polling fallback once it errors (the TASK-419 gap path — see
 * useDnaJobProgress), Done/Failed at terminal. Never color-only: the label
 * rides along and the percent is printed next to the bar.
 */
function jobBadgeMeta(job: DnaJobStatus | null, streamStatus: StreamStatus, isTerminal: boolean): { label: string; role: StatusColorRole } {
    if (isTerminal) {
        return job?.status === 'completed' ? { label: 'Done', role: 'success' } : { label: 'Failed', role: 'destructive' };
    }
    if (streamStatus === 'open') return { label: 'Live', role: 'primary' };
    if (streamStatus === 'connecting') return { label: 'Connecting', role: 'info' };
    if (streamStatus === 'error') return { label: 'Polling fallback', role: 'warning' };
    return { label: 'Polling', role: 'neutral' };
}

/** Inline progress (SSE/poll driven) shown in the dashboard card while a job runs. */
function JobProgressStrip({ jobId, progress }: { jobId: string; progress: UseDnaJobProgressResult }) {
    const { job, streamStatus, isTerminal } = progress;
    const percent = Math.max(0, Math.min(100, Math.round(job?.progress ?? 0)));
    const meta = jobBadgeMeta(job, streamStatus, isTerminal);
    const stateLabel = job ? JOB_STATE_LABELS[job.status] : 'Queued';

    return (
        <div className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <StatusBadge label={meta.label} colorRole={meta.role} icon={<StatusDot colorRole={meta.role} size="sm" />} />
                <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">{jobId}</span>
            </div>
            <Progress value={percent} aria-label={`DNA generation progress: ${stateLabel}, ${percent}%`} />
            <p aria-live="polite" className="text-muted-foreground text-xs tabular-nums">
                {stateLabel} {'\u00b7'} {percent}%
                {job?.status === 'failed' && job.error ? <span className="text-destructive"> {'\u00b7'} {job.error}</span> : null}
            </p>
        </div>
    );
}

/**
 * Frame 33 panel (a) — GET /dashboard roll-up plus the generate/SSE hint
 * lines and the live job progress. The frame's "avg confidence" and
 * "stale (>90 d)" tiles have no DTO backing (DnaDashboardResponse carries
 * usersWithStyle/avgVersions/recentActivity) — recorded as deviations.
 */
function DashboardCard({
    dashboard,
    reportsTotal,
    activeJobId,
    progress,
}: {
    dashboard: ReturnType<typeof useDnaDashboard>;
    reportsTotal: number | undefined;
    activeJobId: string | null;
    progress: UseDnaJobProgressResult;
}) {
    const data = dashboard.data;
    const isLoading = dashboard.isPending;

    return (
        <Card className="gap-4">
            <CardHeader>
                <h2 className="text-sm leading-none font-semibold">Dashboard</h2>
                <CardAction>
                    <span aria-hidden className="text-muted-foreground font-mono text-xs">
                        GET /dashboard
                    </span>
                </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {dashboard.isError && !data ? (
                    <ErrorState title={'Couldn\u2019t load the DNA dashboard'} error={dashboard.error} onRetry={() => void dashboard.refetch()} />
                ) : (
                    <div className="grid grid-cols-2 gap-3">
                        <StatCard
                            density="compact"
                            label="Reports"
                            value={reportsTotal === undefined ? null : formatNumber(reportsTotal)}
                            isLoading={reportsTotal === undefined}
                            hint="in current filter"
                        />
                        <StatCard
                            density="compact"
                            label="Doctors covered"
                            value={data ? formatNumber(data.usersWithStyle) : null}
                            isLoading={isLoading}
                        />
                        <StatCard density="compact" label="Avg versions" value={data ? formatNumber(data.avgVersions) : null} isLoading={isLoading} />
                        <StatCard
                            density="compact"
                            label={data ? `Usage \u00b7 ${data.recentActivity.windowDays}d` : 'Usage'}
                            value={data ? formatNumber(data.recentActivity.total) : null}
                            isLoading={isLoading}
                        />
                    </div>
                )}
                <div className="text-muted-foreground flex flex-col gap-1 font-mono text-xs">
                    <span>Generate: POST /generate/:doctorId</span>
                    <span>SSE: GET /jobs/:jobId/stream</span>
                </div>
                {activeJobId ? <JobProgressStrip jobId={activeJobId} progress={progress} /> : null}
            </CardContent>
        </Card>
    );
}

function DnaWritingStylesBody() {
    const [{ doctor, disabled, page, limit, selected }, setParams] = useQueryStates({
        doctor: parseAsString.withDefault(''),
        disabled: parseAsString.withDefault(''),
        // ONE-based (this controller deviates from the zero-based convention).
        page: parseAsInteger.withDefault(1),
        limit: parseAsInteger.withDefault(DEFAULT_LIMIT),
        selected: parseAsString.withDefault(''),
    });

    const listParams: ListDnaReportsParams = {
        page,
        limit,
        ...(doctor ? { doctorId: doctor } : {}),
        ...(disabled === 'true' ? { includeDisabled: true } : {}),
    };
    const reports = useDnaReports(listParams);
    const dashboard = useDnaDashboard();

    const [generateOpen, setGenerateOpen] = useState(false);
    const [activeJobId, setActiveJobId] = useState<string | null>(null);
    const progress = useDnaJobProgress(activeJobId, {
        onTerminal: (job) => {
            if (job.status === 'completed') {
                toast.success('DNA report generated');
            } else {
                toast.error(job.error || 'DNA generation failed');
            }
        },
    });

    const rows = reports.data?.data ?? [];
    const total = reports.data?.count ?? 0;
    const hasFilters = Boolean(doctor || disabled === 'true');

    const columns: DataTableColumn<DnaReport>[] = [
        { key: 'doctor', header: 'Doctor', mono: true, cell: (row) => <span className="font-medium">{row.doctorId}</span> },
        {
            key: 'version',
            header: 'Version',
            cell: (row) => (
                <span className="flex items-center gap-2">
                    <span className="tabular-nums">v{row.currentVersionNumber}</span>
                    {row.isLatest ? <Badge variant="secondary">Latest</Badge> : null}
                </span>
            ),
        },
        { key: 'status', header: 'Status', cell: (row) => <ResourceStatusBadge status={row.resourceStatus} /> },
        {
            key: 'updated',
            header: 'Updated',
            cell: (row) => <span className="text-muted-foreground">{formatRelativeTime(row.updatedAt)}</span>,
        },
    ];

    const empty = hasFilters ? (
        <EmptyState
            icon={IconFilterOff}
            title="No reports match your filters"
            description="Try a different doctor ID or clear the filters."
            action={
                <Button variant="outline" onClick={() => setParams({ doctor: null, disabled: null, page: null })}>
                    <IconFilterOff aria-hidden />
                    Clear filters
                </Button>
            }
        />
    ) : (
        <EmptyState
            icon={IconDna}
            title="No DNA reports yet"
            description="Generate the first writing-style report for a doctor in this tenant."
            action={
                <Button onClick={() => setGenerateOpen(true)}>
                    <IconDna aria-hidden />
                    Generate report
                </Button>
            }
        />
    );

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                title="DNA Writing Styles"
                meta={
                    <>
                        {reports.data ? (
                            <span>
                                {formatNumber(total)} reports
                                {dashboard.data ? ` \u00b7 ${formatNumber(dashboard.data.usersWithStyle)} doctors covered` : ''}
                            </span>
                        ) : (
                            <Skeleton className="h-4 w-40" />
                        )}
                        <span aria-hidden className="text-muted-foreground font-mono text-xs">
                            GET /admin/dna-writing-styles
                        </span>
                    </>
                }
                actions={
                    <>
                        {!selected ? <span className="text-muted-foreground text-xs">Select a doctor row to enable</span> : null}
                        <Button onClick={() => setGenerateOpen(true)} disabled={!selected}>
                            <IconDna aria-hidden />
                            Generate report
                        </Button>
                    </>
                }
            />
            <FilterBar shown={rows.length} total={total}>
                <FilterSearch
                    label="Filter by doctor ID"
                    placeholder={'Filter by doctor ID\u2026'}
                    value={doctor}
                    onChange={(value) => setParams({ doctor: value || null, page: null })}
                />
                <FilterSelect
                    id="dna-disabled-filter"
                    label="Disabled reports"
                    value={disabled}
                    onChange={(value) => setParams({ disabled: value || null, page: null })}
                    options={DISABLED_OPTIONS}
                    allLabel="Hidden"
                />
            </FilterBar>
            <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_minmax(0,22rem)]">
                <DashboardCard dashboard={dashboard} reportsTotal={reports.data?.count} activeJobId={activeJobId} progress={progress} />
                <div className="flex flex-col gap-3">
                    <DataTable
                        aria-label="DNA reports"
                        columns={columns}
                        rows={rows}
                        rowKey={(row) => row.id}
                        isLoading={reports.isLoading}
                        error={reports.error}
                        onRetry={() => void reports.refetch()}
                        empty={empty}
                        onRowClick={(row) => setParams({ selected: row.doctorId })}
                    />
                    {/* TablePagination is zero-based; this controller is ONE-based. */}
                    <TablePagination
                        page={page - 1}
                        limit={limit}
                        total={total}
                        onPageChange={(zeroBased) => setParams({ page: zeroBased + 1 === 1 ? null : zeroBased + 1 })}
                        onLimitChange={(next) => setParams({ limit: next === DEFAULT_LIMIT ? null : next, page: null })}
                    />
                </div>
                {/* Keyed by doctor so panel-local state (edit mode) resets on selection change. */}
                <DoctorDetailPanel key={selected || 'none'} doctorId={selected} onGenerate={() => setGenerateOpen(true)} />
            </div>
            <GenerateReportDialog
                open={generateOpen}
                onOpenChange={setGenerateOpen}
                initialDoctorId={selected}
                onQueued={(jobId) => setActiveJobId(jobId)}
            />
        </div>
    );
}

/**
 * Frame 33 — DNA writing styles administration (tier 30–49, matrix row 26).
 * Tenant-scoped: elevated sessions need a working tenant before any query
 * mounts; tenant admins pass straight through (tenant-pinned).
 */
export function DnaWritingStylesScreen() {
    return (
        <WorkingTenantGate
            title="DNA Writing Styles"
            meta={
                <span aria-hidden className="text-muted-foreground font-mono text-xs">
                    GET /admin/dna-writing-styles
                </span>
            }
            description="DNA writing styles are tenant-scoped. Pick a working tenant from the switcher in the top bar to load its reports and dashboard."
        >
            <DnaWritingStylesBody />
        </WorkingTenantGate>
    );
}
