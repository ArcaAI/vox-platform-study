/**
 * Unified tenant BYO cloud-credential client (C2/C3) —
 * `admin/providers/:service/:provider` serves LLM, STT, and TTS credentials
 * through one route family, replacing the three per-capability facades this
 * screen consolidates. Paths are gateway-relative; the shared core prepends
 * the BFF proxy mount. Tenant admins omit `tenantId` (the gateway pins them
 * to their CLS tenant); elevated callers ride the working tenant injected as
 * `X-Tenant-Id` by the proxy.
 */

import { deleteJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { ProviderConnection, ProviderService, UpsertProviderConnectionRequest } from './types';

const BASE = 'admin/providers';

/**
 * PUT is `@RequiresIfMatch()` even on create (no row → version 0 → no ETag).
 * `If-Match: "0"` is the documented create precondition; the body's
 * `expectedVersion` mirrors it (the header overrides server-side).
 */
const FIRST_EDIT_ETAG = '"0"';

/** Masked row + its ETag (a `version: 0` placeholder when none exists yet). */
export function getProviderConnection(service: ProviderService, provider: string): Promise<WithEtag<ProviderConnection>> {
  return getWithEtag(`${BASE}/${service}/${provider}`);
}

/** OCC PUT: If-Match + body expectedVersion from the read ETag (0 on create). */
export function putProviderConnection(
  service: ProviderService,
  provider: string,
  body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>,
  etag: string | null,
): Promise<WithEtag<ProviderConnection>> {
  const expectedVersion = etag ? versionFromEtag(etag) : 0;
  return request(`${BASE}/${service}/${provider}`, {
    method: 'PUT',
    body: { ...body, expectedVersion },
    etag: etag ?? FIRST_EDIT_ETAG,
  });
}

/** Remove the tenant's credential (soft delete). */
export function deleteProviderConnection(service: ProviderService, provider: string): Promise<void> {
  return deleteJson(`${BASE}/${service}/${provider}`);
}
