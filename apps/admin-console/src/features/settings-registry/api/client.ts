/**
 * Settings registry client. Paths are gateway-relative; the shared core
 * prepends the `/api/hope` BFF proxy mount.
 */

import { deleteJson, getJson, getWithEtag, putWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { EffectiveSetting, ResetRegistrySettingResult, SettingCatalog, SettingScope, WriteRegistrySettingResult } from './types';

const BASE = 'admin/settings';

/** The RBAC-filtered descriptor inventory. One call; 210 entries for a super admin. */
export function getSettingsCatalog(): Promise<SettingCatalog> {
  return getJson(`${BASE}/catalog`);
}

/**
 * One key's effective value + the version of the row a write would target.
 *
 * `scope` is load-bearing and easy to get wrong: it selects WHICH ROW the
 * returned `version`/ETag refers to. A `maxScope: 'tenant'` key has TWO rows —
 * the platform one and the caller tenant's override — and preconditioning a
 * tenant write on the platform row's version would 412 forever. So the read
 * asks for the same scope the write will target.
 */
export function getRegistrySetting(key: string, scope: SettingScope): Promise<WithEtag<EffectiveSetting>> {
  return getWithEtag(`${BASE}/registry/${encodeURIComponent(key)}`, { scope });
}

/**
 * Write one key under optimistic concurrency.
 *
 * The precondition is CONDITIONAL here, unlike most versioned routes: the PUT
 * is a create-or-update and carries `@NoOptimisticConcurrency` for exactly that
 * reason. When no row exists there is no version to echo, so the header is
 * omitted and the gateway accepts the first write; once a row exists, omitting
 * it is refused 428 and a stale one 412.
 */
export function putRegistrySetting(
  key: string,
  value: unknown,
  scope: SettingScope,
  etag: string | null,
): Promise<WithEtag<WriteRegistrySettingResult>> {
  const path = `${BASE}/registry/${encodeURIComponent(key)}`;
  const body = { value, scope };
  // A version of 0 means "no stored row", so it is not a usable precondition —
  // the ETagInterceptor already withholds the header in that case; this guards
  // the path where a caller hands us one anyway.
  const usable = etag && versionFromEtag(etag) > 0 ? etag : null;
  return usable ? putWithEtag(path, body, usable) : request(path, { method: 'PUT', body });
}

/**
 * Reset ONE tenant override so the key inherits the platform default again.
 *
 * A DELETE and not a write of the platform's current value: copying the value
 * down looks identical today and diverges silently the next time the platform
 * default moves, leaving the tenant pinned to a stale number nobody chose.
 *
 * `scope=system` is refused by the gateway (400) — the platform row is the top
 * of the cascade, so there is nothing above it to inherit. The console never
 * offers it.
 */
export function resetRegistrySetting(key: string): Promise<ResetRegistrySettingResult> {
  return deleteJson(`${BASE}/registry/${encodeURIComponent(key)}`, undefined, { scope: 'tenant' });
}
