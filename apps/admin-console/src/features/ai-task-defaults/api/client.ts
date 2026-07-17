/**
 * AI task-default client (TASK-506 Phase 6). Per-tenant "default model for AI
 * task X" rows resolved tenant → SYSTEM → service env fallback. Paths are
 * gateway-relative; the shared core prepends the BFF proxy mount. Tenant
 * admins omit `tenantId` (CLS-pinned); the platform screen passes the SYSTEM
 * tenant id to edit the platform-default rows.
 */

import { getJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type { AiTaskDefaultRow, AiTaskKey, EffectiveAiTaskDefault, TaskModelOption, UpsertAiTaskDefaultRequest } from './types';

const BASE = 'admin/ai-task-defaults';

/**
 * PUT row is `@RequiresIfMatch()` even on create (no row → version 0 → no
 * ETag). `If-Match: "0"` is the documented create precondition; the body's
 * `expectedVersion` mirrors it (the header overrides server-side).
 */
const FIRST_EDIT_ETAG = '"0"';

/** Effective defaults for ALL task keys at once (one round-trip). */
export function getEffectiveTaskDefaults(tenantId?: string): Promise<EffectiveAiTaskDefault[]> {
  return getJson(BASE, { tenantId });
}

/** Effective default for ONE task key (tenant row → SYSTEM row → null). */
export function getEffectiveTaskDefault(taskKey: AiTaskKey, tenantId?: string): Promise<EffectiveAiTaskDefault> {
  return getJson(BASE, { taskKey, tenantId });
}

/** Raw editable row + its ETag (version 0 placeholder when none exists yet). */
export function getTaskDefaultRow(taskKey: AiTaskKey, tenantId?: string): Promise<WithEtag<AiTaskDefaultRow>> {
  return getWithEtag(`${BASE}/row`, { taskKey, tenantId });
}

/** OCC PUT: If-Match + body expectedVersion from the read ETag (0 on first create). */
export function putTaskDefaultRow(
  taskKey: AiTaskKey,
  body: Omit<UpsertAiTaskDefaultRequest, 'expectedVersion'>,
  etag: string | null,
  tenantId?: string,
): Promise<WithEtag<AiTaskDefaultRow>> {
  const expectedVersion = etag ? versionFromEtag(etag) : 0;
  return request(`${BASE}/row`, {
    method: 'PUT',
    params: { taskKey, tenantId },
    body: { ...body, expectedVersion },
    etag: etag ?? FIRST_EDIT_ETAG,
  });
}

/** ENABLED registry models selectable for a task key (tenant-accessible picker feed). */
export function getTaskModelOptions(taskKey: AiTaskKey): Promise<TaskModelOption[]> {
  return getJson(`${BASE}/options`, { taskKey });
}
