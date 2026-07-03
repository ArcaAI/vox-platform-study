/**
 * TASK-407 — Audio Processing (design §5.8 `41 · Audio Processing`, spec-only):
 * pipeline card (default AsrPipeline) + tenant-wide transcription-job stats and
 * table with status filter + read-only job detail sheet. Cascade toggles and
 * per-model runtime metrics stay TARGET (not built here — flagged in the doc).
 */

import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Card } from '@arcaai/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@arcaai/ui/empty';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@arcaai/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@arcaai/ui/sheet';
import { Skeleton } from '@arcaai/ui/skeleton';
import { StatusBadge } from '@arcaai/ui/components/shared';
import { useAdminTranscriptionJobs, usePipelines, type AdminTranscriptionJob, type Pipeline } from '@arcaai/vox';
import { createFileRoute } from '@tanstack/react-router';
import { AudioLines, ChevronLeft, ChevronRight, TriangleAlert, Waves } from 'lucide-react';
import { useEffect, useState } from 'react';
import { jobDuration, jobStatusRole, summarizeJobStats, type JobStatsSummary } from '@/features/audio-processing/job-format';
import { isSuperAdmin } from '@/features/tenants/permissions';
import { ActingOnBanner } from '@/features/tenants/tenant-context';
import { formatDateTime } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export const Route = createFileRoute('/_authenticated/tenants/$tenantId/audio-processing')({
  component: AudioProcessingPage,
});

const PAGE_SIZE = 20;
const STATUS_FILTERS = ['ALL', 'QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD'] as const;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function AudioProcessingPage() {
  const { tenantId } = Route.useParams();
  const tenant = useTenantDetailStore((s) => s.tenant);
  const roles = useAuthStore((s) => s.user?.roles);
  const superAdmin = isSuperAdmin(roles);

  const { list, stats: fetchStats, byStatus, error } = useAdminTranscriptionJobs();
  const { list: listPipelines } = usePipelines();

  const [stats, setStats] = useState<JobStatsSummary | null>(null);
  const [jobs, setJobs] = useState<AdminTranscriptionJob[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('ALL');
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [selected, setSelected] = useState<AdminTranscriptionJob | null>(null);

  // Stats + default pipeline load once per tenant; failures leave the tiles em-dash.
  useEffect(() => {
    void fetchStats()
      .then((s) => setStats(summarizeJobStats(s)))
      .catch(() => setStats(null));
    void listPipelines()
      .then((ps) => setPipeline(ps.find((p) => p.isDefault) ?? ps[0] ?? null))
      .catch(() => setPipeline(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  useEffect(() => {
    setJobs(null);
    if (status === 'ALL') {
      void list({ page, limit: PAGE_SIZE })
        .then((r) => {
          setJobs(r.data);
          setTotal(r.total ?? r.data.length);
        })
        .catch(() => setJobs([]));
    } else {
      // The by-status endpoint is unpaginated (uppercase enum param) —
      // fine for a filtered drill-down.
      void byStatus(status)
        .then((r) => {
          setJobs(r);
          setTotal(r.length);
        })
        .catch(() => setJobs([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, page, status]);

  const totalPages = status === 'ALL' ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;

  const tiles = [
    { label: 'Queued', value: stats?.queued },
    { label: 'Processing', value: stats?.processing },
    { label: 'Completed', value: stats?.completed },
    { label: 'Failed / dead', value: stats?.failed },
  ];

  return (
    <div className="space-y-5">
      {/* Pipeline card — default AsrPipeline for this tenant (read-only). */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Pipeline</h2>
          <Waves className="size-4 shrink-0 text-muted-foreground" />
        </div>
        {pipeline ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="font-medium">{pipeline.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{pipeline.slug}</span>
            {pipeline.isDefault ? <Badge variant="secondary">Default</Badge> : null}
            {str(pipeline.resourceStatus) ? (
              <StatusBadge
                label={String(pipeline.resourceStatus).toLowerCase() === 'enabled' ? 'Active' : String(pipeline.resourceStatus)}
                colorRole={String(pipeline.resourceStatus).toLowerCase() === 'enabled' ? 'success' : 'neutral'}
              />
            ) : null}
            {pipeline.description ? <p className="w-full text-sm text-muted-foreground">{pipeline.description}</p> : null}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No ASR pipeline visible for this tenant.</p>
        )}
      </Card>

      {/* Tenant-wide job stats (status → count). */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value ?? '—'}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">Transcription jobs</h2>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v as (typeof STATUS_FILTERS)[number]);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-9 w-40" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === 'ALL' ? 'All statuses' : s.charAt(0) + s.slice(1).toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {error && jobs?.length === 0 ? (
          <div role="alert" className="flex flex-col items-center gap-2 p-10 text-center">
            <TriangleAlert className="size-8 text-destructive" />
            <p className="font-medium">Couldn’t load jobs</p>
            <p className="text-sm text-muted-foreground">{error.message}</p>
          </div>
        ) : jobs == null ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : jobs.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AudioLines />
              </EmptyMedia>
              <EmptyTitle>No transcription jobs</EmptyTitle>
              <EmptyDescription>
                {status === 'ALL' ? 'No audio has been processed for this tenant yet.' : `No ${status.toLowerCase()} jobs.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground/70">
                <th className="px-5 py-2.5 font-medium">Job</th>
                <th className="hidden px-5 py-2.5 font-medium sm:table-cell">Type</th>
                <th className="px-5 py-2.5 font-medium">Status</th>
                <th className="hidden px-5 py-2.5 font-medium md:table-cell">Progress</th>
                <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Attempts</th>
                <th className="hidden px-5 py-2.5 font-medium lg:table-cell">Queued at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((j) => {
                const progress = num(j.progress);
                const retry = num(j.retryCount);
                const maxRetries = num(j.maxRetries);
                return (
                  <tr
                    key={j.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setSelected(j)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(j)}
                    aria-label={`Job ${j.id}`}
                  >
                    <td className="max-w-0 px-5 py-2.5">
                      <span className="block truncate font-mono text-xs">{j.id}</span>
                    </td>
                    <td className="hidden px-5 py-2.5 sm:table-cell">
                      {str(j.jobType) ? <Badge variant="outline">{String(j.jobType)}</Badge> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-5 py-2.5">
                      <StatusBadge label={String(j.status ?? '—')} colorRole={jobStatusRole(j.status)} />
                    </td>
                    <td className="hidden px-5 py-2.5 tabular-nums text-muted-foreground md:table-cell">{progress != null ? `${progress}%` : '—'}</td>
                    <td className="hidden px-5 py-2.5 tabular-nums text-muted-foreground lg:table-cell">
                      {retry != null && maxRetries != null ? `${retry}/${maxRetries}` : '—'}
                    </td>
                    <td className="hidden whitespace-nowrap px-5 py-2.5 text-muted-foreground lg:table-cell">{formatDateTime(str(j.queuedAt))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
          <p className="text-xs text-muted-foreground">
            {total} job{total === 1 ? '' : 's'} · read-only supervision, no retry/cancel actions.
          </p>
          {status === 'ALL' && totalPages > 1 ? (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page">
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                {page} / {totalPages}
              </span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page">
                <ChevronRight className="size-4" />
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      {superAdmin && tenant ? (
        <ActingOnBanner
          tenantName={tenant.name}
          description="Tenant-wide transcription-job supervision (admin read). Capture/cascade configuration lives on the Configuration tab; per-model runtime metrics remain a target surface."
        />
      ) : null}

      <JobDetailSheet job={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function JobDetailSheet({ job, onClose }: { job: AdminTranscriptionJob | null; onClose: () => void }) {
  const rows: Array<[string, string | null]> = job
    ? [
        ['Type', str(job.jobType)],
        ['Pipeline', str(job.pipelineId)],
        ['Consultation', str(job.consultationId)],
        ['Media', str(job.mediaId)],
        ['Worker', str(job.workerId)],
        ['Created by', str(job.createdBy)],
        ['Queued', formatDateTime(str(job.queuedAt))],
        ['Started', formatDateTime(str(job.startedAt))],
        ['Completed', formatDateTime(str(job.completedAt))],
        ['Duration', jobDuration(str(job.startedAt), str(job.completedAt))],
      ]
    : [];
  const progress = job ? num(job.progress) : null;
  const retry = job ? num(job.retryCount) : null;
  const maxRetries = job ? num(job.maxRetries) : null;
  const errorMessage = job ? str(job.errorMessage) : null;
  const errorCode = job ? str(job.errorCode) : null;

  return (
    <Sheet open={job != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {job ? (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono text-sm">{job.id}</SheetTitle>
              <SheetDescription className="flex items-center gap-2">
                <StatusBadge label={String(job.status ?? '—')} colorRole={jobStatusRole(job.status)} />
                {progress != null ? <span className="tabular-nums">{progress}%</span> : null}
                {retry != null && maxRetries != null ? (
                  <span className="tabular-nums text-muted-foreground">
                    attempt {retry}/{maxRetries}
                  </span>
                ) : null}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6">
              <dl className="space-y-2 text-sm">
                {rows.map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-4">
                    <dt className="shrink-0 text-muted-foreground">{label}</dt>
                    <dd className="truncate text-right font-mono text-xs">{value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
              {errorMessage || errorCode ? (
                <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <p className="font-medium text-destructive">{errorCode ?? 'Error'}</p>
                  {errorMessage ? <p className="mt-1 wrap-break-word text-muted-foreground">{errorMessage}</p> : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
