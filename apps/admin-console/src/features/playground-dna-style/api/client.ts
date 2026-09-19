/**
 * DNA writing-style SELF-plane client (frame 53, capabilities-matrix row 37).
 * All paths are gateway-relative on `dna-writing-styles/*` — NO admin prefix
 * (the tenant-admin grid is the separate `admin/dna-writing-styles` feature).
 * The caller/doctor is derived from CLS on the gateway, so an
 * admin-impersonated doctor session works identically.
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  DnaErasureResult,
  DnaIngestJobResponse,
  DnaIngestJobStatus,
  DnaJob,
  DnaJobStatus,
  DnaReport,
  DnaSettings,
  DnaVersion,
  GenerateDnaStyleRequest,
  IngestDnaWritingSamplesRequest,
  RedactionRuleSet,
  UpdateDnaSettingsRequest,
  UpdateMyReportRequest,
} from './types';

const BASE = 'dna-writing-styles';

/**
 * The caller's latest report, keeping the ETag for the later PATCH.
 * 404 = no style yet — the DESIGNED empty state, not an error.
 */
export function getMyStyle(): Promise<WithEtag<DnaReport>> {
  return getWithEtag(`${BASE}/my-style`);
}

/** Owner-scoped report history backing the report list + set-default picker. */
export function listMyReports(): Promise<DnaReport[]> {
  return getJson(`${BASE}/mine`);
}

/**
 * The caller's decrypted DNA redaction rule set. Always well-formed
 * (`{ rules: [] }` when none) — a 200, never a 404. Rules are WRITTEN through
 * `updateMyReport` (the report PATCH `redactionRules` field), not here.
 */
export function getMyRedactionRules(): Promise<RedactionRuleSet> {
  return getJson(`${BASE}/my-style/redaction-rules`);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export async function updateMyReport(reportId: string, patch: UpdateMyReportRequest, etag: string): Promise<WithEtag<DnaReport>> {
  return patchWithEtag(`${BASE}/${encodeURIComponent(reportId)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/**
 * Promotes one of the caller's reports to the active/default. OCC: `If-Match`
 * is REQUIRED and CASes against the report row, so the caller passes the
 * `version` it read from the report list. Promotion is idempotent, but a stale
 * validator still yields 412 — refetch the list and retry.
 */
export async function setDefaultReport(reportId: string, etag: string): Promise<DnaReport> {
  return (await patchWithEtag<DnaReport>(`${BASE}/${encodeURIComponent(reportId)}/default`, {}, etag)).data;
}

/**
 * Erases the caller's ENTIRE learned DNA profile (every owned report + every
 * version). Idempotent — no profile yields zero counts, not a 404. This is
 * the OTHER half of opting out: the settings toggle only stops FUTURE
 * learning, so an un-erased profile keeps being injected into summary
 * prompts. It deliberately does NOT flip the toggle.
 */
export function eraseMyStyle(): Promise<DnaErasureResult> {
  return deleteJson<DnaErasureResult>(`${BASE}/my-style`);
}

/**
 * Erases ONE owned report and its versions — dropping a single bad snapshot
 * rather than the whole profile. 404 for a report in another tenant
 * (404-over-403: "not yours"), 403 for another doctor's report in this one.
 */
export function eraseMyReport(reportId: string): Promise<DnaErasureResult> {
  return deleteJson<DnaErasureResult>(`${BASE}/${encodeURIComponent(reportId)}`);
}

export function listMyVersions(reportId: string): Promise<DnaVersion[]> {
  return getJson(`${BASE}/${encodeURIComponent(reportId)}/versions`);
}

/**
 * Queues a generation job for the CALLER (owner comes from CLS — no doctor id
 * in the path). 403 = `assertActingAsDoctor`: an admin who is neither a
 * clinical user nor impersonating one — a designed gate state.
 */
export function generateMyStyle(body: GenerateDnaStyleRequest = {}): Promise<DnaJob> {
  return postJson(`${BASE}/generate`, body);
}

export function getDnaSettings(): Promise<DnaSettings> {
  return getJson(`${BASE}/settings`);
}

/**
 * Writes the per-doctor DNA toggle. OCC is ENFORCED on this route: pass the
 * GET's `version` as `currentVersion` and the call always carries `If-Match`
 * (header overrides the body `expectedVersion` server-side; drift = 412).
 *
 * `GET settings` answers `version: 0` while no DOCTOR-scope row exists, and
 * `"0"` is the gateway's create-intent validator — so the FIRST write echoes
 * `If-Match: "0"` rather than omitting the header, and a `"0"` sent against a
 * row that has since been created correctly fails with 412. The body field is
 * only sent once a row exists, because its validator rejects 0.
 * Also 403-gated by `assertActingAsDoctor`.
 */
export async function updateDnaSettings(body: UpdateDnaSettingsRequest, currentVersion = 0): Promise<DnaSettings> {
  const response = await request<DnaSettings>(`${BASE}/settings`, {
    method: 'PUT',
    body: currentVersion >= 1 ? { ...body, expectedVersion: currentVersion } : body,
    etag: `"${currentVersion}"`,
  });
  return response.data;
}

export function getDnaJobStatus(jobId: string): Promise<DnaJobStatus> {
  return getJson(`${BASE}/jobs/${encodeURIComponent(jobId)}`);
}

/** Gateway-relative SSE path for a job — pair with scope `dna_job:<jobId>`. */
export function dnaJobStreamPath(jobId: string): string {
  return `${BASE}/jobs/${encodeURIComponent(jobId)}/stream`;
}

/**
 * TASK-974 §4.1 (F-6) — submits a time-ordered batch of writing samples for analysis. 202:
 * the job is queued, not run. The caller (self) is derived from CLS unless `clinicianUserId`
 * names another clinician of the tenant (SUPER_ADMIN/TENANT_ADMIN only, gateway-enforced).
 */
export function ingestDnaWritingSamples(body: IngestDnaWritingSamplesRequest): Promise<DnaIngestJobResponse> {
  return postJson(`${BASE}/ingest`, body);
}

/**
 * No SSE on this route (unlike `getDnaJobStatus` above) — polling is the only track mechanism,
 * per the `useDnaWritingStyle` SDK hook this mirrors (README §4.1).
 */
export function getDnaIngestJobStatus(jobId: string): Promise<DnaIngestJobStatus> {
  return getJson(`${BASE}/ingest/jobs/${encodeURIComponent(jobId)}`);
}
