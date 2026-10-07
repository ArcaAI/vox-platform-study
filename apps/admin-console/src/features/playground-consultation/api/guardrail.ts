'use client';

/**
 * TASK-1050 W3b — the consultation playground's guardrail plane (README §9.7.3–§9.7.5, §9.8.1, §9.8.3),
 * over the BFF proxy:
 *
 * | Verb | Route |
 * |---|---|
 * | read the notices | `GET consultations/:id/guardrail-notices` |
 * | acknowledge one | `POST consultations/:id/guardrail-notices/:noticeId/ack` (If-Match) |
 * | resume a hold | `POST consultations/:id/guardrail-hold/resume` `{ noticeId, resolution }` (If-Match) |
 * | sign, acknowledging warnings in one action | `POST consultations/:id/approve` `{ acknowledgeGuardrailNotices: true }` (If-Match) |
 * | live notices | the `guardrail.notice` frame on `GET consultations/:id/live-summary/stream` (W2g relay) |
 *
 * WHY NOT the SDK's `useConsultation().resumeHold / approve`: those send the If-Match of the
 * consultation row the SDK STORE last saw. This screen drives start / stop through its own REST
 * calls (`useStartRecording` / `useStopRecording`), so the store's version is stale by then and
 * every resume or approve would 412. Each command here reads the consultation fresh first (the same
 * contract and body as the SDK verbs). The gateway's lifecycle vocabulary header is set by the BFF.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuardrailHoldResolution } from '@arcaai/types';
import { getWithEtag, request, versionFromEtag } from '@/shared/api';
import { useEventStream } from '@/shared/streams';
import type { GuardrailNoticeWithState } from '@/shared/guardrail/guardrail-notice-list';
import { toGuardrailNotice, toGuardrailNotices } from '@/shared/guardrail/notice';
import { liveSummaryStreamPath } from './client';
import { playgroundConsultationKeys } from './keys';

const base = (consultationId: string) => `consultations/${encodeURIComponent(consultationId)}`;

export interface GuardrailNoticesResult {
  notices: GuardrailNoticeWithState[];
  unacknowledgedNoticeIds: string[];
}

export async function listGuardrailNotices(consultationId: string): Promise<GuardrailNoticesResult> {
  const { data } = await getWithEtag<unknown>(`${base(consultationId)}/guardrail-notices`);
  const record = (typeof data === 'object' && data !== null ? data : {}) as { unacknowledgedNoticeIds?: unknown };
  const ids = Array.isArray(record.unacknowledgedNoticeIds)
    ? record.unacknowledgedNoticeIds.filter((id): id is string => typeof id === 'string')
    : [];
  return { notices: toGuardrailNotices<GuardrailNoticeWithState>(data), unacknowledgedNoticeIds: ids };
}

/** The consultation's current version, read fresh (ETag first, body `version` as the fallback). */
async function currentVersion(consultationId: string): Promise<number> {
  const { data, etag } = await getWithEtag<{ version?: number }>(base(consultationId));
  if (etag) return versionFromEtag(etag);
  if (typeof data?.version === 'number') return data.version;
  throw new Error('The consultation version could not be read.');
}

async function command<T>(consultationId: string, suffix: string, body: unknown): Promise<T> {
  const version = await currentVersion(consultationId);
  const result = await request<T>(`${base(consultationId)}/${suffix}`, { method: 'POST', body, etag: `"${version}"` });
  return result.data;
}

export function acknowledgeGuardrailNotice(consultationId: string, noticeId: string): Promise<unknown> {
  return command(consultationId, `guardrail-notices/${encodeURIComponent(noticeId)}/ack`, {});
}

export interface GuardrailHoldResumeResult {
  status?: string;
  processing?: string;
  processingReason?: string | null;
  resolvedNoticeId?: string;
}

export function resumeGuardrailHold(consultationId: string, resolution: GuardrailHoldResolution): Promise<GuardrailHoldResumeResult> {
  return command(consultationId, 'guardrail-hold/resume', { noticeId: resolution.noticeId, resolution: resolution.resolution });
}

export interface ApproveConsultationBody {
  overrideSafetyFlag?: boolean;
  /** The confirm step showed the outstanding warnings; they are acknowledged in the approve transaction. */
  acknowledgeGuardrailNotices?: boolean;
}

export interface ApproveConsultationResult {
  status?: string;
  acknowledgedNotices?: Array<{ noticeId: string }>;
}

/** `POST consultations/:id/approve` — the whole consultation, never blocked by warnings (README §9.8.3). */
export function approveConsultation(consultationId: string, body: ApproveConsultationBody): Promise<ApproveConsultationResult> {
  return command(consultationId, 'approve', {
    ...(body.overrideSafetyFlag ? { overrideSafetyFlag: true } : {}),
    ...(body.acknowledgeGuardrailNotices ? { acknowledgeGuardrailNotices: true } : {}),
  });
}

// ─── hooks ───

export const guardrailNoticesKey = (consultationId: string) => [...playgroundConsultationKeys.root, 'guardrail-notices', consultationId] as const;

/** Background refresh while a consultation is open; live frames and job ends refresh it at once. */
const NOTICE_REFRESH_MS = 15_000;

export function useGuardrailNotices(consultationId: string | null, enabled = true) {
  return useQuery({
    queryKey: guardrailNoticesKey(consultationId ?? 'none'),
    queryFn: () => listGuardrailNotices(consultationId as string),
    enabled: enabled && !!consultationId,
    refetchInterval: enabled && consultationId ? NOTICE_REFRESH_MS : false,
    retry: false,
  });
}

function useInvalidateNotices(consultationId: string | null) {
  const queryClient = useQueryClient();
  return useCallback(() => {
    if (consultationId) void queryClient.invalidateQueries({ queryKey: guardrailNoticesKey(consultationId) });
  }, [consultationId, queryClient]);
}

/** Acknowledge several notices, one ack each (the route takes one id). */
export function useAcknowledgeGuardrailNotices(consultationId: string | null) {
  const invalidate = useInvalidateNotices(consultationId);
  return useMutation({
    mutationFn: async (noticeIds: string[]) => {
      for (const noticeId of noticeIds) await acknowledgeGuardrailNotice(consultationId as string, noticeId);
    },
    onSettled: invalidate,
  });
}

export function useResumeGuardrailHold(consultationId: string | null) {
  const invalidate = useInvalidateNotices(consultationId);
  return useMutation({
    mutationFn: (resolution: GuardrailHoldResolution) => resumeGuardrailHold(consultationId as string, resolution),
    onSettled: invalidate,
  });
}

export function useApproveConsultation(consultationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ApproveConsultationBody) => approveConsultation(consultationId as string, body),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: playgroundConsultationKeys.root }),
  });
}

/** The notice inside one live-summary frame (`{ event: 'guardrail.notice', notice }`), or the frame itself. */
export function noticeOfLiveFrame(raw: string): GuardrailNoticeWithState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as { event?: unknown; notice?: unknown };
  return toGuardrailNotice<GuardrailNoticeWithState>(frame.event === 'guardrail.notice' ? frame.notice : parsed);
}

/**
 * The live lane's notices (W2g relay: a `guardrail.notice` frame on the live-summary channel, already
 * deduplicated server-side per `(consultation, check, item, policyVersion)`). A separate subscriber on
 * the same channel, like the section and pre-summary planes.
 */
export function useLiveGuardrailNotices(consultationId: string | null, enabled: boolean, onNotice: (notice: GuardrailNoticeWithState) => void) {
  const onNoticeRef = useRef(onNotice);
  useEffect(() => {
    onNoticeRef.current = onNotice;
  }, [onNotice]);
  const [seen, setSeen] = useState(0);
  const handleEvent = useCallback((_type: string, data: string) => {
    const notice = noticeOfLiveFrame(data);
    if (!notice) return;
    setSeen((count) => count + 1);
    onNoticeRef.current(notice);
  }, []);
  const stream = useEventStream({
    path: consultationId ? liveSummaryStreamPath(consultationId) : null,
    scope: consultationId ? `consultation_live_summary:${consultationId}` : null,
    eventNames: ['guardrail.notice'],
    onEvent: handleEvent,
    enabled: enabled && !!consultationId,
  });
  return { status: stream.status, seen, close: stream.close };
}
