/** Self-service client (capabilities-matrix rows 16–17 + tenant/me). */

import { getJson, patchJson } from '@/shared/api';
import type { Tenant } from '@/features/tenants/api/types';
import type { EntitlementCapabilities } from '@/features/entitlements/api/types';
import type { UpdateUserSettingRequest, UserDepartment, UserSetting } from '@/features/users/api/types';
import type { UpdateUserPreferencesRequest, UserPreferences } from './types';

export function getMyTenant(): Promise<Tenant> {
  return getJson('tenants/me');
}

// `tenants/me/config` is no longer read or written by the console (TASK-956):
// the tenant's settings rows are edited on /settings and /settings-registry.
// The gateway route stays — the browser SDK reads it for `audio.captureRawAudio`.

export function getMyEntitlements(): Promise<EntitlementCapabilities> {
  return getJson('tenants/me/entitlements');
}

export function listMySettings(): Promise<UserSetting[]> {
  return getJson('users/me/settings');
}

export function updateMySetting(namespace: string, key: string, body: UpdateUserSettingRequest): Promise<UserSetting> {
  return patchJson(`users/me/settings/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`, body);
}

export function getMyPreferences(): Promise<UserPreferences> {
  return getJson('users/me/preferences');
}

/** The caller's own department(s), incl. while impersonated. */
export function getMyDepartments(): Promise<UserDepartment[]> {
  return getJson('users/me/departments');
}

export function updateMyPreferences(body: UpdateUserPreferencesRequest): Promise<UserPreferences> {
  return patchJson('users/me/preferences', body);
}
