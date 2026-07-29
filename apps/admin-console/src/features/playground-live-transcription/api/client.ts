/**
 * Live-transcription client (capabilities-matrix row 35). Everything here is
 * the END-USER plane (`audio/transcription-jobs…`, owner-scoped) — the
 * tenant-wide admin grid is tier 30–49 (row 28) and deliberately not used.
 * REST rides the BFF proxy via the shared core; the WS URL builder targets
 * the gateway origin directly (streams never traverse the BFF).
 */

import { deleteJson, getJson, postJson, request } from '@/shared/api';
import type {
  BatchTranscribeResponse,
  CreateStreamSessionInput,
  PaginatedPlaygroundJobs,
  PlaygroundPipeline,
  PlaygroundTranscriptionJob,
  RefreshTicketResponse,
  StreamSessionResponse,
} from './types';

const JOB_BASE = 'audio/transcription-jobs';

// --- streaming session -----------------------------------------------------

/** 201 → session + one-shot ticket; 429 = tenant concurrency quota (designed panel). */
export function createStreamSession(input: CreateStreamSessionInput): Promise<StreamSessionResponse> {
  return postJson(`${JOB_BASE}/stream/session`, input);
}

/** Mints a fresh single-use ticket for reconnects. */
export function refreshStreamTicket(sessionId: string): Promise<RefreshTicketResponse> {
  return postJson(`${JOB_BASE}/stream/session/${encodeURIComponent(sessionId)}/refresh-ticket`);
}

/** 204; cross-tenant probes 404 via @TenantOwnedResource. */
export function closeStreamSession(sessionId: string): Promise<void> {
  return deleteJson(`${JOB_BASE}/stream/session/${encodeURIComponent(sessionId)}`);
}

/**
 * Direct-gateway WS URL: http→ws / https→wss on the `publicEnv.apiHost`
 * origin, path from the session response, and the sessionId/ticket/tenantId
 * trio — the gateway tenant-claim guard fails closed without `tenantId`.
 */
export function buildStreamWsUrl(apiHost: string, wsPath: string, params: { sessionId: string; ticket: string; tenantId: string }): string {
  const parsed = new URL(apiHost);
  const wsProtocol = parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
  const search = new URLSearchParams({ sessionId: params.sessionId, ticket: params.ticket, tenantId: params.tenantId });
  return `${wsProtocol}//${parsed.host}${wsPath}?${search.toString()}`;
}

// --- batch upload + owner-scoped jobs ---------------------------------------

/**
 * Multipart upload through the BFF (the shared `request` core detects
 * FormData bodies and skips the JSON content-type). ≤100 MB, audio mimes.
 */
export async function uploadBatchAudio(input: { file: File; pipelineId: string; language?: string }): Promise<BatchTranscribeResponse> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('pipelineId', input.pipelineId);
  if (input.language) form.append('language', input.language);
  return (await request<BatchTranscribeResponse>(`${JOB_BASE}/transcribe`, { method: 'POST', body: form })).data;
}

/** Caller's OWN jobs only; custom envelope with 1-based page. */
export function listMyTranscriptionJobs(params?: { page?: number; limit?: number }): Promise<PaginatedPlaygroundJobs> {
  return getJson(JOB_BASE, params);
}

/** Tenant-owned detail (404-over-403 posture on cross-tenant probes). */
export function getTranscriptionJob(id: string): Promise<PlaygroundTranscriptionJob> {
  return getJson(`${JOB_BASE}/${encodeURIComponent(id)}`);
}

/** Creator-scoped in the service — a peer cannot cancel a job they did not create. */
export function cancelTranscriptionJob(id: string): Promise<PlaygroundTranscriptionJob> {
  return postJson(`${JOB_BASE}/${encodeURIComponent(id)}/cancel`);
}

export function retryTranscriptionJob(id: string): Promise<PlaygroundTranscriptionJob> {
  return postJson(`${JOB_BASE}/${encodeURIComponent(id)}/retry`);
}

/** SSE path for useEventStream — relative to /api/v1 (direct gateway connect). */
export function jobStreamPath(id: string): string {
  return `${JOB_BASE}/${encodeURIComponent(id)}/stream`;
}

// --- pipeline picker ---------------------------------------------------------

/** Public tenant-scoped read (AudioPipelinePublicController) — SDK picker plane. */
export function listPlaygroundPipelines(): Promise<PlaygroundPipeline[]> {
  return getJson('audio/pipelines');
}
