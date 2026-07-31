/**
 * Tenant BYO cloud-credential READ client. Paths are gateway-relative; the
 * shared core prepends the BFF proxy mount. Tenant admins omit `tenantId` (the
 * gateway pins them to their CLS tenant); elevated callers ride the working
 * tenant injected as `X-Tenant-Id` by the proxy.
 *
 * WRITE (PUT/DELETE) moved to the `/ai-providers` feature — the one
 * authoritative BYO-credential editor (rule 13). This lane only reads the masked
 * row for the read-only "Cloud credentials" status summary.
 */

import { getWithEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { CloudByoProvider, ProviderConnection } from './providers-types';

// The unified provider plane is keyed by service (C3); LLM credentials live at
// `admin/providers/llm/*`.
const BASE = 'admin/providers/llm';

/** Masked row + its ETag (a `version: 0` placeholder when none exists yet). */
export function getProviderConnection(provider: CloudByoProvider): Promise<WithEtag<ProviderConnection>> {
  return getWithEtag(`${BASE}/${provider}`);
}
