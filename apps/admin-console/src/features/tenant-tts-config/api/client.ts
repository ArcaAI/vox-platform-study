/**
 * Tenant TTS-config client (TASK-504 Phase 4). Two sub-resources:
 *  - the versioned config ROW (OCC If-Match; expectedVersion required, 0=create),
 *  - the non-versioned BYO CREDENTIALS (write-only key, masked reads).
 * Paths are gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { deleteJson, getJson, getWithEtag, putJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { EffectiveTtsConfig, SetTtsCredentialRequest, TtsConfigRow, TtsCredential, TtsPlatformCatalog, TtsProvider, UpdateTtsConfigRequest } from './types';

const BASE = 'admin/tts-config';

/**
 * PUT row is `@RequiresIfMatch()` even on create (no row → version 0 → no ETag).
 * The controller's Swagger documents `If-Match: "0"` as the create precondition;
 * `expectedVersion` is a REQUIRED body field, so always populate it (0 on create).
 */
const FIRST_EDIT_ETAG = '"0"';

/** Effective resolved/clamped config (tenant row over SYSTEM default). */
export function getTtsEffective(): Promise<EffectiveTtsConfig> {
  return getJson(BASE);
}

/** Raw editable row + its ETag (version 0 placeholder when none exists yet). */
export function getTtsRow(): Promise<WithEtag<TtsConfigRow>> {
  return getWithEtag(`${BASE}/row`);
}

/** OCC PUT: If-Match + body expectedVersion from the read ETag (0 on first create). */
export function putTtsRow(patch: Omit<UpdateTtsConfigRequest, 'expectedVersion'>, etag: string | null): Promise<WithEtag<TtsConfigRow>> {
  const expectedVersion = etag ? versionFromEtag(etag) : 0;
  return request(`${BASE}/row`, {
    method: 'PUT',
    body: { ...patch, expectedVersion },
    etag: etag ?? FIRST_EDIT_ETAG,
  });
}

/** Registry-derived platform catalog: providers + voices (TASK-506; tenant-agnostic). */
export function getTtsCatalog(): Promise<TtsPlatformCatalog> {
  return getJson(`${BASE}/catalog`);
}

/** Masked BYO credentials for every provider (never the key). */
export function getTtsCredentials(): Promise<TtsCredential[]> {
  return getJson(`${BASE}/credentials`);
}

/** Set or rotate a provider's write-only BYO key (not versioned). */
export function setTtsCredential(provider: TtsProvider, body: SetTtsCredentialRequest): Promise<TtsCredential> {
  return putJson(`${BASE}/credentials/${provider}`, body);
}

/** Remove a provider's BYO credential (soft delete → 204). */
export function removeTtsCredential(provider: TtsProvider): Promise<void> {
  return deleteJson(`${BASE}/credentials/${provider}`);
}
