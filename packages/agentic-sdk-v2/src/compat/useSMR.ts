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
  return {
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

  const runSync = useCallback(
    async (smrRequest: SMRRequest): Promise<SummaryResponse> => {
      setLoading(true);
      setError(null);
      try {
        const result = await request<SummaryResponse>('summary/sync', buildSyncPayload(smrRequest, sessionId));
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
    [request, sessionId, onComplete, onError],
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
        const payload = {
          current_department: (preRequest.current_department ?? '').trim() || 'General',
          visit_type: (preRequest.visit_type ?? '').trim() || 'New Referral',
          age: preRequest.age,
          dob: preRequest.dob,
          gender: preRequest.gender,
          formatted_vitals: preRequest.formatted_vitals,
          formatted_test_results: preRequest.formatted_test_results,
          formatted_previous_visits: preRequest.formatted_previous_visits,
          language: (preRequest.language ?? 'en').trim() || 'en',
          temperature: preRequest.temperature ?? 0.2,
          max_tokens: preRequest.max_tokens ?? 800,
        };
        return await request<PreSummaryResponse>('presummary', payload);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Pre-summary failed';
        setError(message);
        onError?.({ code: 'PRESUMMARY_ERROR', message, severity: 'medium', category: 'processing' });
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [request, onError],
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
