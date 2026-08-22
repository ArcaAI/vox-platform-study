/**
 * Playground consultation client (frames 50 + 50.1, matrix row 34). This is
 * the END-USER consultation plane — gateway-relative paths WITHOUT `admin/`
 * (the admin read grid is row 33); the shared core prepends the BFF proxy
 * mount which owns auth + X-Tenant-Id. The SDK (`@arcaai/vox`) drives session
 * open + audio; these calls cover the recording lifecycle, summaries, jobs
 * and the review plane the SDK demo composes around it.
 */

import { GatewayError, getJson, patchJson, patchWithEtag, postJson } from '@/shared/api';
import type {
  ApproveSummaryRequest,
  AsyncSummaryJob,
  AudioPipeline,
  ConsultationJobStatus,
  GenerateSummaryRequest,
  NamedEntitiesAggregate,
  OpenConsultationRequest,
  PlaygroundConsultation,
  RecordingState,
  SummaryApproval,
  SummaryProvenance,
  SummaryResult,
  TranscriptContextItem,
  UpdateSummaryRequest,
} from './types';

const BASE = 'consultations';

function consultationPath(consultationId: string, suffix: string): string {
  return `${BASE}/${encodeURIComponent(consultationId)}/${suffix}`;
}

/**
 * TASK-793 W2 — picker data for the two scoping inputs the playground never
 * sent (TASK-789 H-4).
 *
 * These two reads are on the ADMIN plane, unlike everything else in this file:
 * no end-user route lists departments or DNA reports. That is sound HERE and
 * only here — the playground routes are role-gated to SUPER_ADMIN /
 * TENANT_ADMIN at the nav layer (`nav-config.ts`), which is the audience that
 * holds `manage:Department` / `manage:DnaWritingStyleReport`. Both callers
 * treat a failure as "no picker", never as a screen error, so a narrower role
 * degrades to the tenant tier instead of breaking the workspace.
 */
export function listScopingDepartments(): Promise<Array<{ id: string; name: string }>> {
  return getJson('admin/departments', { page: 1, limit: 100 });
}

/** DNA writing-style reports usable as `GenerateSummaryRequest.dnaStyleId`. */
export async function listDnaStyleOptions(): Promise<Array<{ id: string; label: string }>> {
  const page = await getJson<{ data?: Array<{ id: string; doctorId?: string; doctorName?: string; status?: string }> }>('admin/dna-writing-styles', {
    page: 1,
    limit: 100,
  });
  return (page.data ?? []).map((report) => ({ id: report.id, label: report.doctorName ?? report.doctorId ?? report.id }));
}

/** Pipeline picker data — AudioPipelinePublicController. */
export function listAudioPipelines(): Promise<AudioPipeline[]> {
  return getJson('audio/pipelines');
}

/** Get-or-create the demo consultation (the SDK's session.open hits the same route). */
export function openConsultation(body: OpenConsultationRequest): Promise<PlaygroundConsultation> {
  return postJson(`${BASE}/open`, body);
}

/**
 * Flips the consultation to RECORDING and starts the live-documentation
 * session. `sessionId` is the SDK's streaming session (read from the
 * transcription pipeline transport) — optional; the service falls back to
 * context-item ingestion when absent.
 */
export function startRecording(consultationId: string, sessionId?: string): Promise<RecordingState> {
  return postJson(consultationPath(consultationId, 'recording/start'), sessionId ? { sessionId } : {});
}

/** Stops the live session; the demo persists the final snapshot as a PRE_SUMMARY. */
export function stopRecording(consultationId: string, persistSnapshot = true): Promise<RecordingState> {
  return postJson(consultationPath(consultationId, 'recording/stop'), { persistSnapshot });
}

export function generateSummary(consultationId: string, body: GenerateSummaryRequest = {}): Promise<SummaryResult> {
  return postJson(consultationPath(consultationId, 'summary'), body);
}

/** Queues the async job (lowercase states); track via jobs/:jobId + its stream. */
export function generateSummaryAsync(consultationId: string, body: GenerateSummaryRequest = {}): Promise<AsyncSummaryJob> {
  return postJson(consultationPath(consultationId, 'summary/async'), body);
}

export function getConsultationJob(jobId: string): Promise<ConsultationJobStatus> {
  return getJson(`${BASE}/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelConsultationJob(jobId: string): Promise<ConsultationJobStatus> {
  return patchJson(`${BASE}/jobs/${encodeURIComponent(jobId)}/cancel`);
}

/** Latest summary draft — null when none exists yet (empty body or 404). */
export async function getLatestSummary(consultationId: string): Promise<SummaryResult | null> {
  try {
    const summary = await getJson<SummaryResult | undefined>(consultationPath(consultationId, 'summary/latest'));
    return summary ?? null;
  } catch (error) {
    if (error instanceof GatewayError && error.isNotFound) return null;
    throw error;
  }
}

/**
 * W1 — the clinician's SOAP edit, under RFC 7232 optimistic concurrency.
 *
 * `If-Match` is MANDATORY on this route (`@RequiresIfMatch()`); omitting it is
 * 428 and version drift is 412. The gateway's ETag for a summary IS
 * `"<version>"` (`ETagInterceptor` renders the row's `_version`), and
 * `SummaryResponse.version` documents echoing that same number back — so the
 * precondition is derived from the version carried by the read, and sent BOTH
 * as the header and as the DTO's required `expectedVersion` body field. The
 * header wins server-side when both are present (house precedence).
 */
export async function updateSummary(
  consultationId: string,
  summaryId: string,
  body: UpdateSummaryRequest,
  expectedVersion: number,
): Promise<SummaryResult> {
  const result = await patchWithEtag<SummaryResult>(
    consultationPath(consultationId, `summary/${encodeURIComponent(summaryId)}`),
    { ...body, expectedVersion },
    `"${expectedVersion}"`,
  );
  return result.data;
}

export function getNamedEntities(consultationId: string, scope?: 'single' | 'chain'): Promise<NamedEntitiesAggregate> {
  return getJson(consultationPath(consultationId, 'named-entities'), { scope });
}

/** Persisted transcripts for the consultation — the evidence panel's snippet/highlight source. */
export function getTranscriptions(consultationId: string): Promise<TranscriptContextItem[]> {
  return getJson(consultationPath(consultationId, 'context/transcriptions'));
}

/** Read-only citation/sensor provenance for a generated summary (evidence panel). */
export function getSummaryProvenance(consultationId: string, contextItemId: string): Promise<SummaryProvenance> {
  return getJson(consultationPath(consultationId, `summary/${encodeURIComponent(contextItemId)}/provenance`));
}

/** Approve & sign-off; `contextItemId` is the summary's `id`. */
export function approveSummary(consultationId: string, contextItemId: string, body: ApproveSummaryRequest = {}): Promise<SummaryApproval> {
  return postJson(consultationPath(consultationId, `summary/${encodeURIComponent(contextItemId)}/approve`), body);
}

// ─── Gateway SSE paths (relative to /api/v1 — useEventStream prepends the
// gateway origin; streams NEVER traverse the BFF proxy). Pair each with the
// matching @StreamScope namespace. ───

/** Scope `consultation_live_summary:<id>`. */
export function liveSummaryStreamPath(consultationId: string): string {
  return consultationPath(consultationId, 'live-summary/stream');
}

/** Scope `consultation_harness_progress:<id>`. */
export function harnessProgressStreamPath(consultationId: string): string {
  return consultationPath(consultationId, 'harness-progress/stream');
}

/** Scope `consultation_harness_assurance:<id>` (terminal named event `assurance_complete`). */
export function harnessAssuranceStreamPath(consultationId: string): string {
  return consultationPath(consultationId, 'harness-assurance/stream');
}

/**
 * Scope `consultation_loop:<id>` — the agentic loop plane's append-only feed
 * (`LoopEventDto`). Carries kind/label/ids only, never PHI.
 */
export function loopStreamPath(consultationId: string): string {
  return consultationPath(consultationId, 'loop/stream');
}

/** Scope `consultation_job:<jobId>` (default `message` events, UPPERCASE states). */
export function consultationJobStreamPath(jobId: string): string {
  return `${BASE}/jobs/${encodeURIComponent(jobId)}/stream`;
}
