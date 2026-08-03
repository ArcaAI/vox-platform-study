'use client';

/**
 * @arcaai/vox/compat - useSMR
 *
 * v1 summary hook reproduced against the TASK-562 gateway shim endpoints
 * (TASK-560 §5.4 / §5.6):
 *   - `summarize`/`summarizeSync` → `POST /api/smr/api/v1/summary/sync`
 *   - `preSummarize`             → `POST /api/smr/api/v1/presummary`
 *   - `summarizeAsync`           → `POST /api/smr/api/v1/summary/async`
 *
 * These shim paths live OUTSIDE the gateway's `/api/v1` prefix (TASK-560 §5.6),
 * so the request origin is derived from the provider's `AgenticClient.getBaseUrl()`
 * (stripping the trailing `/api/v1`). Auth is x-api-key parity (TASK-560 D2):
 * the key is read from the same `AgenticClient` the provider configured — never
 * a hardcoded default (TASK-560 §6 A1).
 *
 * F2 fix (TASK-560 §6): the request sends REAL per-turn `conversation_segments`
 * — from `request.segments` when provided, else split from `request.text` into
 * per-line turns — never one collapsed `speaker:'user'` blob.
 *
 * Streaming (TASK-589): `{ stream: true, onDelta }` on `SMRRequest`/`PreSummaryRequest`
 * opts into SSE — `event: delta` (`data:{text}`) fires `onDelta(delta, accumulated)`,
 * the terminal `event: result` resolves the promise with the same v1-shaped body the
 * non-streaming path returns, and `event: error` rejects with `data.detail`. Omitting
 * `stream` keeps the request byte-identical to the single-JSON-response path.
 */

import { useCallback, useState } from 'react';
import { useAgenticStore, selectApiClient } from '../store/agenticStore';
import type { AgenticClient } from '../core/AgenticClient';
import type { ConversationSegmentInput, ErrorInfo, PreSummaryRequest, PreSummaryResponse, SMRJobStatus, SMRRequest, SummaryResponse } from './types';

export interface UseSMROptions {
  sessionId?: string;
  onComplete?: (summary: SummaryResponse) => void;
  onError?: (error: ErrorInfo) => void;
}

export interface UseSMRReturn {
  summarize: (request: SMRRequest) => Promise<SummaryResponse>;
  summarizeSync: (request: SMRRequest) => Promise<SummaryResponse>;
  summarizeAsync: (request: SMRRequest) => Promise<SMRJobStatus>;
  preSummarize: (request: PreSummaryRequest) => Promise<PreSummaryResponse>;
  loading: boolean;
  error: string | null;
}

/** Strip the trailing `/api/v1` from the REST base to reach the origin. */
function smrOrigin(client: AgenticClient): string {
  return client.getBaseUrl().replace(/\/api\/v1\/?$/, '');
}

/** One parsed SSE frame (`event: <name>` + one or more `data:` lines, joined with `\n`). */
interface ParsedSseFrame {
  event: string;
  data: string;
}

/** Parse a single `\n`-delimited SSE frame (no trailing blank line) into its event name + data payload. */
function parseSseFrame(frame: string): ParsedSseFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim());
    }
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * Build per-turn `conversation_segments` (F2). Prefers the explicit `segments`
 * array; otherwise splits `text` per-line so each turn is its own segment,
 * never a single collapsed entry. Lines shaped `"Speaker: text"` keep the speaker.
 */
function buildConversationSegments(request: SMRRequest): Array<Record<string, unknown>> {
  const language = request.language ?? 'en';
  const now = () => new Date().toISOString();

  const fromInput = (s: ConversationSegmentInput) => ({
    speaker: s.speaker ?? 'user',
    text: s.text,
    timestamp: s.timestamp ?? now(),
    confidence: s.confidence ?? 1.0,
    metadata: { language },
  });

  if (request.segments && request.segments.length > 0) {
    return request.segments.map(fromInput);
  }

  const lines = request.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const turns = lines.length > 0 ? lines : [request.text];

  return turns.map((line) => {
    const match = line.match(/^([^:]{1,40}):\s*(.+)$/);
    return fromInput({
      speaker: match ? match[1].trim() : 'user',
      text: match ? match[2] : line,
    });
  });
}

function buildSyncPayload(request: SMRRequest, fallbackSessionId?: string): Record<string, unknown> {
  const language = request.language ?? 'en';
  const encounterType = request.encounter_type ?? request.encounterType;
  const payload: Record<string, unknown> = {
    session_data: {
      session_id: request.sessionId ?? fallbackSessionId ?? `smr-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      patient_id: request.patientId ?? null,
      provider_id: request.doctorId ?? null,
      session_type: request.visitType ?? null,
      created_at: new Date().toISOString(),
      conversation_segments: buildConversationSegments(request),
      patient_info: request.patientInfo ?? (request.patientName ? { name: request.patientName } : null),
      session_metadata: {
        template: request.template,
        language,
        // canonical key the gateway resolver reads first; department_id kept for the older provider-path interpretation
        department: request.departmentId,
        department_id: request.departmentId,
        visit_type: request.visitType,
        doctor_id: request.doctorId,
        doctor_name: request.doctorName,
        doctor_role: request.doctorRole,
        department_context: request.departmentContext ?? null,
      },
      test_results: request.testResults ?? [],
      previous_visits: request.previousVisits ?? [],
      test_results_text: request.testResultsText ?? null,
      previous_visits_text: request.previousVisitsText ?? null,
      pre_summary_text: request.preSummaryText ?? null,
    },
    use_enhanced_format: request.useEnhancedFormat ?? true,
    department: request.departmentId ?? undefined,
    visit_type: request.visitType ?? undefined,
    include_pre_summary_in_context: request.includePreSummaryInContext ?? false,
  };
  // Optional indicators — forwarded top-level ONLY when provided (backward-compatible).
  if (request.specialty !== undefined) payload.specialty = request.specialty;
  if (encounterType !== undefined) payload.encounter_type = encounterType;
  // Top-level doctor_id lets the gateway apply that doctor's DNA writing-style
  // (kept alongside the legacy session_metadata.doctor_id). Omitted when unset.
  if (request.doctorId !== undefined) payload.doctor_id = request.doctorId;
  // TASK-600: top-level translate_to_english lets the gateway translate the
  // transcript to English before summarizing. Sent ONLY when explicitly true.
  if (request.translateToEnglish === true) payload.translate_to_english = true;
  return payload;
}

export function useSMR(props: UseSMROptions = {}): UseSMRReturn {
  const { sessionId, onComplete, onError } = props;
  const client = useAgenticStore(selectApiClient);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const request = useCallback(
    async <T>(path: string, body: unknown): Promise<T> => {
      if (!client) {
        throw new Error('[@arcaai/vox/compat] useSMR: SDK not initialized. Wrap your app in <ArcaCompatProvider>.');
      }
      const apiKey = client.getApiKey();
      const url = `${smrOrigin(client)}/api/smr/api/v1/${path}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    },
    [client],
  );

  /**
   * SSE variant of `request()` (TASK-589). Sends `stream:true` + `Accept:
   * text/event-stream`, reads the response body as a stream, and parses
   * `\n\n`-delimited SSE frames: `delta` invokes `onDelta`, `result` resolves
   * with the terminal v1-shaped body, `error` throws with `data.detail`.
   */
  const requestStream = useCallback(
    async <T>(
      path: string,
      body: Record<string, unknown>,
      onDelta?: (delta: string, accumulated: string) => void,
      onReasoning?: (reasoning: string, accumulated: string) => void,
    ): Promise<T> => {
      if (!client) {
        throw new Error('[@arcaai/vox/compat] useSMR: SDK not initialized. Wrap your app in <ArcaCompatProvider>.');
      }
      const apiKey = client.getApiKey();
      const url = `${smrOrigin(client)}/api/smr/api/v1/${path}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify({ ...body, stream: true }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`);
      }
      if (!res.body) {
        throw new Error('[@arcaai/vox/compat] useSMR: stream response has no body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';
      let accumulatedReasoning = '';
      let result: T | undefined;
      let resultSeen = false;

      const processFrame = (frame: string) => {
        const parsed = parseSseFrame(frame);
        if (!parsed) return;
        if (parsed.event === 'delta') {
          const { text = '' } = JSON.parse(parsed.data) as { text?: string };
          accumulated += text;
          onDelta?.(text, accumulated);
        } else if (parsed.event === 'reasoning') {
          const { text = '' } = JSON.parse(parsed.data) as { text?: string };
          accumulatedReasoning += text;
          onReasoning?.(text, accumulatedReasoning);
        } else if (parsed.event === 'result') {
          result = JSON.parse(parsed.data) as T;
          resultSeen = true;
        } else if (parsed.event === 'error') {
          const { detail } = JSON.parse(parsed.data) as { detail?: string };
          throw new Error(detail ?? 'stream error');
        }
      };

      const drainFrames = (flushRemainder: boolean) => {
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          processFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
        }
        if (flushRemainder && buffer.trim()) {
          processFrame(buffer);
          buffer = '';
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        if (done) {
          buffer += decoder.decode();
          drainFrames(true);
          break;
        }
        drainFrames(false);
      }

      if (!resultSeen) {
        throw new Error('[@arcaai/vox/compat] useSMR: stream ended without a result event');
      }
      return result as T;
    },
    [client],
  );

  const runSync = useCallback(
    async (smrRequest: SMRRequest): Promise<SummaryResponse> => {
      setLoading(true);
      setError(null);
      try {
        const payload = buildSyncPayload(smrRequest, sessionId);
        const result = smrRequest.stream
          ? await requestStream<SummaryResponse>('summary/sync', payload, smrRequest.onDelta, smrRequest.onReasoning)
          : await request<SummaryResponse>('summary/sync', payload);
        onComplete?.(result);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Summarization failed';
        setError(message);
        onError?.({ code: 'SUMMARIZATION_ERROR', message, severity: 'high', category: 'processing' });
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [request, requestStream, sessionId, onComplete, onError],
  );

  const summarizeAsync = useCallback(
    async (smrRequest: SMRRequest): Promise<SMRJobStatus> => {
      setLoading(true);
      setError(null);
      try {
        return await request<SMRJobStatus>('summary/async', buildSyncPayload(smrRequest, sessionId));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Async summarization failed';
        setError(message);
        onError?.({ code: 'ASYNC_SUMMARIZATION_ERROR', message, severity: 'high', category: 'processing' });
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [request, sessionId, onError],
  );

  const preSummarize = useCallback(
    async (preRequest: PreSummaryRequest): Promise<PreSummaryResponse> => {
      setLoading(true);
      setError(null);
      try {
        const payload: Record<string, unknown> = {
          current_department: (preRequest.current_department ?? '').trim() || 'General',
          visit_type: (preRequest.visit_type ?? '').trim() || 'New Referral',
          age: preRequest.age,
          dob: preRequest.dob,
          gender: preRequest.gender,
          formatted_vitals: preRequest.formatted_vitals,
          formatted_test_results: preRequest.formatted_test_results,
          formatted_previous_visits: preRequest.formatted_previous_visits,
          language: (preRequest.language ?? 'en').trim() || 'en',
          temperature: preRequest.temperature ?? 0.1,
          max_tokens: preRequest.max_tokens ?? 65536,
        };
        // Top-level doctor_id lets the gateway apply that doctor's DNA writing-style. Omitted when unset.
        if (preRequest.doctorId !== undefined) payload.doctor_id = preRequest.doctorId;
        return preRequest.stream
          ? await requestStream<PreSummaryResponse>('presummary', payload, preRequest.onDelta, preRequest.onReasoning)
          : await request<PreSummaryResponse>('presummary', payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Pre-summary failed';
        setError(message);
        onError?.({ code: 'PRESUMMARY_ERROR', message, severity: 'medium', category: 'processing' });
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [request, requestStream, onError],
  );

  return {
    summarize: runSync,
    summarizeSync: runSync,
    summarizeAsync,
    preSummarize,
    loading,
    error,
  };
}
