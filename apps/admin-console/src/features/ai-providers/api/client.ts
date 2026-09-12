/**
 * Unified tenant BYO cloud-credential client (C2/C3) —
 * `admin/providers/:service/:provider` serves every capability's credentials
 * through one route family. Paths are gateway-relative; the shared core prepends
 * the BFF proxy mount.
 *
 * TASK-862: every call carries an explicit `tenantId` query param when the
 * screen's tier control supplies one. A tenant admin passes their own tenant
 * (the gateway pins them to it either way); an elevated caller passes the
 * SYSTEM tenant to edit the platform default or the working tenant to edit that
 * tenant's rows — the two tiers of one cascade, from one screen.
 */

import { getJson, getWithEtag, postJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  DeclareConnectionModelsRequest,
  InferenceReadinessSnapshot,
  PlatformDefaults,
  ProviderConnection,
  ProviderService,
  RoutingBinding,
  TestProviderConnectionRequest,
  TestProviderConnectionResult,
  UpsertProviderConnectionRequest,
} from './types';

const BASE = 'admin/providers';

/**
 * PUT is `@RequiresIfMatch()` even on create (no row → version 0 → no ETag).
 * `If-Match: "0"` is the documented create precondition; the body's
 * `expectedVersion` mirrors it (the header overrides server-side).
 */
const FIRST_EDIT_ETAG = '"0"';

const tenantParams = (tenantId?: string) => (tenantId ? { tenantId } : undefined);

/** Masked row + its ETag (a `version: 0` placeholder when none exists yet). */
export function getProviderConnection(service: ProviderService, provider: string, tenantId?: string): Promise<WithEtag<ProviderConnection>> {
  return getWithEtag(`${BASE}/${service}/${provider}`, tenantParams(tenantId));
}

/**
 * TASK-954 — the platform defaults the scoped TENANT inherits for one service,
 * read-only and masked. A tenant admin is pinned to its own tenant (a foreign
 * `tenantId` is 403); the platform tier itself is refused (400), so the
 * platform view never calls this.
 */
export function getPlatformDefaults(service: ProviderService, tenantId?: string): Promise<PlatformDefaults> {
  return getJson(`${BASE}/${service}/platform-defaults`, tenantParams(tenantId));
}

/** OCC PUT: If-Match + body expectedVersion from the read ETag (0 on create). */
export function putProviderConnection(
  service: ProviderService,
  provider: string,
  body: Omit<UpsertProviderConnectionRequest, 'expectedVersion'>,
  etag: string | null,
  tenantId?: string,
): Promise<WithEtag<ProviderConnection>> {
  const expectedVersion = etag ? versionFromEtag(etag) : 0;
  return request(`${BASE}/${service}/${provider}`, {
    method: 'PUT',
    body: { ...body, expectedVersion },
    etag: etag ?? FIRST_EDIT_ETAG,
    params: tenantParams(tenantId),
  });
}

/**
 * TASK-890 §3.7a — declare the models this connection serves.
 *
 * The body is the WHOLE list (a replacement), and there is no `If-Match`: the
 * write lands registry rows, not the connection row, so it carries no version.
 * A 409 `BYO_SLUG_SHADOWS_PLATFORM` carries `slug` / `systemModelId` /
 * `suggestedSlug` for the caller to re-send.
 */
export async function putConnectionModels(
  service: ProviderService,
  provider: string,
  body: DeclareConnectionModelsRequest,
  tenantId?: string,
): Promise<ProviderConnection> {
  // No ETag to carry: the route writes registry rows, not the connection row.
  const { data } = await request<ProviderConnection>(`${BASE}/${service}/${provider}/models`, {
    method: 'PUT',
    body,
    params: tenantParams(tenantId),
  });
  return data;
}

/** Remove the tenant's credential (soft delete) — returns the provider to "platform default". */
export async function deleteProviderConnection(service: ProviderService, provider: string, tenantId?: string): Promise<void> {
  await request<void>(`${BASE}/${service}/${provider}`, { method: 'DELETE', params: tenantParams(tenantId) });
}

/**
 * TASK-932 R-3 — restore ONE platform-managed row to its built-in default.
 *
 * No ETag: the route carries no `If-Match` on purpose. "Whatever it says now,
 * put it back" is exactly the operation an operator reaches for when the stored
 * value is wrong, so refusing it on a stale token would refuse the caller who
 * most needs it. Super-admin only, platform tier only — a tenant-tier card never
 * renders the control.
 */
export function resetProviderConnection(service: ProviderService, provider: string, tenantId?: string): Promise<ProviderConnection> {
  return postJson(`${BASE}/${service}/${provider}/reset`, {}, tenantParams(tenantId));
}

/**
 * The platform's LAST inference-readiness observation, for the engine cards.
 *
 * Read here rather than imported from `features/ai-services`: features never
 * import each other (rule 13 §Structure), and the payload this screen needs is
 * one array off a plain GET.
 */
export function getInferenceReadiness(): Promise<InferenceReadinessSnapshot> {
  return getJson('admin/ai-services/readiness');
}

/** Ephemeral "Test connection" probe — never persisted, no OCC. */
export function testProviderConnection(
  service: ProviderService,
  provider: string,
  body: TestProviderConnectionRequest,
  tenantId?: string,
): Promise<TestProviderConnectionResult> {
  return postJson(`${BASE}/${service}/${provider}/test`, body, tenantParams(tenantId));
}

/**
 * The routing configurations owned by one tenant — the "Used by" read.
 * SUPER_ADMIN-only on the gateway (imperative 403 for a tenant admin), which
 * the panel renders as "managed by the platform" rather than as a failure.
 */
export function listRoutingBindings(tenantId: string): Promise<RoutingBinding[]> {
  return getJson('admin/routing-policies', { tenantId });
}
