/**
 * Provider-configuration admin plane (`admin/routing-policies`) — TASK-844.
 *
 * SUPER_ADMIN-only on the gateway, enforced imperatively in
 * `AiRoutingPolicyService` rather than by a decorator (there is no "super admin"
 * subject), so a tenant admin reaching these routes gets **403**, while an id
 * belonging to another tenant gets **404**. Both are real answers, not bugs —
 * the calling components gate on the ability and render the 403 as "managed by
 * the platform", never as an error toast.
 *
 * `tenantId` is an explicit QUERY parameter on every route rather than an
 * ambient header, because this screen's tenancy control targets the SYSTEM tier
 * and a customer tenant from the same mounted screen.
 */

import { deleteJson, getJson, postJson, request, versionFromEtag } from '@/shared/api';
import type { WithEtag } from '@/shared/api';
import type {
  AiRoutingPolicy,
  CreateAiRoutingPolicyRequest,
  EffectiveRoutingPolicy,
  ProviderConfigurationExport,
  ProviderConfigurationImportResult,
  UpdateAiRoutingPolicyRequest,
} from './types';

const BASE = 'admin/routing-policies';

const policyPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** Every revision owned by one tenant — DRAFT, ACTIVE and ARCHIVED alike. */
export function listRoutingPolicies(tenantId: string, taskKey?: string): Promise<AiRoutingPolicy[]> {
  return getJson(BASE, { tenantId, taskKey: taskKey || undefined });
}

/**
 * What actually serves a (tenant, task) right now: the cascade result, its
 * already-gated fallback chain, every refused candidate, and a machine-readable
 * `rejection` when nothing may serve.
 */
export function getEffectiveRoutingPolicy(tenantId: string, taskKey: string): Promise<EffectiveRoutingPolicy> {
  return getJson(`${BASE}/effective`, { tenantId, taskKey });
}

/** One revision + its ETag, which is the If-Match token for every write below. */
export function getRoutingPolicy(tenantId: string, id: string): Promise<WithEtag<AiRoutingPolicy>> {
  return request<AiRoutingPolicy>(policyPath(id), { params: { tenantId } });
}

export function createRoutingPolicy(tenantId: string, body: CreateAiRoutingPolicyRequest): Promise<AiRoutingPolicy> {
  return postJson(BASE, body, { tenantId });
}

/** OCC PATCH: If-Match + a body `expectedVersion` derived from the read ETag. */
export function updateRoutingPolicy(
  tenantId: string,
  id: string,
  patch: UpdateAiRoutingPolicyRequest,
  etag: string,
): Promise<WithEtag<AiRoutingPolicy>> {
  return request<AiRoutingPolicy>(policyPath(id), {
    method: 'PATCH',
    body: { ...patch, expectedVersion: versionFromEtag(etag) },
    etag,
    params: { tenantId },
  });
}

/**
 * Elect this configuration as the default for its task.
 *
 * Atomic on the gateway — the incumbent is unset and this row set inside one
 * transaction, with a partial unique index behind it — so the console never has
 * to sequence an unset and a set, and two administrators racing cannot both
 * win. Idempotent: re-electing the current default writes nothing.
 */
export async function setRoutingPolicyDefault(tenantId: string, id: string, etag: string): Promise<AiRoutingPolicy> {
  return (await request<AiRoutingPolicy>(`${policyPath(id)}/default`, { method: 'POST', etag, params: { tenantId } })).data;
}

/** Promote a DRAFT revision to ACTIVE. Archives what it supersedes; never deletes it. */
export async function activateRoutingPolicy(tenantId: string, id: string, etag: string): Promise<AiRoutingPolicy> {
  return (await request<AiRoutingPolicy>(`${policyPath(id)}/activate`, { method: 'POST', etag, params: { tenantId } })).data;
}

/**
 * Copy a configuration into another tenant. NO CREDENTIAL IS COPIED — the copy
 * re-points at the target tenant's own connection through the standard
 * tenant → SYSTEM cascade, lands as a DRAFT, and is never elected.
 */
export function promoteRoutingPolicy(tenantId: string, id: string, targetTenantId: string): Promise<AiRoutingPolicy> {
  return postJson(`${policyPath(id)}/promote`, undefined, { tenantId, targetTenantId });
}

export function deleteRoutingPolicy(tenantId: string, id: string): Promise<AiRoutingPolicy> {
  return deleteJson(policyPath(id), undefined, { tenantId });
}

/**
 * Export configurations as a portable artifact.
 *
 * The artifact carries NO credential material and no characters of any key —
 * only a `credentialRef` locator naming WHICH secret an importing operator must
 * supply. The console renders that locator and nothing else; see
 * `configuration-export-panel.tsx` and its test.
 */
export function exportRoutingPolicies(tenantId: string, taskKeys?: string[]): Promise<ProviderConfigurationExport> {
  return getJson(`${BASE}/export`, { tenantId, taskKeys: taskKeys?.length ? taskKeys.join(',') : undefined });
}

/** Import an exported artifact. Rows land as DRAFTs and are never elected. */
export function importRoutingPolicies(tenantId: string, artifact: ProviderConfigurationExport): Promise<ProviderConfigurationImportResult> {
  return postJson(`${BASE}/import`, artifact, { tenantId });
}
