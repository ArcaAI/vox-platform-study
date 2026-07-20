/**
 * Agentic Policy client. All paths are gateway-relative;
 * the shared core prepends the `/api/hope` BFF proxy mount so nothing here
 * ever hits the gateway directly. Edits target the SYSTEM-tenant GLOBAL-DEFAULT
 * harness policy row (the fallback for every tenant), so no working tenant is
 * required — the gateway asserts global admin in code.
 */

import { getJson, getWithEtag, patchJson, patchWithEtag, putWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
    AgenticPolicy,
    EffectiveSetting,
    WriteRegistrySettingResult,
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

/** RBAC-filtered settings catalog metadata (the governance inventory). */
export function getSettingsCatalog(): Promise<SettingCatalog> {
    return getJson(`${SETTINGS}/catalog`);
}

/**
 * Read one registry setting's EFFECTIVE VALUE plus its backing-row version
 * (TASK-533 B2). The catalog above is metadata-only; this is the value lane.
 *
 * The gateway emits `ETag: "<version>"` when a row exists. A key still on its
 * code default reports `version: 0` and emits no ETag — correct, since there is
 * nothing to precondition a first write against.
 */
export function getRegistrySetting(key: string): Promise<WithEtag<EffectiveSetting>> {
    return getWithEtag(`${SETTINGS}/registry/${encodeURIComponent(key)}`);
}

/**
 * Write one registry setting under optimistic concurrency (TASK-533 B2).
 *
 * `etag` comes from the prior read. When it is null the key has no stored row
 * yet, so the PUT goes out WITHOUT `If-Match` — the gateway only demands the
 * precondition once a row exists (428), and drift on an existing row is 412.
 */
export function putRegistrySetting(key: string, value: unknown, etag: string | null): Promise<WithEtag<WriteRegistrySettingResult>> {
    const path = `${SETTINGS}/registry/${encodeURIComponent(key)}`;
    // A version of 0 means "no stored row", so it is not a usable precondition.
    // The gateway's ETagInterceptor already withholds the header in that case;
    // this guards the path where a caller hands us one anyway.
    const usable = etag && versionFromEtag(etag) > 0 ? etag : null;
    return usable ? putWithEtag(path, { value }, usable) : request(path, { method: 'PUT', body: { value } });
}
