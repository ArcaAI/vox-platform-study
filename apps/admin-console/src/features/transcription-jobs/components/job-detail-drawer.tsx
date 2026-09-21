'use client';

import type { ReactNode } from 'react';
import type { AsrSpecCore, ResolvedAsrSpec } from '@arcaai/types';
import { Badge } from '@arcaai/ui/components/shadcn/badge';
import { Skeleton } from '@arcaai/ui/components/shadcn/skeleton';
import { CopyButton } from '@/shared/copy-button';
import { cx } from '@/shared/cx';
import { DetailDrawer } from '@/shared/detail/detail-drawer';
import { formatDateTime, formatNumber } from '@/shared/format';
import { ErrorState } from '@/shared/state/error-state';
import { useTranscriptionJob } from '../api';
import type { ServedBy, TranscriptionJob, TranscriptionJobType } from '../api';
import { TranscriptionJobStatusBadge } from './job-status-badge';

const EM_DASH = '—';

/** Single source of the Batch/Realtime wording — shared by the grid's Kind column and this drawer. */
export const JOB_TYPE_LABELS: Record<TranscriptionJobType, string> = {
  BATCH: 'Batch',
  STREAMING: 'Realtime',
};

/** Kind is never colour-only — the label always rides with the badge. */
export function JobKindBadge({ jobType }: { jobType: TranscriptionJobType }) {
  return <Badge variant={jobType === 'STREAMING' ? 'secondary' : 'outline'}>{JOB_TYPE_LABELS[jobType]}</Badge>;
}

/**
 * `resolvedSpec` is an opaque JSONB snapshot on the wire (`TranscriptionJob.resolvedSpec: unknown`).
 * Best-effort read against the shared `ResolvedAsrSpec` shape (`@arcaai/types`) — a job that
 * predates TASK-861, or one with no snapshot at all, renders the "not recorded" copy below
 * instead of throwing.
 */
function asResolvedAsrSpec(value: unknown): ResolvedAsrSpec | null {
  if (!value || typeof value !== 'object') return null;
  return value as ResolvedAsrSpec;
}

/** "provider · model", or whichever half is known; the em-dash when neither is. */
function engineLabel(provider: string | null | undefined, modelSlug: string | null | undefined): string {
  if (provider && modelSlug) return `${provider} · ${modelSlug}`;
  return provider ?? modelSlug ?? EM_DASH;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{children}</h3>;
}

/** A running job has `durationMs: null` (or absent, on an older row) — that means "not measured yet", never 0. */
function DurationValue({ durationMs }: { durationMs: number | null | undefined }) {
  return <>{durationMs === null || durationMs === undefined ? EM_DASH : `${formatNumber(durationMs)} ms`}</>;
}

/** `null`/absent = never measured (em-dash); `0` is a real empty transcript and must render as 0. */
function CountValue({ value }: { value: number | null | undefined }) {
  return <>{formatNumber(value)}</>;
}

function TimingSection({ job }: { job: TranscriptionJob }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground text-xs">Started</dt>
      <dd className="text-xs">{job.startedAt ? formatDateTime(job.startedAt) : EM_DASH}</dd>
      <dt className="text-muted-foreground text-xs">Completed</dt>
      <dd className="text-xs">{job.completedAt ? formatDateTime(job.completedAt) : EM_DASH}</dd>
      <dt className="text-muted-foreground text-xs">Duration</dt>
      <dd className="text-xs tabular-nums">
        <DurationValue durationMs={job.durationMs} />
      </dd>
    </dl>
  );
}

/** Agent/model/provider — `servedBy` (what actually ran) wins; `resolvedSpec` (what was resolved) is the fallback. */
function WhoRanItSection({ job, spec }: { job: TranscriptionJob; spec: ResolvedAsrSpec | null }) {
  const agentSlug = job.servedBy?.agentSlug ?? spec?.agent.slug ?? null;
  const modelSlug = job.servedBy?.modelSlug ?? spec?.models.asr.slug ?? null;
  const provider = job.servedBy?.provider ?? spec?.models.asr.provider ?? null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground text-xs">Agent</dt>
      <dd className="truncate font-mono text-xs">{agentSlug ?? EM_DASH}</dd>
      <dt className="text-muted-foreground text-xs">Model</dt>
      <dd className="truncate font-mono text-xs">{modelSlug ?? EM_DASH}</dd>
      <dt className="text-muted-foreground text-xs">Provider</dt>
      <dd className="truncate font-mono text-xs">{provider ?? EM_DASH}</dd>
    </dl>
  );
}

/**
 * Renders the engines this job could have run on, in order, and marks the one
 * that actually served.
 *
 * `ResolvedAsrSpec` extends `AsrSpecCore`: the PRIMARY *is* the spec and is NOT
 * an element of `fallback.chain`, so it has no index there. That is why
 * `servedBy.chainIndex` is `-1` for a primary-served job as well as for an
 * unidentifiable one — branch on `source` FIRST, `chainIndex` second:
 *  - `source: 'primary'`                  — the primary served (the common case).
 *  - `source: 'fallback'`, index >= 0     — `fallback.chain[index]` served.
 *  - `source: 'fallback'`, index === -1   — a fallback served but could not be
 *                                           identified; mark nothing and say so.
 *  - `servedBy` null/absent               — never guess; mark nothing.
 */
function FallbackChainSection({ servedBy, spec }: { servedBy: ServedBy | null | undefined; spec: ResolvedAsrSpec | null }) {
  if (spec === null) {
    return <p className="text-muted-foreground text-xs">No resolved ASR spec recorded.</p>;
  }
  const chain = spec.fallback?.chain ?? [];
  const served = servedBy ?? null;
  // Only a FALLBACK with no index is unidentifiable. A primary carries -1 by construction.
  const unmatched = served !== null && served.source === 'fallback' && served.chainIndex === -1;
  const entries: { core: AsrSpecCore; isPrimary: boolean; served: boolean }[] = [
    { core: spec, isPrimary: true, served: served !== null && served.source === 'primary' },
    ...chain.map((core: AsrSpecCore, index: number) => ({
      core,
      isPrimary: false,
      served: served !== null && served.source === 'fallback' && served.chainIndex === index,
    })),
  ];
  return (
    <div className="flex flex-col gap-2">
      {served === null ? (
        <p className="text-muted-foreground text-xs">Served entry not recorded &mdash; showing the resolved chain only.</p>
      ) : null}
      {unmatched ? (
        <p className="text-muted-foreground text-xs">
          A fallback engine served, but it could not be matched to a chain entry &mdash; no entry below is marked as served.
        </p>
      ) : null}
      {chain.length === 0 ? <p className="text-muted-foreground text-xs">No fallback configured &mdash; primary only.</p> : null}
      <ol className="flex flex-col gap-1">
        {entries.map((entry, index) => (
          <li
            key={index}
            className={cx(
              'flex items-center gap-2 rounded-md border px-2 py-1 font-mono text-xs',
              entry.served && 'border-primary bg-primary/5',
            )}
          >
            <span className="text-muted-foreground">{index + 1}.</span>
            <span className="min-w-0 flex-1 truncate">{engineLabel(entry.core.models.asr.provider, entry.core.models.asr.slug)}</span>
            {entry.isPrimary ? (
              <Badge variant="outline" className="shrink-0">
                Primary
              </Badge>
            ) : null}
            {entry.served ? (
              <Badge variant="default" className="shrink-0">
                Served
              </Badge>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function OutputSizeSection({ job }: { job: TranscriptionJob }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground text-xs">Words</dt>
      <dd className="text-xs tabular-nums">
        <CountValue value={job.resultWordCount} />
      </dd>
      <dt className="text-muted-foreground text-xs">Characters</dt>
      <dd className="text-xs tabular-nums">
        <CountValue value={job.resultCharCount} />
      </dd>
    </dl>
  );
}

function IdentitySection({ job }: { job: TranscriptionJob }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground text-xs">Job id</dt>
      <dd className="flex items-center gap-1">
        <span className="truncate font-mono text-xs" title={job.id}>
          {job.id}
        </span>
        <CopyButton value={job.id} label="Copy job id" />
      </dd>
      <dt className="text-muted-foreground text-xs">Type</dt>
      <dd className="font-mono text-xs">{job.jobType}</dd>
      {job.jobType === 'STREAMING' ? (
        <>
          <dt className="text-muted-foreground text-xs">Stream session</dt>
          <dd className="flex items-center gap-1">
            <span className="truncate font-mono text-xs" title={job.streamSessionId ?? undefined}>
              {job.streamSessionId ?? EM_DASH}
            </span>
            {job.streamSessionId ? <CopyButton value={job.streamSessionId} label="Copy stream session id" /> : null}
          </dd>
        </>
      ) : null}
      {job.consultationId ? (
        <>
          <dt className="text-muted-foreground text-xs">Consultation</dt>
          <dd className="flex items-center gap-1">
            <span className="truncate font-mono text-xs" title={job.consultationId}>
              {job.consultationId}
            </span>
            <CopyButton value={job.consultationId} label="Copy consultation id" />
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground text-xs">Status</dt>
      <dd>
        <TranscriptionJobStatusBadge status={job.status} />
      </dd>
    </dl>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/**
 * TASK-999 lane F — the transcription-jobs detail surface. Mounted ALONGSIDE
 * the existing `JobStreamCard` (the live SSE panel embedded next to the grid,
 * owned by lane D) rather than replacing it: this drawer answers "what ran and
 * how big was the output", the stream card answers "what is it doing right
 * now". Fetches the job independently via `useTranscriptionJob` (shares the
 * `transcriptionJobKeys.detail` cache entry with the stream panel, so opening
 * both costs at most one request) so it always renders the CURRENT wire shape
 * rather than the row snapshot the grid loaded it from.
 */
export function TranscriptionJobDetailDrawer({
  jobId,
  open,
  onOpenChange,
}: {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const jobQuery = useTranscriptionJob(jobId);
  const job = jobQuery.data ?? null;
  const spec = job ? asResolvedAsrSpec(job.resolvedSpec) : null;

  let body: ReactNode;
  if (jobQuery.isPending) {
    body = <DetailSkeleton />;
  } else if (jobQuery.isError) {
    body = <ErrorState error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />;
  } else if (job) {
    body = (
      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Timing</SectionHeading>
          <TimingSection job={job} />
        </section>
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Who ran it</SectionHeading>
          <WhoRanItSection job={job} spec={spec} />
        </section>
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Fallback chain</SectionHeading>
          <FallbackChainSection servedBy={job.servedBy} spec={spec} />
        </section>
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Output size</SectionHeading>
          <OutputSizeSection job={job} />
        </section>
        <section className="flex flex-col gap-1.5">
          <SectionHeading>Identity</SectionHeading>
          <IdentitySection job={job} />
        </section>
      </div>
    );
  } else {
    body = null;
  }

  return (
    <DetailDrawer
      open={open}
      onOpenChange={onOpenChange}
      title={<span className="min-w-0 truncate font-mono text-sm">{job?.id ?? jobId ?? 'Job'}</span>}
      badges={
        job ? (
          <>
            <JobKindBadge jobType={job.jobType} />
            <TranscriptionJobStatusBadge status={job.status} />
          </>
        ) : null
      }
    >
      {body}
    </DetailDrawer>
  );
}
