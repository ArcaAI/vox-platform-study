/**
 * Harness policy & live config client (capabilities-matrix row 29). All paths
 * are gateway-relative; the shared core prepends the BFF proxy mount.
 */

import { getJson, getWithEtag, patchJson, patchWithEtag, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { HarnessPolicy, LiveDocEngineConfig, UpdateHarnessPolicyRequest, UpdateLiveDocEngineConfigRequest } from './types';

const BASE = 'admin/harness';

/**
 * PATCH policy routes are `@RequiresIfMatch()` even on a first edit (no row
 * yet → version 0 → no ETag emitted). The service ignores the version on its
 * create path, so a placeholder strong validator satisfies the header guard.
 */
const FIRST_EDIT_ETAG = '"1"';

function occBody(patch: UpdateHarnessPolicyRequest, etag: string | null): { body: UpdateHarnessPolicyRequest; etag: string } {
    if (!etag) return { body: patch, etag: FIRST_EDIT_ETAG };
    return { body: { ...patch, expectedVersion: versionFromEtag(etag) }, etag };
}

/** Effective tenant policy (tenant row over global default), keeping the ETag. */
export function getHarnessPolicy(): Promise<WithEtag<HarnessPolicy>> {
    return getWithEtag(`${BASE}/policy`);
}

/** OCC PATCH: If-Match + body expectedVersion from the read ETag. */
export function updateHarnessPolicy(patch: UpdateHarnessPolicyRequest, etag: string | null): Promise<WithEtag<HarnessPolicy>> {
    const occ = occBody(patch, etag);
    return patchWithEtag(`${BASE}/policy`, occ.body, occ.etag);
}

/** Platform GLOBAL-DEFAULT row (gateway asserts global admin in code). */
export function getGlobalHarnessPolicy(): Promise<WithEtag<HarnessPolicy>> {
    return getWithEtag(`${BASE}/policy/global`);
}

export function updateGlobalHarnessPolicy(patch: UpdateHarnessPolicyRequest, etag: string | null): Promise<WithEtag<HarnessPolicy>> {
    const occ = occBody(patch, etag);
    return patchWithEtag(`${BASE}/policy/global`, occ.body, occ.etag);
}

/** Live-doc engine kill-switch (global admin only; Redis-backed, NOT versioned). */
export function getLiveDocConfig(): Promise<LiveDocEngineConfig> {
    return getJson(`${BASE}/live/config`);
}

export function updateLiveDocConfig(body: UpdateLiveDocEngineConfigRequest): Promise<LiveDocEngineConfig> {
    return patchJson(`${BASE}/live/config`, body);
}
