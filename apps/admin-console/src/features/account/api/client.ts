/** Self-service client (capabilities-matrix rows 16–17 + tenant/me). */

import { getJson, getWithEtag, patchJson, request } from '@/shared/api';
import type { ListParams, Paginated, WithEtag } from '@/shared/api';
import type { Tenant, TenantConfig, UpdateTenantConfigItem } from '@/features/tenants/api/types';
import type { EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { UpdateUserSettingRequest, UserDepartment, UserSetting } from '@/features/users/api/types';
import type { UpdateUserPreferencesRequest, UserPreferences } from './types';

export function getMyTenant(): Promise<Tenant> {
    return getJson('tenant/me');
}

/**
 * Own-tenant config list (includes the synthetic read-only
 * `enable-local-raw-capture` row). ETag captured for the bulk PATCH.
 */
export function listMyTenantConfigs(params?: ListParams): Promise<WithEtag<Paginated<TenantConfig>>> {
    return getWithEtag('tenant/me/config', params);
}

/** Bulk PATCH with If-Match (the header folds onto every row server-side). */
export async function updateMyTenantConfigs(updates: UpdateTenantConfigItem[], etag: string): Promise<Paginated<TenantConfig>> {
    return (await request<Paginated<TenantConfig>>('tenant/me/config', { method: 'PATCH', body: updates, etag })).data;
}

export function getMyEntitlements(): Promise<EntitlementCapabilities> {
    return getJson('entitlements/me');
}

export function listMySettings(): Promise<UserSetting[]> {
    return getJson('user/me/settings');
}

export function updateMySetting(namespace: string, key: string, body: UpdateUserSettingRequest): Promise<UserSetting> {
    return patchJson(`user/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, body);
}

export function getMyPreferences(): Promise<UserPreferences> {
    return getJson('user/me/preferences');
}

/** The caller's own department(s), incl. while impersonated. */
export function getMyDepartments(): Promise<UserDepartment[]> {
    return getJson('user/me/departments');
}

export function updateMyPreferences(body: UpdateUserPreferencesRequest): Promise<UserPreferences> {
    return patchJson('user/me/preferences', body);
}
