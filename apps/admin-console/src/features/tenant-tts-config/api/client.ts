/**
 * Tenant TTS-config client — the versioned config ROW (OCC If-Match;
 * expectedVersion required, 0=create) and the platform catalog.
 *
 * @deprecated TASK-862 — removed in R3 with `TenantTtsConfig` (replacement: the
 * TTS Agent + assignment, TASK-863). The BYO credential hooks that used to sit
 * here were DEAD (no component called them) and their gateway facade
 * (`admin/tts-config/credentials/**`) is gone; credentials are edited on
 * `/ai-providers` (`features/ai-providers`).
 * Paths are gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { getJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { EffectiveTtsConfig, TtsConfigRow, TtsPlatformCatalog, UpdateTtsConfigRequest } from './types';

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

/** Registry-derived platform catalog: providers + voices (tenant-agnostic). */
export function getTtsCatalog(): Promise<TtsPlatformCatalog> {
  return getJson(`${BASE}/catalog`);
}
