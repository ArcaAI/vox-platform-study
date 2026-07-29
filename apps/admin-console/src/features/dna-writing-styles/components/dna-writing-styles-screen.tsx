'use client';

import { useMemo, useState } from 'react';
import { IconDna, IconFilterOff } from '@tabler/icons-react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import { VirtualizedDataGrid, type ColumnDef, type DataQueryState } from '@arcaai/ui';
import { StatCard } from '@arcaai/ui/components/metrics/stat-card';
import { StatusDot } from '@arcaai/ui/components/metrics/status-dot';
import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared/status-badge';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Button } from '@arcaai/ui/components/shadcn/button';
import { Card, CardAction, CardContent, CardHeader } from '@arcaai/ui/components/shadcn/card';
import { Progress } from '@arcaai/ui/components/shadcn/progress';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { useAdminGridParams } from '@/shared/data/admin-data-grid';
import { normalizeList } from '@/shared/data/envelopes';
import type { FilterOption } from '@/shared/data/filter-bar';
import { gridPersistence } from '@/shared/data/grid-persistence';
import { NameWithId } from '@/shared/data/name-with-id';
import { formatNumber, formatRelativeTime } from '@/shared/format';
import { PageHeader } from '@/shared/page/page-header';
import { ScreenTemplate } from '@/shared/page/screen-template';
import { StatusFooter } from '@/shared/page/status-footer';
import { EmptyState } from '@/shared/state/empty-state';
import { ErrorState } from '@/shared/state/error-state';
import { ResourceStatusBadge } from '@/shared/status/resource-status-badge';
import type { StreamStatus } from '@/shared/streams';
import { WorkingTenantGate } from '@/shared/tenant-scope/working-tenant-gate';
import { useDnaDashboard, useDnaJobProgress, useDnaReports } from '../api';
import type { DnaJobStatus, DnaReport, ListDnaReportsParams, UseDnaJobProgressResult } from '../api';
import { DoctorDetailDrawer } from './doctor-detail';
import { GenerateReportDialog } from './generate-report-dialog';

/**
 * Frame 33 freshness note: the list endpoint has no freshness/staleness param
 * — the only real toggle is `includeDisabled`. Modelled as the Status column's
 * faceted filter since the endpoint has no status-equality param.
 */
const DISABLED_OPTIONS: FilterOption[] = [{ value: 'true', label: 'Include disabled' }];

/** Scalar value of a single-value faceted filter from the grid query-state. */
function scalarFilterValue(state: DataQueryState, id: string): string {
  const rule = state.filters.find((filter) => filter.id === id);
  if (!rule) return '';
  return Array.isArray(rule.value) ? String(rule.value[0] ?? '') : String(rule.value ?? '');
}

const JOB_STATE_LABELS: Record<DnaJobStatus['status'], string> = {
  queued: 'Queued',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * Transport badge for the progress strip: Live while the SSE stream (the
 * primary transport) is open, Polling once it errors and the documented 2s
 * fallback poll takes over (see useDnaJobProgress), Done/Failed at terminal.
 * Never color-only: the label rides along and the percent is printed next to
 * the bar.
 */
function jobBadgeMeta(job: DnaJobStatus | null, streamStatus: StreamStatus, isTerminal: boolean): { label: string; role: StatusColorRole } {
  if (isTerminal) {
    return job?.status === 'completed' ? { label: 'Done', role: 'success' } : { label: 'Failed', role: 'destructive' };
  }
  if (streamStatus === 'open') return { label: 'Live', role: 'primary' };
  if (streamStatus === 'connecting') return { label: 'Connecting', role: 'info' };
  if (streamStatus === 'error') return { label: 'Polling', role: 'warning' };
  return { label: 'Waiting', role: 'neutral' };
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
        {job?.status === 'failed' && job.error ? (
          <span className="text-destructive">
            {' '}
            {'\u00b7'} {job.error}
          </span>
        ) : null}
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              density="compact"
              label="Reports"
              value={reportsTotal === undefined ? null : formatNumber(reportsTotal)}
              isLoading={reportsTotal === undefined}
              hint="in current filter"
            />
            <StatCard density="compact" label="Doctors covered" value={data ? formatNumber(data.usersWithStyle) : null} isLoading={isLoading} />
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
  // Grid query-state (doctor/disabled filters, page, limit) lives in the URL
  // via the standard codec; `selected` (the detail-panel doctor) stays its own
  // param. Filters map to the endpoint's discrete doctorId/includeDisabled.
  const query = useAdminGridParams();
  const [selected, setSelected] = useQueryState('selected', parseAsString.withDefault(''));

  const doctor = scalarFilterValue(query.queryState, 'doctorId');
  const includeDisabled = scalarFilterValue(query.queryState, 'resourceStatus') === 'true';
  const page = query.queryState.pagination.mode === 'offset' ? query.queryState.pagination.page : 0;
  const limit = query.queryState.pagination.limit;

  const listParams: ListDnaReportsParams = {
    // URL page is 0-based; this controller is ONE-based.
    page: page + 1,
    limit,
    ...(doctor ? { doctorId: doctor } : {}),
    ...(includeDisabled ? { includeDisabled: true } : {}),
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

  const { rows, total } = normalizeList<DnaReport>(reports.data);
  const totalCount = total ?? 0;
  const hasFilters = Boolean(doctor || includeDisabled);

  const clearFilters = () => query.setQueryState({ ...query.queryState, filters: [] });

  const columns = useMemo<ColumnDef<DnaReport>[]>(
    () => [
      {
        accessorKey: 'doctorId',
        header: 'Doctor',
        enableSorting: false,
        enableHiding: false,
        size: 220,
        meta: { label: 'Doctor', variant: 'text' },
        cell: ({ row }) => <NameWithId name={row.original.doctorUsername} id={row.original.doctorId} />,
      },
      {
        id: 'version',
        header: 'Version',
        enableSorting: false,
        enableHiding: false,
        size: 140,
        meta: { label: 'Version' },
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <span className="tabular-nums">v{row.original.currentVersionNumber}</span>
            {row.original.isLatest ? <Badge variant="secondary">Latest</Badge> : null}
          </span>
        ),
      },
      {
        accessorKey: 'resourceStatus',
        header: 'Status',
        enableSorting: false,
        enableHiding: false,
        size: 150,
        meta: { label: 'Status', variant: 'select', options: DISABLED_OPTIONS },
        cell: ({ row }) => <ResourceStatusBadge status={row.original.resourceStatus} />,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        enableSorting: false,
        enableHiding: false,
        size: 160,
        meta: { label: 'Updated' },
        cell: ({ row }) => <span className="text-muted-foreground">{formatRelativeTime(row.original.updatedAt)}</span>,
      },
    ],
    [],
  );

  const empty = hasFilters ? (
    <EmptyState
      icon={IconFilterOff}
      title="No reports match your filters"
      description="Try a different doctor ID or clear the filters."
      action={
        <Button variant="outline" onClick={clearFilters}>
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
    <>
      <ScreenTemplate
        contentMode="fill"
        header={
          <PageHeader
            title="DNA Writing Styles"
            meta={
              <>
                {reports.data ? (
                  <span>
                    {formatNumber(totalCount)} reports
                    {dashboard.data ? ` \u00b7 ${formatNumber(dashboard.data.usersWithStyle)} doctors covered` : ''}
                  </span>
                ) : (
                  <Skeleton className="h-4 w-40" />
                )}
              </>
            }
            actions={
              <Button onClick={() => setGenerateOpen(true)}>
                <IconDna aria-hidden />
                Generate report
              </Button>
            }
          />
        }
        stats={<DashboardCard dashboard={dashboard} reportsTotal={reports.data?.count} activeJobId={activeJobId} progress={progress} />}
        footer={
          <StatusFooter
            start={<span>{reports.isFetching && !reports.isLoading ? 'Refreshing' : 'Up to date'}</span>}
            end={
              <span aria-hidden className="font-mono">
                GET /admin/dna-writing-styles
              </span>
            }
          />
        }
      >
        <VirtualizedDataGrid<DnaReport>
          aria-label="DNA reports"
          columns={columns}
          data={rows}
          getRowId={(row) => row.id}
          manual={{ filtering: true, pagination: true }}
          rowCount={totalCount}
          queryState={query.queryState}
          onQueryStateChange={query.setQueryState}
          persistence={gridPersistence('dna-writing-styles')}
          features={{
            columnReorder: true,
            columnResize: true,
            columnPinning: true,
            columnVisibility: true,
            rowSelection: false,
            globalSearch: false,
            facetedFilters: true,
            sorting: false,
          }}
          onRowClick={(row) => void setSelected(row.doctorId)}
          isLoading={reports.isLoading}
          isBusy={reports.isFetching && !reports.isLoading}
          error={rows.length > 0 ? null : (reports.error ?? null)}
          errorState={(error) => <ErrorState error={error} onRetry={() => void reports.refetch()} />}
          onRetry={() => void reports.refetch()}
          emptyState={empty}
        />
      </ScreenTemplate>

      {/* Keyed by doctor so drawer-local state (edit mode) resets on selection change. */}
      <DoctorDetailDrawer
        key={selected || 'no-doctor'}
        doctorId={selected || null}
        onOpenChange={(open) => {
          if (!open) void setSelected(null);
        }}
        onGenerate={() => setGenerateOpen(true)}
      />

      <GenerateReportDialog
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        initialDoctorId={selected}
        onQueued={(jobId) => {
          setActiveJobId(jobId);
          // Close the detail slide-over so the dashboard progress strip
          // (in the pinned stats region) is visible while the job runs.
          void setSelected(null);
        }}
      />
    </>
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
