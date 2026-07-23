/**
 * DNA writing-style SELF-plane client (frame 53, capabilities-matrix row 37).
 * All paths are gateway-relative on `dna-writing-styles/*` — NO admin prefix
 * (the tenant-admin grid is the separate `admin/dna-writing-styles` feature).
 * The caller/doctor is derived from CLS on the gateway, so an
 * admin-impersonated doctor session works identically.
 */

import { getJson, getWithEtag, patchJson, patchWithEtag, postJson, putJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
    DnaJob,
    DnaJobStatus,
    DnaReport,
    DnaSettings,
    DnaVersion,
    GenerateDnaStyleRequest,
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

/** Promotes one of the caller's reports to the active/default (no If-Match). */
export function setDefaultReport(reportId: string): Promise<DnaReport> {
    return patchJson(`${BASE}/${encodeURIComponent(reportId)}/default`);
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
 * Writes the per-doctor DNA toggle. OCC is optional on this route: pass the
 * GET's `version` as `currentVersion` and, once a DOCTOR-scope row exists
 * (`version >= 1`), the call carries If-Match + the body `expectedVersion`
 * (header overrides body server-side; drift = 412). While `currentVersion`
 * is 0 no row exists yet, so the first write goes out without a
 * precondition. Also 403-gated by `assertActingAsDoctor`.
 */
export async function updateDnaSettings(body: UpdateDnaSettingsRequest, currentVersion?: number): Promise<DnaSettings> {
    if (currentVersion !== undefined && currentVersion >= 1) {
        const response = await request<DnaSettings>(`${BASE}/settings`, {
            method: 'PUT',
            body: { ...body, expectedVersion: currentVersion },
            etag: `"${currentVersion}"`,
        });
        return response.data;
    }
    return putJson(`${BASE}/settings`, body);
}

export function getDnaJobStatus(jobId: string): Promise<DnaJobStatus> {
    return getJson(`${BASE}/jobs/${encodeURIComponent(jobId)}`);
}

/** Gateway-relative SSE path for a job — pair with scope `dna_job:<jobId>`. */
export function dnaJobStreamPath(jobId: string): string {
    return `${BASE}/jobs/${encodeURIComponent(jobId)}/stream`;
}
