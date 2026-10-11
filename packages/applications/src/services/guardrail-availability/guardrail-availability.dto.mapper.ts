import type { TenantGuardrailPolicyEntity } from '@arcaai/domains';
import { GUARDRAIL_POLICY_CATALOGUE, type GuardrailPolicySelectionSet, type ResolvedGuardrailAvailability } from './policy-catalogue';
import { effectiveGuardrailPolicy, type EffectiveGuardrailPolicy, type GuardrailPolicyViewer } from './policy-v2';
import type { GuardrailAvailabilityResponse, GuardrailPolicyCatalogueEntryResponse, TenantGuardrailPolicyResponse } from './dto';

export class GuardrailAvailabilityDtoMapper {
  static toResponse(
    tenantId: string,
    row: TenantGuardrailPolicyEntity | null,
    effective: ResolvedGuardrailAvailability,
    effectivePolicy?: EffectiveGuardrailPolicy,
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
      ...(effectivePolicy ? { effectivePolicy: { directions: effectivePolicy.directions, checks: effectivePolicy.checks } } : {}),
      reason: row?.reason ?? null,
      updatedAt: row?.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      updatedBy: row?.updatedBy ?? null,
    };
  }

  /** TASK-1050 — the caller tenant's rules, as `admin/guardrail/policy` answers them. */
  static toTenantPolicyResponse(
    tenantId: string,
    row: TenantGuardrailPolicyEntity | null,
    systemRow: TenantGuardrailPolicyEntity | null,
    viewer: GuardrailPolicyViewer,
  ): TenantGuardrailPolicyResponse {
    const view = effectiveGuardrailPolicy(systemRow?.policies ?? null, row?.policies ?? null, viewer);
    return {
      tenantId,
      version: row ? row.version : 0,
      directions: view.directions,
      checks: view.checks,
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
      allowedActions: [...policy.allowedActions],
      platformDefaultAction: policy.platformDefaultAction,
      locked: policy.locked,
      defaultEnabled: policy.defaultEnabled,
      platformDefaultDataRegionAction: policy.platformDefaultDataRegionAction ?? null,
      ...(policy.platformDefaultCategoryActions ? { platformDefaultCategoryActions: { ...policy.platformDefaultCategoryActions } } : {}),
    }));
  }

  static asSelectionSet(row: TenantGuardrailPolicyEntity | null): GuardrailPolicySelectionSet | null {
    const policies = row?.policies;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)) return null;
    return policies as unknown as GuardrailPolicySelectionSet;
  }
}
