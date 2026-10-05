/**
 * @arcaai/vox - useConsultation
 *
 * One handle over a consultation's whole lifecycle. It composes {@link useArcaSession},
 * {@link useArcaAudio} and {@link useArcaSummary} and talks to the seven-status lifecycle routes
 * (`start | pause | stop | approve | close | reopen`), so a screen needs no knowledge of which
 * lower-level hook owns which step. Every command carries `X-Hope-Lifecycle: 2`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isNoteReady } from '@arcaai/types';
import type { CaptureState, ConsultationActivityPage, EncounterRecap, StopResult } from '@arcaai/types';
import { useAgenticStore } from '../store';
import { useArcaSession } from './useArcaSession';
import { useArcaAudio } from './useArcaAudio';
import { useArcaSummary } from './useArcaSummary';
import { CONSULTATION_ENDPOINTS, LIFECYCLE_HEADER } from '../core/constants';
import { ifMatchFor, toOccError } from '../utils/occ';
import { generateIdempotencyKey } from '../utils/idempotency';
import { toLifecycleState } from '../types/consultation';
import type { Consultation, ConsultationLifecycleStatus, ConsultationProcessingState } from '../types/consultation';
import type { AudioStartOptions, TranscriptSegment } from '../types/audio';
import type { AsyncJobResponse } from '../types';

// =============================================================================
// Types
// =============================================================================

export interface UseConsultationOptions {
  /** Delay between `stop` re-checks while the final transcript is still pending. Default 1000. */
  stopPollIntervalMs?: number;
  /** Give up waiting for the final transcript after this long. Default 60000. */
  stopTimeoutMs?: number;
  /** Retry attempts (after the first) for attachment / feedback network and 5xx/429 failures. Default 3. */
  maxRetries?: number;
}

export type ConsultationStartOptions = AudioStartOptions;

export interface ConsultationGenerateSummaryOptions {
  /** Regenerate only these sections; the others are preserved. */
  sectionKeys?: string[];
  outputLanguage?: string;
}

export type ConsultationAttachmentInput =
  | { kind: 'case_note'; text: string }
  | { kind: 'document' | 'image' | 'audio'; data: Blob | ArrayBuffer | Uint8Array; mime: string; name?: string; sha256?: string };

export interface SendAttachmentOptions {
  signal?: AbortSignal;
  encounterSeq?: number;
  /** Internal: `'feedback'` stores the media against a feedback entry instead of the note. */
  purpose?: 'attachment' | 'feedback';
  /** Poll interval while the server processes the upload (audio / large objects). Default 1000. */
  pollIntervalMs?: number;
}

export interface ConsultationAttachmentResult {
  attachmentId: string;
  status: 'READY' | 'PROCESSING';
  contextItemId: string | null;
  mediaId: string | null;
}

export type ConsultationFeedbackInput =
  | { kind: 'rating'; target: FeedbackTargetInput; rating: 'up' | 'down' | 'cleared'; reasonCodes?: string[]; comment?: string }
  | { kind: 'comment'; target?: FeedbackTargetInput; comment: string; attachments?: ConsultationAttachmentInput[] }
  | { kind: 'edit'; target: FeedbackTargetInput; correction: { content: string; expectedVersion?: number }; comment?: string };

export interface FeedbackTargetInput {
  kind: string;
  contextItemId: string;
  versionNumber?: number;
  sectionKey?: string;
  documentKey?: string;
  entityRef?: string;
}

export interface UseConsultationReturn {
  consultation: Consultation | null;
  status: ConsultationLifecycleStatus;
  processing: ConsultationProcessingState;
  /** Why `processing` is what it is (e.g. `NOTE_READY` once the note is finished); null when none is reported. */
  processingReason: string | null;
  /** STOPPED with the note finished (IDLE + `NOTE_READY`) or waiting on a human (AWAITING_REVIEW). */
  noteReady: boolean;
  isCapturing: boolean;
  level: number;
  segments: TranscriptSegment[];
  error: Error | null;

  start: (options?: ConsultationStartOptions) => Promise<CaptureState>;
  pause: () => Promise<CaptureState>;
  /** Resolves once the final transcript is complete (or the wait times out). */
  stop: () => Promise<StopResult>;
  generateSummary: (options?: ConsultationGenerateSummaryOptions) => Promise<AsyncJobResponse>;
  sendAttachment: (input: ConsultationAttachmentInput, options?: SendAttachmentOptions) => Promise<ConsultationAttachmentResult>;
  sendFeedback: (input: ConsultationFeedbackInput) => Promise<unknown>;
  approve: (options?: { overrideSafetyFlag?: boolean; clinicianUserId?: string }) => Promise<Consultation>;
  close: () => Promise<Consultation>;
  reopen: (options?: { reason?: string }) => Promise<Consultation>;
  history: (query?: Record<string, string | number | undefined>) => Promise<ConsultationActivityPage>;
  /** The display-only encounter recap (`hope.encounter_recap.v2`). */
  recap: (encounterSeq: number) => Promise<EncounterRecap>;
}

interface LifecycleOverlay {
  consultationId: string;
  status: ConsultationLifecycleStatus;
  processing: ConsultationProcessingState;
  processingReason: string | null;
  version?: number;
}

interface StreamingControl {
  getSessionId(): string | null;
  pauseCapture?(): void;
  resumeCapture?(): void;
}

// =============================================================================
// Helpers
// =============================================================================

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function httpStatusOf(error: unknown): number | undefined {
  const e = error as { status?: number; context?: { status?: number } } | null;
  return e?.status ?? e?.context?.status;
}

/**
 * Seconds to wait from a `Retry-After` value (delta-seconds or an HTTP date); undefined when absent
 * or unreadable. Read off the error's `context.retryAfter` / `retryAfter` / `headers`.
 */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | undefined {
  const e = error as {
    retryAfter?: unknown;
    context?: { retryAfter?: unknown };
    headers?: { get?: (name: string) => string | null };
  } | null;
  const raw = e?.context?.retryAfter ?? e?.retryAfter ?? e?.headers?.get?.('retry-after');
  if (raw === undefined || raw === null) return undefined;
  const text = String(raw).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Retry only what is worth retrying: network failures, 5xx and 429 — never any other 4xx. */
function isRetryable(error: unknown): boolean {
  if ((error as { name?: string } | null)?.name === 'AbortError') return false;
  const status = httpStatusOf(error);
  if (status === undefined) return (error as { code?: string } | null)?.code !== 'VALIDATION_ERROR';
  return status === 429 || status >= 500;
}

async function withRetry<T>(work: () => Promise<T>, maxRetries: number, signal?: AbortSignal): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      if (signal?.aborted || attempt >= maxRetries || !isRetryable(error)) throw error;
      const status = httpStatusOf(error);
      const hinted = status === 429 || status === 503 ? retryAfterMs(error) : undefined;
      const base = Math.min(250 * 2 ** attempt, 4000);
      await sleep(hinted ?? base / 2 + Math.random() * (base / 2));
      attempt += 1;
    }
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function toBytes(data: Blob | ArrayBuffer | Uint8Array): Promise<ArrayBuffer> {
  if (data instanceof Blob) return data.arrayBuffer();
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return data;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * @example
 * ```tsx
 * const c = useConsultation();
 * await c.start();      // capture + POST :id/start
 * await c.pause();
 * await c.stop();       // resolves on the final transcript
 * await c.generateSummary();
 * await c.approve();
 * ```
 */
export function useConsultation(opts: UseConsultationOptions = {}): UseConsultationReturn {
  const { stopPollIntervalMs = 1000, stopTimeoutMs = 60_000, maxRetries = 3 } = opts;
  const store = useAgenticStore();
  const session = useArcaSession();
  const audio = useArcaAudio();
  const summary = useArcaSummary();

  const consultation = session.consultation;
  const consultationId = consultation?.id ?? null;

  // The most recent command response wins over the session row until the row itself changes.
  const [overlay, setOverlay] = useState<LifecycleOverlay | null>(null);
  const overlayRef = useRef<LifecycleOverlay | null>(null);
  overlayRef.current = overlay;
  const [commandError, setCommandError] = useState<Error | null>(null);

  useEffect(() => {
    setOverlay((current) => (current && current.consultationId !== consultationId ? null : current));
  }, [consultationId]);

  const consultationReason = (consultation as { processingReason?: string | null } | null)?.processingReason;
  const consultationProcessing = (consultation as { processing?: string } | null)?.processing as ConsultationProcessingState | undefined;
  const base = useMemo(
    () => toLifecycleState(consultation?.status as string | undefined, consultationProcessing, consultationReason),
    [consultation?.status, consultationProcessing, consultationReason],
  );
  const live = overlay && overlay.consultationId === consultationId ? overlay : null;
  const status = live?.status ?? base.status;
  const processing = live?.processing ?? base.processing;
  const processingReason = (live ? live.processingReason : base.processingReason) ?? null;
  const noteReady = isNoteReady({ status, processing, processingReason });

  const requireContext = useCallback((): { apiClient: NonNullable<typeof store.apiClient>; id: string; version?: number } => {
    const apiClient = store.apiClient;
    if (!apiClient) throw new Error('SDK not initialized');
    if (!consultationId) throw new Error('No consultation open. Call open() first.');
    return { apiClient, id: consultationId, version: overlayRef.current?.version ?? consultation?.version };
  }, [store, consultationId, consultation?.version]);

  const streaming = useCallback((): StreamingControl | null => {
    const pm = store.pluginManager as unknown as {
      getTranscriptionPipeline?: () => { getStreamingSessionManager?: () => StreamingControl | null } | null;
    } | null;
    return pm?.getTranscriptionPipeline?.()?.getStreamingSessionManager?.() ?? null;
  }, [store]);

  const remember = useCallback((id: string, next: { status?: string; processing?: string; processingReason?: string | null; version?: number }) => {
    const state = toLifecycleState(next.status, next.processing as ConsultationProcessingState | undefined, next.processingReason ?? null);
    setOverlay({ consultationId: id, status: state.status, processing: state.processing, processingReason: state.processingReason ?? null, version: next.version });
  }, []);

  /** POST a lifecycle command; failures land in `error` and rethrow. */
  const command = useCallback(
    async <T>(path: (id: string) => string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> => {
      const { apiClient, id } = requireContext();
      try {
        return await apiClient.postWithHeaders<T>(path(id), body, { ...LIFECYCLE_HEADER, ...extraHeaders });
      } catch (error) {
        setCommandError(error as Error);
        throw error;
      }
    },
    [requireContext],
  );

  const start = useCallback(
    async (options?: ConsultationStartOptions): Promise<CaptureState> => {
      const { id } = requireContext();
      setCommandError(null);
      const manager = streaming();
      if (status === 'PAUSED' && audio.isCapturing && manager?.resumeCapture) {
        manager.resumeCapture();
      } else {
        await audio.start(options);
      }
      const sessionId = streaming()?.getSessionId() ?? undefined;
      const state = await command<CaptureState>(CONSULTATION_ENDPOINTS.START, sessionId ? { sessionId } : {});
      remember(id, state);
      return state;
    },
    [requireContext, streaming, status, audio, command, remember],
  );

  const pause = useCallback(async (): Promise<CaptureState> => {
    const { id } = requireContext();
    setCommandError(null);
    streaming()?.pauseCapture?.();
    const state = await command<CaptureState>(CONSULTATION_ENDPOINTS.PAUSE, {});
    remember(id, state);
    return state;
  }, [requireContext, streaming, command, remember]);

  const stop = useCallback(async (): Promise<StopResult> => {
    const { id } = requireContext();
    setCommandError(null);
    await audio.stop();
    const deadline = Date.now() + stopTimeoutMs;
    for (;;) {
      const result = await command<StopResult>(CONSULTATION_ENDPOINTS.STOP, { waitForFinal: true });
      remember(id, result);
      if (result.finalTranscript?.state !== 'pending' || Date.now() >= deadline) return result;
      await sleep(stopPollIntervalMs);
    }
  }, [requireContext, audio, command, remember, stopPollIntervalMs, stopTimeoutMs]);

  const generateSummary = useCallback(
    (options?: ConsultationGenerateSummaryOptions): Promise<AsyncJobResponse> => {
      setCommandError(null);
      const extra: Record<string, unknown> = {};
      if (options?.sectionKeys?.length) extra.sectionKeys = options.sectionKeys;
      if (options?.outputLanguage) extra.outputLanguage = options.outputLanguage;
      return summary.generateSummaryAsync(Object.keys(extra).length > 0 ? { options: extra } : undefined);
    },
    [summary],
  );

  const transition = useCallback(
    async (path: (id: string) => string, body: unknown): Promise<Consultation> => {
      const { id, version } = requireContext();
      setCommandError(null);
      const headers: Record<string, string> = typeof version === 'number' ? { 'If-Match': ifMatchFor(version) } : {};
      try {
        const updated = await command<Consultation & { processing?: string }>(path, body, headers);
        remember(id, updated);
        store.setConsultation?.(updated);
        return updated;
      } catch (error) {
        throw typeof version === 'number' ? toOccError(error, id, version) : error;
      }
    },
    [requireContext, command, remember, store],
  );

  const approve = useCallback(
    (options?: { overrideSafetyFlag?: boolean; clinicianUserId?: string }) => transition(CONSULTATION_ENDPOINTS.APPROVE, options ?? {}),
    [transition],
  );
  const close = useCallback(() => transition(CONSULTATION_ENDPOINTS.CLOSE, {}), [transition]);
  const reopen = useCallback((options?: { reason?: string }) => transition(CONSULTATION_ENDPOINTS.REOPEN, options ?? {}), [transition]);

  const sendAttachment = useCallback(
    async (input: ConsultationAttachmentInput, options: SendAttachmentOptions = {}): Promise<ConsultationAttachmentResult> => {
      const { apiClient, id } = requireContext();
      setCommandError(null);
      if (input.kind === 'case_note') {
        const item = await session.addContext({ type: 'CASE_NOTE', content: input.text } as Parameters<typeof session.addContext>[0]);
        return { attachmentId: item.id, status: 'READY', contextItemId: item.id, mediaId: null };
      }
      const bytes = await toBytes(input.data);
      const sha256 = input.sha256 ?? (await sha256Hex(bytes));
      const key = generateIdempotencyKey();
      const intent = await withRetry(
        () =>
          apiClient.postWithHeaders<{ attachmentId: string; uploadUrl: string | null; uploadHeaders: Record<string, string> }>(
            CONSULTATION_ENDPOINTS.ATTACHMENTS_INTENT(id),
            {
              kind: input.kind,
              mime: input.mime,
              sizeBytes: bytes.byteLength,
              sha256,
              fileName: input.name,
              purpose: options.purpose ?? 'attachment',
              encounterSeq: options.encounterSeq,
            },
            { ...LIFECYCLE_HEADER, 'Idempotency-Key': key },
            { signal: options.signal },
          ),
        maxRetries,
        options.signal,
      );

      type Completed = { status: 'READY' | 'PROCESSING'; contextItemId: string | null; mediaId: string | null };
      let completed: Completed;
      if (intent.uploadUrl) {
        await withRetry(
          async () => {
            // The presigned URL is the credential: no Authorization header, no tenant header.
            const res = await fetch(intent.uploadUrl as string, {
              method: 'PUT',
              headers: intent.uploadHeaders,
              body: bytes,
              signal: options.signal,
            });
            if (!res.ok) throw Object.assign(new Error(`Attachment upload failed (${res.status})`), { status: res.status });
          },
          maxRetries,
          options.signal,
        );
        completed = await withRetry(
          () =>
            apiClient.postWithHeaders<Completed>(
              CONSULTATION_ENDPOINTS.ATTACHMENT_COMPLETE(id, intent.attachmentId),
              {},
              { ...LIFECYCLE_HEADER },
              { signal: options.signal },
            ),
          maxRetries,
          options.signal,
        );
      } else {
        completed = await withRetry(
          () => {
            const form = new FormData();
            form.append('file', new Blob([bytes], { type: input.mime }), input.name ?? 'attachment');
            return apiClient.postFormData<Completed>(CONSULTATION_ENDPOINTS.ATTACHMENT_CONTENT(id, intent.attachmentId), form, {
              signal: options.signal,
            });
          },
          maxRetries,
          options.signal,
        );
      }

      const pollMs = options.pollIntervalMs ?? 1000;
      const deadline = Date.now() + stopTimeoutMs;
      while (completed.status === 'PROCESSING' && Date.now() < deadline && !options.signal?.aborted) {
        await sleep(pollMs);
        completed = await apiClient.get<Completed>(CONSULTATION_ENDPOINTS.ATTACHMENT(id, intent.attachmentId), { signal: options.signal });
      }
      return {
        attachmentId: intent.attachmentId,
        status: completed.status,
        contextItemId: completed.contextItemId ?? null,
        mediaId: completed.mediaId ?? null,
      };
    },
    [requireContext, session, maxRetries, stopTimeoutMs],
  );

  const sendFeedback = useCallback(
    async (input: ConsultationFeedbackInput): Promise<unknown> => {
      const { apiClient, id } = requireContext();
      setCommandError(null);
      const attachmentIds: string[] = [];
      if (input.kind === 'comment' && input.attachments) {
        for (const attachment of input.attachments) {
          const uploaded = await sendAttachment(attachment, { purpose: 'feedback' });
          attachmentIds.push(uploaded.attachmentId);
        }
      }
      const body: Record<string, unknown> = { target: input.kind === 'comment' ? input.target : input.target };
      if (input.kind === 'rating') {
        body.rating = input.rating;
        if (input.reasonCodes) body.reasonCodes = input.reasonCodes;
        if (input.comment) body.comment = input.comment;
      } else if (input.kind === 'comment') {
        body.comment = input.comment;
        if (attachmentIds.length > 0) body.attachmentIds = attachmentIds;
      } else {
        body.correction = input.correction;
        if (input.comment) body.comment = input.comment;
      }
      const key = generateIdempotencyKey();
      return withRetry(
        () => apiClient.postWithHeaders(CONSULTATION_ENDPOINTS.FEEDBACK(id), body, { ...LIFECYCLE_HEADER, 'Idempotency-Key': key }),
        maxRetries,
      );
    },
    [requireContext, sendAttachment, maxRetries],
  );

  const history = useCallback(
    (query?: Record<string, string | number | undefined>) => {
      const { apiClient, id } = requireContext();
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) params.set(k, String(v));
      const qs = params.toString();
      return apiClient.get<ConsultationActivityPage>(`${CONSULTATION_ENDPOINTS.HISTORY(id)}${qs ? `?${qs}` : ''}`);
    },
    [requireContext],
  );

  const recap = useCallback(
    (encounterSeq: number) => {
      const { apiClient, id } = requireContext();
      return apiClient.get<EncounterRecap>(CONSULTATION_ENDPOINTS.RECAP(id, encounterSeq));
    },
    [requireContext],
  );

  return useMemo(
    () => ({
      consultation,
      status,
      processing,
      processingReason,
      noteReady,
      isCapturing: audio.isCapturing,
      level: audio.level,
      segments: audio.transcriptSegments,
      error: commandError ?? session.error ?? audio.error ?? null,
      start,
      pause,
      stop,
      generateSummary,
      sendAttachment,
      sendFeedback,
      approve,
      close,
      reopen,
      history,
      recap,
    }),
    [
      consultation,
      status,
      processing,
      processingReason,
      noteReady,
      audio.isCapturing,
      audio.level,
      audio.transcriptSegments,
      audio.error,
      commandError,
      session.error,
      start,
      pause,
      stop,
      generateSummary,
      sendAttachment,
      sendFeedback,
      approve,
      close,
      reopen,
      history,
      recap,
    ],
  );
}
