'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEventStream, type StreamStatus } from '@/shared/streams';
import {
    approveSummary,
    cancelConsultationJob,
    consultationJobStreamPath,
    generateSummary,
    generateSummaryAsync,
    getConsultationJob,
    getLatestSummary,
    getNamedEntities,
    getSummaryProvenance,
    getTranscriptions,
    harnessAssuranceStreamPath,
    harnessProgressStreamPath,
    listAudioPipelines,
    liveSummaryStreamPath,
    startRecording,
    stopRecording,
} from './client';
import { playgroundConsultationKeys } from './keys';
import type {
    ApproveSummaryRequest,
    ConsultationJobStatus,
    GenerateSummaryRequest,
    HarnessAssuranceSnapshot,
    HarnessProgressSnapshot,
    LiveSummarySnapshot,
} from './types';
import { isTerminalConsultationJob } from './types';

// ─── REST queries + mutations ───

export function useAudioPipelines() {
    return useQuery({ queryKey: playgroundConsultationKeys.pipelines(), queryFn: listAudioPipelines });
}

/** Latest draft for the review pane. null = nothing generated yet (not an error). */
export function useLatestSummary(consultationId: string | null, enabled = true) {
    return useQuery({
        queryKey: playgroundConsultationKeys.latestSummary(consultationId ?? 'none'),
        queryFn: () => getLatestSummary(consultationId as string),
        enabled: enabled && !!consultationId,
    });
}

export function useNamedEntities(consultationId: string | null, scope: 'single' | 'chain' = 'single', enabled = true) {
    return useQuery({
        queryKey: playgroundConsultationKeys.namedEntities(consultationId ?? 'none', scope),
        queryFn: () => getNamedEntities(consultationId as string, scope),
        enabled: enabled && !!consultationId,
    });
}

/**
 * Persisted transcripts for the consultation (TASK-552 Lane C) — the
 * evidence panel's snippet/highlight source. Distinct from the SDK's LIVE,
 * in-browser transcript segments (`audio.transcriptSegments`): this is the
 * decrypted, persisted TRANSCRIPT context item content, fetched once a draft
 * exists for review/sign-off.
 */
export function useTranscriptions(consultationId: string | null, enabled = true) {
    return useQuery({
        queryKey: playgroundConsultationKeys.transcriptions(consultationId ?? 'none'),
        queryFn: () => getTranscriptions(consultationId as string),
        enabled: enabled && !!consultationId,
    });
}

/** Citation + sensor provenance for a generated summary (TASK-552 Lane C evidence panel). */
export function useSummaryProvenance(consultationId: string | null, contextItemId: string | null, enabled = true) {
    return useQuery({
        queryKey: playgroundConsultationKeys.provenance(consultationId ?? 'none', contextItemId ?? 'none'),
        queryFn: () => getSummaryProvenance(consultationId as string, contextItemId as string),
        enabled: enabled && !!consultationId && !!contextItemId,
    });
}

export function useStartRecording() {
    return useMutation({
        mutationFn: ({ consultationId, sessionId }: { consultationId: string; sessionId?: string }) => startRecording(consultationId, sessionId),
    });
}

export function useStopRecording() {
    return useMutation({
        mutationFn: ({ consultationId, persistSnapshot }: { consultationId: string; persistSnapshot?: boolean }) =>
            stopRecording(consultationId, persistSnapshot ?? true),
    });
}

export function useGenerateSummary() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ consultationId, body }: { consultationId: string; body?: GenerateSummaryRequest }) => generateSummary(consultationId, body),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root }),
    });
}

export function useGenerateSummaryAsync() {
    return useMutation({
        mutationFn: ({ consultationId, body }: { consultationId: string; body?: GenerateSummaryRequest }) => generateSummaryAsync(consultationId, body),
    });
}

export function useCancelConsultationJob() {
    return useMutation({ mutationFn: (jobId: string) => cancelConsultationJob(jobId) });
}

export function useApproveSummary() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ consultationId, contextItemId, body }: { consultationId: string; contextItemId: string; body?: ApproveSummaryRequest }) =>
            approveSummary(consultationId, contextItemId, body ?? {}),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root }),
    });
}

// ─── SSE snapshot folds ───
//
// The gateway live streams publish FULL-STATE snapshots (LiveSummaryEventDto /
// HarnessProgressEventDto / HarnessAssuranceEventDto) so clients stay
// stateless: keep only the latest accepted event, close on `closed: true`
// (single-use tickets — never leave a zombie EventSource on a dead channel).

function parseJson<T>(data: string): T | null {
    try {
        return JSON.parse(data) as T;
    } catch {
        return null;
    }
}

export interface SnapshotStreamHandle<T> {
    /** Latest accepted full-state snapshot (null before the first event). */
    snapshot: T | null;
    status: StreamStatus;
    error: string | null;
    close: () => void;
    reopen: () => void;
}

interface UseSnapshotStreamOptions<T> {
    path: string | null;
    scope: string | null;
    enabled: boolean;
    /** Rejects non-snapshot payloads (heartbeats/keepalives) so they can't clobber state. */
    accept: (parsed: T) => boolean;
    /** Named SSE events that also carry snapshots (besides default `message`). */
    eventNames?: readonly string[];
}

function useSnapshotStream<T extends { closed?: boolean }>({ path, scope, enabled, accept, eventNames }: UseSnapshotStreamOptions<T>): SnapshotStreamHandle<T> {
    const [snapshot, setSnapshot] = useState<T | null>(null);

    // Render-time derived-state reset: a new consultation must not inherit
    // the previous stream's folded snapshot.
    const [trackedScope, setTrackedScope] = useState(scope);
    if (scope !== trackedScope) {
        setTrackedScope(scope);
        setSnapshot(null);
    }

    const acceptRef = useRef(accept);
    useEffect(() => {
        acceptRef.current = accept;
    }, [accept]);

    // handleEvent needs stream.close, created before the handle exists —
    // bridge with a ref (close is identity-stable).
    const closeRef = useRef<(() => void) | null>(null);

    const handleEvent = useCallback((_type: string, data: string) => {
        const parsed = parseJson<T>(data);
        if (!parsed || !acceptRef.current(parsed)) return;
        setSnapshot(parsed);
        if (parsed.closed) closeRef.current?.();
    }, []);

    const stream = useEventStream({ path, scope, eventNames, onEvent: handleEvent, enabled });
    useEffect(() => {
        closeRef.current = stream.close;
    }, [stream.close]);

    return { snapshot, status: stream.status, error: stream.error, close: stream.close, reopen: stream.reopen };
}

/** Running SOAP snapshot while recording — scope `consultation_live_summary:<id>`. */
export function useLiveSummaryStream(consultationId: string | null, enabled = true): SnapshotStreamHandle<LiveSummarySnapshot> {
    return useSnapshotStream<LiveSummarySnapshot>({
        path: consultationId ? liveSummaryStreamPath(consultationId) : null,
        scope: consultationId ? `consultation_live_summary:${consultationId}` : null,
        enabled: enabled && !!consultationId,
        accept: (parsed) => Array.isArray(parsed.sections),
    });
}

/** Harness stage checklist — scope `consultation_harness_progress:<id>`. */
export function useHarnessProgressStream(consultationId: string | null, enabled = true): SnapshotStreamHandle<HarnessProgressSnapshot> {
    return useSnapshotStream<HarnessProgressSnapshot>({
        path: consultationId ? harnessProgressStreamPath(consultationId) : null,
        scope: consultationId ? `consultation_harness_progress:${consultationId}` : null,
        enabled: enabled && !!consultationId,
        accept: (parsed) => Array.isArray(parsed.stages),
    });
}

/**
 * Per-claim assurance verdicts — scope `consultation_harness_assurance:<id>`.
 * The terminal aggregate arrives as the NAMED `assurance_complete` event.
 */
export function useHarnessAssuranceStream(consultationId: string | null, enabled = true): SnapshotStreamHandle<HarnessAssuranceSnapshot> {
    return useSnapshotStream<HarnessAssuranceSnapshot>({
        path: consultationId ? harnessAssuranceStreamPath(consultationId) : null,
        scope: consultationId ? `consultation_harness_assurance:${consultationId}` : null,
        enabled: enabled && !!consultationId,
        accept: (parsed) => Array.isArray(parsed.claims),
        eventNames: ['assurance_complete'],
    });
}

// ─── Async summary job progress (the useDnaJobProgress pattern) ───

/** Fallback poll cadence while the SSE stream is down and the job is non-terminal. */
const JOB_POLL_MS = 2_000;

/** A job snapshot plus its client receipt time (comparable across transports). */
interface JobSnapshot {
    job: ConsultationJobStatus | null;
    at: number;
}

const EMPTY_SNAPSHOT: JobSnapshot = { job: null, at: 0 };

/**
 * Latest-wins merge of the SSE and fallback-poll snapshots — EXCEPT a
 * terminal snapshot is never displaced by a non-terminal one (a stale
 * in-flight poll response landing after the terminal SSE message must not
 * regress the UI back to "running").
 */
function mergeSnapshots(sse: JobSnapshot, polled: JobSnapshot | null): ConsultationJobStatus | null {
    if (!sse.job) return polled?.job ?? null;
    if (!polled?.job) return sse.job;
    const sseTerminal = isTerminalConsultationJob(sse.job.status);
    const pollTerminal = isTerminalConsultationJob(polled.job.status);
    if (sseTerminal !== pollTerminal) return sseTerminal ? sse.job : polled.job;
    return polled.at > sse.at ? polled.job : sse.job;
}

export interface UseSummaryJobProgressOptions {
    /** Fired exactly once per job when it reaches COMPLETED/FAILED/CANCELLED. */
    onTerminal?: (job: ConsultationJobStatus) => void;
}

export interface UseSummaryJobProgressResult {
    /** Best-known job status (SSE primary, fallback poll merged in on stream error). */
    job: ConsultationJobStatus | null;
    isTerminal: boolean;
    /** SSE transport state — drives the Connecting/Live/Polling badge. */
    streamStatus: StreamStatus;
}

/**
 * Progress tracker for an async summary job. The ticket-authenticated SSE
 * stream (`@StreamScope consultation_job` on `GET /consultations/jobs/:jobId/
 * stream`) is the PRIMARY transport — unlike the DNA stream it publishes
 * DEFAULT (unnamed) `message` events whose data is a JobStatusResponse JSON
 * with UPPERCASE states. A 2s status poll is the documented error fallback,
 * spun up only after the stream exhausts its retry budget.
 */
export function useSummaryJobProgress(jobId: string | null, { onTerminal }: UseSummaryJobProgressOptions = {}): UseSummaryJobProgressResult {
    const queryClient = useQueryClient();

    const [sse, setSse] = useState<JobSnapshot>(EMPTY_SNAPSHOT);
    // Render-time derived-state reset: a new job must not inherit the
    // previous job's folded events.
    const [trackedJobId, setTrackedJobId] = useState(jobId);
    if (jobId !== trackedJobId) {
        setTrackedJobId(jobId);
        setSse(EMPTY_SNAPSHOT);
    }

    const onTerminalRef = useRef(onTerminal);
    useEffect(() => {
        onTerminalRef.current = onTerminal;
    }, [onTerminal]);

    const closeRef = useRef<(() => void) | null>(null);

    const handleEvent = useCallback((_type: string, data: string) => {
        const status = parseJson<ConsultationJobStatus>(data);
        if (!status?.jobId || !status.status) return;
        setSse({ job: status, at: Date.now() });
        // Terminal messages stop the stream eagerly (single-use tickets, no zombies).
        if (isTerminalConsultationJob(status.status)) closeRef.current?.();
    }, []);

    const stream = useEventStream({
        path: jobId ? consultationJobStreamPath(jobId) : null,
        scope: jobId ? `consultation_job:${jobId}` : null,
        onEvent: handleEvent,
        enabled: !!jobId,
    });
    const { close: closeStream, status: streamStatus } = stream;
    useEffect(() => {
        closeRef.current = closeStream;
    }, [closeStream]);

    const sseTerminal = isTerminalConsultationJob(sse.job?.status);
    const poll = useQuery({
        queryKey: playgroundConsultationKeys.job(jobId ?? 'idle'),
        queryFn: () => getConsultationJob(jobId as string),
        // Error fallback only: the SSE stream is the primary transport.
        enabled: !!jobId && !sseTerminal && streamStatus === 'error',
        // Stop once EITHER transport reported a terminal state.
        refetchInterval: (query) => (sseTerminal || isTerminalConsultationJob(query.state.data?.status) ? false : JOB_POLL_MS),
    });

    const polled: JobSnapshot | null = poll.data ? { job: poll.data, at: poll.dataUpdatedAt } : null;
    const job = jobId ? mergeSnapshots(sse, polled) : null;
    const isTerminal = isTerminalConsultationJob(job?.status);

    // Once-per-job terminal side effects: stop the stream (safety net for the
    // poll-detected end), refresh the latest-summary/NER reads, then hand off
    // to the caller for user feedback.
    const notifiedJobRef = useRef<string | null>(null);
    useEffect(() => {
        if (!jobId || !job || !isTerminalConsultationJob(job.status)) return;
        if (notifiedJobRef.current === jobId) return;
        notifiedJobRef.current = jobId;
        closeStream();
        if (job.status.toUpperCase() === 'COMPLETED') {
            void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root });
        }
        onTerminalRef.current?.(job);
    }, [jobId, job, closeStream, queryClient]);

    return { job, isTerminal, streamStatus: jobId ? streamStatus : 'idle' };
}
