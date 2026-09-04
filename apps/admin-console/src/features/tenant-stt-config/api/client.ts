/**
 * Tenant STT-config client. Two sub-resources:
 *  - the versioned config ROW (fallback pointer + auto-switch knobs; OCC If-Match),
 *  - the fallback-candidate pipelines (read-only picker options).
 *
 * TASK-862 removed the BYO credential functions that used to sit here (dead —
 * no component called them) together with their gateway facade
 * (`admin/stt-config/credentials/**`); credentials are edited and tested on
 * `/ai-providers` (`features/ai-providers`). The rest retires under TASK-861.
 * Paths are gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { getJson, getWithEtag, request } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { EffectiveSttConfig, SetSttFallbackRequest, SttConfigRow, SttPipelineCandidate } from './types';

const BASE = 'admin/stt-config';

/**
 * Both PUT routes are `@RequiresIfMatch()` even on create (no row → version 0 →
 * no ETag). The controller's Swagger documents `If-Match: "0"` as the create
 * precondition; the ETag for a versioned write is the string form of the OCC
 * version the client read.
 */
function etagFor(version: number): string {
  return `"${version}"`;
}

/** Resolved effective fallback spec (tenant row over the SYSTEM default). */
export function getSttEffective(): Promise<EffectiveSttConfig> {
  return getJson(BASE);
}

/** Raw editable row + its ETag (version 0 placeholder when none exists yet). */
export function getSttRow(): Promise<WithEtag<SttConfigRow>> {
  return getWithEtag(`${BASE}/row`);
}

/** OCC PUT: If-Match + body expectedVersion from the read ETag (0 on first create). */
export function putSttRow(patch: Omit<SetSttFallbackRequest, 'expectedVersion'>, version: number): Promise<WithEtag<SttConfigRow>> {
  return request(`${BASE}/row`, {
    method: 'PUT',
    body: { ...patch, expectedVersion: version },
    etag: etagFor(version),
  });
}

/** Enabled, cloud-engine-backed pipelines the tenant may point its fallback at. */
export function getSttFallbackCandidates(): Promise<SttPipelineCandidate[]> {
  return getJson(`${BASE}/fallback-candidates`);
}
