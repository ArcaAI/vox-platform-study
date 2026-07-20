/**
 * Agentic Policy client. All paths are gateway-relative;
 * the shared core prepends the `/api/hope` BFF proxy mount so nothing here
 * ever hits the gateway directly. Edits target the SYSTEM-tenant GLOBAL-DEFAULT
 * harness policy row (the fallback for every tenant), so no working tenant is
 * required — the gateway asserts global admin in code.
 */

import { getJson, getWithEtag, patchJson, patchWithEtag, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
    AgenticPolicy,
    LiveDocEngineConfig,
    SettingCatalog,
    UpdateAgenticPolicyRequest,
    UpdateLiveDocEngineConfigRequest,
} from './types';

const HARNESS = 'admin/harness';
const SETTINGS = 'admin/settings';

/**
 * PATCH policy/global is `@RequiresIfMatch()` even on a first edit (no row yet
 * → version 0 → no ETag emitted). The service ignores the version on its
 * create path, so a placeholder strong validator satisfies the header guard.
 */
const FIRST_EDIT_ETAG = '"1"';

function occBody(patch: UpdateAgenticPolicyRequest, etag: string | null): { body: UpdateAgenticPolicyRequest; etag: string } {
    if (!etag) return { body: patch, etag: FIRST_EDIT_ETAG };
    return { body: { ...patch, expectedVersion: versionFromEtag(etag) }, etag };
}

/** SYSTEM-tenant GLOBAL-DEFAULT policy row (keeps the ETag for OCC). */
export function getGlobalAgenticPolicy(): Promise<WithEtag<AgenticPolicy>> {
    return getWithEtag(`${HARNESS}/policy/global`);
}

/** OCC PATCH: If-Match + body expectedVersion folded from the read ETag. */
export function updateGlobalAgenticPolicy(patch: UpdateAgenticPolicyRequest, etag: string | null): Promise<WithEtag<AgenticPolicy>> {
    const occ = occBody(patch, etag);
    return patchWithEtag(`${HARNESS}/policy/global`, occ.body, occ.etag);
}

/** Live-doc engine kill-switch (global admin only; Redis-backed, NOT versioned). */
export function getLiveEngineConfig(): Promise<LiveDocEngineConfig> {
    return getJson(`${HARNESS}/live/config`);
}

export function updateLiveEngineConfig(body: UpdateLiveDocEngineConfigRequest): Promise<LiveDocEngineConfig> {
    return patchJson(`${HARNESS}/live/config`, body);
}

/** RBAC-filtered settings catalog metadata (values live on Settings & secrets). */
export function getSettingsCatalog(): Promise<SettingCatalog> {
    return getJson(`${SETTINGS}/catalog`);
}
