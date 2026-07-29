/**
 * Tenant BYO cloud-credential client. Paths are gateway-relative;
 * the shared core prepends the BFF proxy mount. Tenant admins omit `tenantId`
 * (the gateway pins them to their CLS tenant); elevated callers ride the
 * working tenant injected as `X-Tenant-Id` by the proxy.
 */

import { deleteJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { CloudByoProvider, ProviderConnection, UpsertProviderConnectionRequest } from './providers-types';

// The unified provider plane is keyed by service (C3); LLM credentials live at
// `admin/providers/llm/*`. The legacy `admin/ai-providers/*` routes remain a
// one-release alias on the gateway, so this cutover is alias-safe.
const BASE = 'admin/providers/llm';

/**
 * PUT is `@RequiresIfMatch()` even on create (no row → version 0 → no ETag).
 * `If-Match: "0"` is the documented create precondition; the body's
 * `expectedVersion` mirrors it (the header overrides server-side).
 */
const FIRST_EDIT_ETAG = '"0"';

/** Masked row + its ETag (a `version: 0` placeholder when none exists yet). */
export function getProviderConnection(provider: CloudByoProvider): Promise<WithEtag<ProviderConnection>> {
  return getWithEtag(`${BASE}/${provider}`);
}

/** OCC PUT: If-Match + body expectedVersion from the read ETag (0 on create). */
export function putProviderConnection(
  provider: CloudByoProvider,
  body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>,
  etag: string | null,
): Promise<WithEtag<ProviderConnection>> {
  const expectedVersion = etag ? versionFromEtag(etag) : 0;
  return request(`${BASE}/${provider}`, {
    method: 'PUT',
    body: { ...body, expectedVersion },
    etag: etag ?? FIRST_EDIT_ETAG,
  });
}

/** Remove the tenant's credential (soft delete). Not versioned, mirroring TTS. */
export function deleteProviderConnection(provider: CloudByoProvider): Promise<void> {
  return deleteJson(`${BASE}/${provider}`);
}
