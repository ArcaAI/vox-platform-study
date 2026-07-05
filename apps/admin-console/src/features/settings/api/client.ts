/** Global settings admin (capabilities-matrix row 15). Secrets stay masked. */

import { deleteJson, getJson, getWithEtag, patchWithEtag, postJson, versionFromEtag } from '@/shared/api';
import type { ListParams, Paginated, WithEtag } from '@/shared/api';
import type { CreateGlobalSettingRequest, GlobalSetting, RevealedGlobalSetting, UpdateGlobalSettingRequest } from './types';

const BASE = 'admin/settings';

export function listGlobalSettings(params?: ListParams): Promise<Paginated<GlobalSetting>> {
    return getJson(BASE, params);
}

export function listTenantScopedSettings(tenantId: string, params?: ListParams): Promise<Paginated<GlobalSetting>> {
    return getJson(`${BASE}/tenant/${encodeURIComponent(tenantId)}`, params);
}

export function getGlobalSetting(id: string): Promise<WithEtag<GlobalSetting>> {
    return getWithEtag(`${BASE}/${encodeURIComponent(id)}`);
}

export function createGlobalSetting(body: CreateGlobalSettingRequest): Promise<GlobalSetting> {
    return postJson(BASE, body);
}

/** OCC PATCH: If-Match required; expectedVersion derived from the read ETag. */
export function updateGlobalSetting(id: string, patch: UpdateGlobalSettingRequest, etag: string): Promise<WithEtag<GlobalSetting>> {
    return patchWithEtag(`${BASE}/${encodeURIComponent(id)}`, { ...patch, expectedVersion: versionFromEtag(etag) }, etag);
}

export function deleteGlobalSetting(id: string): Promise<GlobalSetting> {
    return deleteJson(`${BASE}/${encodeURIComponent(id)}`);
}

/** Step-up reveal of a secret value (re-enter password; audited). */
export function revealGlobalSetting(id: string, password: string): Promise<RevealedGlobalSetting> {
    return postJson(`${BASE}/${encodeURIComponent(id)}/reveal`, { password });
}
