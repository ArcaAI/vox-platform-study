/** Platform credential policy (password complexity/rotation + issued-secret entropy). */

import { getJson, putJson, putWithEtag } from '@/shared/api';
import type {
  GuardrailAvailability,
  GuardrailPolicyCatalogueEntry,
  SecurityPolicy,
  UpdateGuardrailAvailabilityRequest,
  UpdateSecurityPolicyRequest,
} from './types';

const BASE = 'admin/security/policy';

export function getSecurityPolicy(): Promise<SecurityPolicy> {
  return getJson(BASE);
}

/** Partial write; the gateway returns the re-read EFFECTIVE policy. */
export function updateSecurityPolicy(body: UpdateSecurityPolicyRequest): Promise<SecurityPolicy> {
  return putJson(BASE, body);
}

// ── Guardrail availability (TASK-886) ────────────────────────────────────────

const GUARDRAIL_BASE = 'admin/guardrail/availability';

export function getGuardrailPolicyCatalogue(): Promise<GuardrailPolicyCatalogueEntry[]> {
  return getJson(`${GUARDRAIL_BASE}/catalogue`);
}

export function getGuardrailAvailability(tenantId: string): Promise<GuardrailAvailability> {
  return getJson(`${GUARDRAIL_BASE}/${tenantId}`);
}

/**
 * Full-record OCC write. The If-Match token comes from the row's own `version`
 * rather than a captured ETag: `version: 0` is the documented "create me"
 * token, and a GET of a tenant with no row returns no ETag to capture.
 */
export async function putGuardrailAvailability(
  tenantId: string,
  body: UpdateGuardrailAvailabilityRequest,
  version: number,
): Promise<GuardrailAvailability> {
  const response = await putWithEtag<GuardrailAvailability>(`${GUARDRAIL_BASE}/${tenantId}`, { ...body, expectedVersion: version }, `"${version}"`);
  return response.data;
}
