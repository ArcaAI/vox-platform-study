/**
 * Tenant STT-config client. Three sub-resources:
 *  - the versioned config ROW (fallback pointer + auto-switch knobs; OCC If-Match),
 *  - the fallback-candidate pipelines (read-only picker options),
 *  - the versioned BYO CREDENTIALS (write-only key, masked reads; OCC If-Match —
 *    the TASK-526 credential-OCC divergence from the TTS precedent).
 * Paths are gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { deleteJson, getJson, getWithEtag, request } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  EffectiveSttConfig,
  SetSttCredentialRequest,
  SetSttFallbackRequest,
  SttConfigRow,
  SttCredential,
  SttPipelineCandidate,
  SttProvider,
} from './types';

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

/** Masked BYO credentials for every configured provider (never the key). */
export function getSttCredentials(): Promise<SttCredential[]> {
  return getJson(`${BASE}/credentials`);
}

/** Set or rotate a provider's write-only BYO key under OCC (0 = create). */
export function setSttCredential(
  provider: SttProvider,
  body: Omit<SetSttCredentialRequest, 'expectedVersion'>,
  version: number,
): Promise<SttCredential> {
  return request<SttCredential>(`${BASE}/credentials/${provider}`, {
    method: 'PUT',
    body: { ...body, expectedVersion: version },
    etag: etagFor(version),
  }).then((result) => result.data);
}

/** Remove a provider's BYO credential (soft delete → 204). */
export function removeSttCredential(provider: SttProvider): Promise<void> {
  return deleteJson(`${BASE}/credentials/${provider}`);
}
