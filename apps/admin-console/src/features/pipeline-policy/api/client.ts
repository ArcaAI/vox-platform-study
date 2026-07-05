/**
 * Realtime pipeline policy client (capabilities-matrix row 32). All paths are
 * gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { getJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
    PipelinePolicyEffective,
    PipelinePolicyEffectiveParams,
    PipelinePolicyRow,
    PipelinePolicyScope,
    UpdatePipelinePolicyRequest,
} from './types';

const BASE = 'admin/harness/pipeline-policy';

/**
 * Reserved SYSTEM tenant owning the platform-default TENANT row (mirrors
 * SYSTEM_TENANT_ID in @arcaai/domains). Readable via ?tenantId= by elevated
 * sessions only — tenant admins get 403 on a foreign tenantId.
 */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * PUT row is `@RequiresIfMatch()` even when upserting a row that does not
 * exist yet (version 0 → no ETag emitted on the read). The service ignores
 * the version on its create path, so a placeholder strong validator
 * satisfies the header guard.
 */
const FIRST_EDIT_ETAG = '"1"';

/** Resolved effective cascade (+ per-toggle trace) for the working tenant context. */
export function getPipelinePolicyEffective(params: PipelinePolicyEffectiveParams): Promise<PipelinePolicyEffective> {
    return getJson(BASE, params);
}

/** One raw, editable scope row, keeping the ETag for the later PUT. */
export function getPipelinePolicyRow(scope: PipelinePolicyScope, scopeId: string | null): Promise<WithEtag<PipelinePolicyRow>> {
    return getWithEtag(`${BASE}/row`, { scope, scopeId: scopeId || undefined });
}

/** The SYSTEM-tenant platform-default row (elevated sessions only). */
export function getSystemPipelinePolicyRow(): Promise<WithEtag<PipelinePolicyRow>> {
    return getWithEtag(`${BASE}/row`, { tenantId: SYSTEM_TENANT_ID, scope: 'TENANT' });
}

/**
 * Upsert one scope row under OCC: If-Match + body expectedVersion from the
 * read ETag on an existing row; the placeholder validator on a first edit.
 */
export async function putPipelinePolicyRow(
    scope: PipelinePolicyScope,
    scopeId: string | null,
    body: UpdatePipelinePolicyRequest,
    etag: string | null,
): Promise<WithEtag<PipelinePolicyRow>> {
    const occBody = etag ? { ...body, expectedVersion: versionFromEtag(etag) } : body;
    return request(`${BASE}/row`, {
        method: 'PUT',
        params: { scope, scopeId: scopeId || undefined },
        body: occBody,
        etag: etag ?? FIRST_EDIT_ETAG,
    });
}
