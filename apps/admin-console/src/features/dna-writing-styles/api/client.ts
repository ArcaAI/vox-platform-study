/**
 * DNA writing-style administration client (frame 33, capabilities-matrix row
 * 26). All paths are gateway-relative; the shared core prepends the BFF proxy
 * mount. List pagination is ONE-based on this controller (see types.ts).
 */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { Paginated, WithEtag } from '@/shared/api';
import type {
  DnaDashboard,
  DnaErasureResult,
  DnaJob,
  DnaJobStatus,
  DnaReport,
  DnaVersion,
  GenerateDnaReportRequest,
  ListDnaReportsParams,
  UpdateDnaReportRequest,
} from './types';

const BASE = 'admin/dna-writing-styles';

export function listDnaReports(params?: ListDnaReportsParams): Promise<Paginated<DnaReport>> {
  return getJson(BASE, params);
}

export function getDnaDashboard(): Promise<DnaDashboard> {
  return getJson(`${BASE}/dashboard`);
}

/**
 * Latest report for a doctor, keeping the ETag for the later PATCH. PHI-gated:
 * doctor reads stay tenant-pinned even for super admins (404 across tenants).
 */
export function getDoctorReport(doctorId: string): Promise<WithEtag<DnaReport>> {
  return getWithEtag(`${BASE}/doctor/${encodeURIComponent(doctorId)}`);
}

/** OCC PATCH: If-Match header + body expectedVersion derived from the ETag. */
export async function updateDnaReport(reportId: string, patch: UpdateDnaReportRequest, etag: string): Promise<WithEtag<DnaReport>> {
  return patchWithEtag(`${BASE}/${encodeURIComponent(reportId)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

/** Queues a generation job; progress is tracked via jobs/:jobId (+ stream). */
export function generateDnaReport(doctorId: string, body: GenerateDnaReportRequest = {}): Promise<DnaJob> {
  return postJson(`${BASE}/generate/${encodeURIComponent(doctorId)}`, body);
}

/**
 * Erases a doctor's ENTIRE learned DNA writing-style profile (every owned report + its
 * versions) — the admin half of INV-240's "deletable by the clinician" requirement, for
 * offboarding or a compliance request without impersonating the doctor. Soft delete only;
 * idempotent (a doctor with no profile answers zero counts, not a 404).
 */
export function resetDoctorDnaProfile(doctorId: string): Promise<DnaErasureResult> {
  return deleteJson(`${BASE}/doctor/${encodeURIComponent(doctorId)}`);
}

export function listDnaVersions(reportId: string): Promise<DnaVersion[]> {
  return getJson(`${BASE}/${encodeURIComponent(reportId)}/versions`);
}

export function getDnaJobStatus(jobId: string): Promise<DnaJobStatus> {
  return getJson(`${BASE}/jobs/${encodeURIComponent(jobId)}`);
}

/** Gateway-relative SSE path for a job — pair with scope `dna_job:<jobId>`. */
export function dnaJobStreamPath(jobId: string): string {
  return `${BASE}/jobs/${encodeURIComponent(jobId)}/stream`;
}
