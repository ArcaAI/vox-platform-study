/**
 * @arcaai/vox - useTenantFrontendConfig Hook
 *
 * Per-tenant FRONTEND audio-pipeline defaults (ASR model + feature switches +
 * a typed advanced `configJson`) applied to every user in the tenant. The
 * server gates `/admin/tenant-frontend-config` with `@CanManage('Tenant')`, so
 * a plain DOCTOR is denied (403) — surfaced as a clean `AgenticError`.
 *
 * Tenant scoping: a tenant admin omits `tenantId` (the server uses the CLS
 * tenant); a super admin may pass `tenantId` to target a specific tenant.
 *
 * OCC: `save` carries `expectedVersion` (the `version` from the prior `get`)
 * in the body; the server fails the PUT with `412` if the row drifted. On
 * first-time create, omit `expectedVersion`.
 */

import { useState, useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { TENANT_FRONTEND_CONFIG_ENDPOINTS } from '../core/constants';
import { appendFilters } from '../utils/urlUtils';
import type { TenantFrontendConfig, UpsertTenantFrontendConfigInput } from '../types/frontend-pipeline-config';

export interface UseTenantFrontendConfigReturn {
  /** Last-loaded config, or null when the tenant has none yet. */
  config: TenantFrontendConfig | null;
  isLoading: boolean;
  error: Error | null;
  /** Load the tenant's frontend config (super admin may pass `tenantId`). */
  get: (tenantId?: string) => Promise<TenantFrontendConfig | null>;
  /** Create-or-update the tenant's frontend config (OCC via `expectedVersion`). */
  save: (input: UpsertTenantFrontendConfigInput, tenantId?: string) => Promise<TenantFrontendConfig>;
}

export function useTenantFrontendConfig(): UseTenantFrontendConfigReturn {
  const { execute, isLoading, error } = useApiOperation('useTenantFrontendConfig');

  const [config, setConfig] = useState<TenantFrontendConfig | null>(null);

  const get = useCallback(
    (tenantId?: string) =>
      execute<TenantFrontendConfig | null>('get', async (client) => {
        const raw = await client.get<TenantFrontendConfig | null>(appendFilters(TENANT_FRONTEND_CONFIG_ENDPOINTS.GET, { tenantId }));
        setConfig(raw ?? null);
        return raw ?? null;
      }),
    [execute],
  );

  const save = useCallback(
    (input: UpsertTenantFrontendConfigInput, tenantId?: string) =>
      execute<TenantFrontendConfig>('save', async (client) => {
        const data = await client.put<TenantFrontendConfig>(appendFilters(TENANT_FRONTEND_CONFIG_ENDPOINTS.UPSERT, { tenantId }), input);
        setConfig(data);
        return data;
      }),
    [execute],
  );

  return { config, isLoading, error, get, save };
}
