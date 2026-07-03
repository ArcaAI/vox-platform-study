/**
 * @arcaai/vox - useGlobalSettings Hook (TASK-032 WS-A)
 *
 * Global settings CRUD hook. RBAC-protected.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { extractArray } from '../utils/responseUtils';
import { appendPagination } from '../utils/urlUtils';
import { GLOBAL_SETTINGS_ENDPOINTS } from '../core/constants';
import { ConfigConflictError } from '../types/settings';
import type { GlobalSetting, CreateGlobalSettingInput, UpdateGlobalSettingInput, RevealSecretInput, RevealSecretResult } from '../types/settings';
import type { PaginationParams } from '../types/common';
import { AgenticError } from '../types/common';

/**
 * Per-setting `ETag` cache for TASK-302 Stream D Phase D optimistic locking.
 *
 * Map from `settingId` -> raw `ETag` header value (e.g. `"7"`, including
 * the RFC 7232 double quotes). The cache is module-level (not React state)
 * because:
 *   - the lifetime spans renders — a `get` followed by a `useEffect`-driven
 *     `update` must share the token;
 *   - it's a pure functional dependency of the server's strong-validator
 *     contract — there's no UI to derive from it;
 *   - mounting multiple `useGlobalSettings()` consumers on the same page
 *     must observe the same token (otherwise the second consumer would
 *     send a stale value).
 *
 * Entries are bumped on every successful update and invalidated on conflict;
 * `get(id)` overwrites with the latest server token.
 */
const etagCache = new Map<string, string>();

export interface UseGlobalSettingsReturn {
  settings: GlobalSetting[];
  tenantConfig: GlobalSetting[];
  isLoading: boolean;
  error: Error | null;
  list: (pagination?: PaginationParams) => Promise<GlobalSetting[]>;
  getByTenant: (tenantId: string, pagination?: PaginationParams) => Promise<GlobalSetting[]>;
  getTenantConfig: (tenantId: string) => Promise<GlobalSetting[]>;
  get: (id: string) => Promise<GlobalSetting>;
  create: (input: CreateGlobalSettingInput) => Promise<GlobalSetting>;
  update: (id: string, input: UpdateGlobalSettingInput) => Promise<GlobalSetting>;
  remove: (id: string) => Promise<void>;
  /**
   * TASK-396 — reveal ONE secret setting's plaintext. Super-admin only + step-up
   * re-auth: pass the caller's current password. The result is transient (never
   * persisted by the SDK). Throws `AgenticError` on 401 (wrong/absent password)
   * or 403 (not a super-admin).
   */
  revealSecret: (id: string, input: RevealSecretInput) => Promise<RevealSecretResult>;
}

export function useGlobalSettings(): UseGlobalSettingsReturn {
  const { execute, isLoading, error } = useApiOperation('useGlobalSettings');

  const [settings, setSettings] = useState<GlobalSetting[]>([]);
  const [tenantConfig, setTenantConfig] = useState<GlobalSetting[]>([]);

  const list = useCallback(
    (pagination?: PaginationParams) =>
      execute<GlobalSetting[]>('list', async (client) => {
        const raw = await client.get(appendPagination(GLOBAL_SETTINGS_ENDPOINTS.LIST, pagination));
        const items = extractArray<GlobalSetting>(raw);
        setSettings(items);
        return items;
      }),
    [execute],
  );

  const getByTenant = useCallback(
    (tenantId: string, pagination?: PaginationParams) =>
      execute<GlobalSetting[]>('getByTenant', async (client) => {
        const raw = await client.get(appendPagination(GLOBAL_SETTINGS_ENDPOINTS.BY_TENANT(tenantId), pagination));
        return extractArray<GlobalSetting>(raw);
      }),
    [execute],
  );

  const getTenantConfig = useCallback(
    (tenantId: string) =>
      execute<GlobalSetting[]>('getTenantConfig', async (client) => {
        const raw = await client.get(GLOBAL_SETTINGS_ENDPOINTS.TENANT_CONFIG(tenantId));
        const items = extractArray<GlobalSetting>(raw);
        setTenantConfig(items);
        return items;
      }),
    [execute],
  );

  // TASK-302 Stream D Phase D — `get` now also captures the `ETag`
  // response header so a follow-up `update(id, ...)` can replay it as
  // `If-Match`. Without this, every `update` would either 428 (header
  // missing on a `@RequiresIfMatch()` route) or race with concurrent
  // editors.
  const get = useCallback(
    (id: string) =>
      execute<GlobalSetting>('get', async (client) => {
        const { body, etag } = await client.getWithEtag<GlobalSetting>(GLOBAL_SETTINGS_ENDPOINTS.GET(id));
        if (etag) {
          etagCache.set(id, etag);
        }
        return body;
      }),
    [execute],
  );

  const create = useCallback(
    (input: CreateGlobalSettingInput) =>
      execute<GlobalSetting>('create', async (client) => {
        const data = await client.post<GlobalSetting>(GLOBAL_SETTINGS_ENDPOINTS.CREATE, input);
        setSettings((prev) => [...prev, data]);
        return data;
      }),
    [execute],
  );

  // TASK-302 Stream D Phase D — `update` replays the cached ETag as
  // `If-Match`. On `412 Precondition Failed`, the generic AgenticError
  // is transformed into a structured `ConfigConflictError` so callers
  // can `instanceof`-check and surface the conflict modal (D.5) instead
  // of a generic "something went wrong."
  const update = useCallback(
    (id: string, input: UpdateGlobalSettingInput) =>
      execute<GlobalSetting>('update', async (client) => {
        const etag = etagCache.get(id);
        if (!etag) {
          // Refuse to issue a no-If-Match PATCH — that would 428 against
          // a `@RequiresIfMatch()` route and surface as a confusing
          // AgenticError. Forcing a get() first keeps the OCC contract
          // honest end-to-end.
          throw new Error(
            `No ETag cached for setting ${id}. Call get(${id}) before update() so the SDK can replay the strong validator.`,
          );
        }
        try {
          const data = await client.patchWithIfMatch<GlobalSetting>(GLOBAL_SETTINGS_ENDPOINTS.UPDATE(id), input, etag);
          // Refresh the cached token from the response body's `version`.
          // The server bumps `_version` by exactly 1 on success; encoding
          // it here means a follow-up update() without an intervening
          // get() still works.
          if (typeof data.version === 'number') {
            etagCache.set(id, `"${data.version}"`);
          }
          setSettings((prev) => prev.map((s) => (s.id === id ? data : s)));
          return data;
        } catch (err) {
          // The AgenticClient surfaces 412 as `AgenticError({ context: {
          // status: 412, currentVersion } })`. Transform to the
          // structured ConfigConflictError and invalidate the cache so
          // a follow-up update() requires a fresh get() (prevents
          // blind re-application of a stale value).
          if (err instanceof AgenticError) {
            const status = (err.context as Record<string, unknown> | undefined)?.status;
            const currentVersion = (err.context as Record<string, unknown> | undefined)?.currentVersion;
            if (status === 412) {
              etagCache.delete(id);
              const expectedVersion = Number.parseInt(etag.replace(/"/g, ''), 10);
              throw new ConfigConflictError(
                id,
                expectedVersion,
                typeof currentVersion === 'number' ? currentVersion : expectedVersion + 1,
              );
            }
          }
          throw err;
        }
      }),
    [execute],
  );

  const remove = useCallback(
    (id: string) =>
      execute<void>('remove', async (client) => {
        await client.delete(GLOBAL_SETTINGS_ENDPOINTS.DELETE(id));
        setSettings((prev) => prev.filter((s) => s.id !== id));
      }),
    [execute],
  );

  // TASK-396 — reveal one secret's plaintext. The password is posted (over TLS)
  // for server-side step-up verification; nothing is cached locally and the
  // returned plaintext is intentionally NOT written into `settings` state (it
  // is transient and must never be persisted).
  const revealSecret = useCallback(
    (id: string, input: RevealSecretInput) =>
      execute<RevealSecretResult>('revealSecret', async (client) => {
        return client.post<RevealSecretResult>(GLOBAL_SETTINGS_ENDPOINTS.REVEAL(id), { password: input.password });
      }),
    [execute],
  );

  return { settings, tenantConfig, isLoading, error, list, getByTenant, getTenantConfig, get, create, update, remove, revealSecret };
}
