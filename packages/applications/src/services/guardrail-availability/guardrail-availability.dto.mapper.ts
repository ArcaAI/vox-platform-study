import type { TenantGuardrailPolicyEntity } from '@arcaai/domains';
import { GUARDRAIL_POLICY_CATALOGUE, type GuardrailPolicySelectionSet, type ResolvedGuardrailAvailability } from './policy-catalogue';
import type { GuardrailAvailabilityResponse, GuardrailPolicyCatalogueEntryResponse } from './dto';

export class GuardrailAvailabilityDtoMapper {
  static toResponse(
    tenantId: string,
    row: TenantGuardrailPolicyEntity | null,
    effective: ResolvedGuardrailAvailability,
  ): GuardrailAvailabilityResponse {
    return {
      tenantId,
      // A tenant with no row is represented as version 0 rather than 404: the
      // resource is the tenant's SELECTION, and "no selection" is a legitimate,
      // fully-resolved state (it inherits SYSTEM). 404 would say the tenant has
      // no availability, which is exactly the thing that can never be true.
      version: row ? row.version : 0,
      policies: (row?.policies ?? {}) as Record<string, unknown>,
      effective: effective.policies as unknown as Record<string, unknown>,
      effectiveSourceTenantId: effective.sourceTenantId,
      reason: row?.reason ?? null,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  static toCatalogue(): GuardrailPolicyCatalogueEntryResponse[] {
    return GUARDRAIL_POLICY_CATALOGUE.map((policy) => ({
      id: policy.id,
      label: policy.label,
      description: policy.description,
      directions: [...policy.directions],
      threshold: policy.threshold ? { ...policy.threshold } : null,
    }));
  }

  static asSelectionSet(row: TenantGuardrailPolicyEntity | null): GuardrailPolicySelectionSet | null {
    const policies = row?.policies;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return null;
    return policies as unknown as GuardrailPolicySelectionSet;
  }
}
