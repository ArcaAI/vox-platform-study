/**
 * Playground consultation client (frames 50 + 50.1, matrix row 34). This is
 * the END-USER consultation plane — gateway-relative paths WITHOUT `admin/`
 * (the admin read grid is row 33); the shared core prepends the BFF proxy
 * mount which owns auth + X-Tenant-Id. The SDK (`@arcaai/vox`) drives session
 * open + audio; these calls cover the recording lifecycle, summaries, jobs
 * and the review plane the SDK demo composes around it.
 */

import { GatewayError, getJson, patchJson, patchWithEtag, postJson } from '@/shared/api';
import type { CorrectionProposal } from './live-assist';
import type {
  ApproveSummaryRequest,
  AsyncSummaryJob,
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
 * Picker data for the two scoping inputs, on the CLINICIAN plane.
 *
 * . These two reads used to sit on the ADMIN plane
 * (`admin/departments`, `admin/dna-writing-styles`) on the theory that the
 * playground's audience is SUPER_ADMIN / TENANT_ADMIN. That theory does not
 * survive impersonation, which is the ONLY clinical persona the product
 * defines (OD-2): as `doctor_derm` both routes return 403, and both pickers
 * then rendered blank with no explanation — a silent failure (rule 11 §5).
 *
 * The remedy is NOT a widened admin gate. Both catalogs already had
 * owner-scoped, CLS-derived equivalents on the non-admin plane, so these
 * callers simply use them:
 *
 * - `users/me/departments` (`UserDepartmentsMeController`) — the caller's own
 *   assignments. The user is read from CLS, so there is no id to smuggle and
 *   nothing to widen; the service additionally pins the tenant.
 * - `dna-writing-styles/mine` (`DnaWritingStyleController.getMine`) — reports
 *   owned by the caller, filtered `doctorId = CLS user` + `tenantId = CLS
 *   tenant` inside `DnaWritingStyleService.listReports`.
 *
 * Both callers still treat a failure as "no picker" rather than a screen
 * error, but the UI no longer renders that as an unexplained blank — see the
 * degrade panel in `consultations-column.tsx`.
 */

/** One row of `GET users/me/departments` (`UserDepartmentResponse`). */
interface UserDepartmentAssignment {
  departmentId: string;
  departmentName?: string;
  departmentCode?: string;
}

export async function listScopingDepartments(): Promise<Array<{ id: string; name: string }>> {
  const assignments = await getJson<UserDepartmentAssignment[]>('users/me/departments');
  return assignments.map((assignment) => ({
    // The consultation is opened with the DEPARTMENT id, never the assignment
    // row id — the gateway would not recognise the latter.
    id: assignment.departmentId,
    name: assignment.departmentName ?? assignment.departmentCode ?? assignment.departmentId,
  }));
}

/** One row of `GET dna-writing-styles/mine` (`DnaReportResponse`). */
interface OwnDnaReport {
  id: string;
  isLatest?: boolean;
  currentVersionNumber?: number;
  createdAt?: string;
}

/**
 * Label one of the caller's OWN styles.
 *
 * Every row belongs to the same doctor, so the previous
 * `doctorName ?? doctorId ?? id` label rendered N identical options — useless
 * for choosing between them. Version + latest-marker + creation date is what
 * actually distinguishes one of my styles from another.
 */
function ownDnaStyleLabel(report: OwnDnaReport): string {
  const parts = [`v${report.currentVersionNumber ?? 1}`];
  if (report.isLatest) parts.push('latest');
  if (report.createdAt) {
    const created = new Date(report.createdAt);
    if (!Number.isNaN(created.getTime())) {
      parts.push(created.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
    }
  }
  return parts.join(' \u00b7 ');
}

/** DNA writing-style reports usable as `GenerateSummaryRequest.dnaStyleId`. */
export async function listDnaStyleOptions(): Promise<Array<{ id: string; label: string }>> {
  const reports = await getJson<OwnDnaReport[]>('dna-writing-styles/mine');
  return reports.map((report) => ({ id: report.id, label: ownDnaStyleLabel(report) }));
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

/**
 * the gateway's `AcceptedCorrectionProposal` DTO shape. The console's own
 * `CorrectionProposal` (`./live-assist`) carries more fields (`rationale`, `detectedBy`,
 * `proposedBy` — provenance for the clinician, not needed for promotion), and the global
 * `ValidationPipe` runs `forbidNonWhitelisted` — sending the extra fields 400s the whole
 * request, so `toAcceptedProposalPayload` trims to exactly what the DTO declares.
 */
function toAcceptedProposalPayload(proposal: CorrectionProposal) {
  return {
    proposalId: proposal.proposalId,
    start: proposal.start,
    end: proposal.end,
    original: proposal.original,
    proposed: proposal.proposed,
    category: proposal.category,
    confidence: proposal.confidence,
    status: proposal.status,
  };
}

/**
 * Stops the live session; the demo persists the final snapshot as a PRE_SUMMARY.
 * `acceptedProposals` — — threads the clinician's accepted advisory corrections
 * through to `feedback.capture` so it has something to promote over the raw
 * transcript. Omitted from the body entirely when empty (the common case).
 */
export function stopRecording(consultationId: string, persistSnapshot = true, acceptedProposals: readonly CorrectionProposal[] = []): Promise<RecordingState> {
  return postJson(consultationPath(consultationId, 'recording/stop'), {
    persistSnapshot,
    ...(acceptedProposals.length ? { acceptedProposals: acceptedProposals.map(toAcceptedProposalPayload) } : {}),
  });
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
