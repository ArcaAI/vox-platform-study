import type { TenantGuardrailPolicyResponse, UpdateTenantGuardrailPolicyRequest } from './dto';

export const IGuardrailTenantPolicyService = Symbol('IGuardrailTenantPolicyService');

/** `admin/guardrail/policy` — the caller tenant's guardrail on/off rules (TASK-1050 §11.1). */
export interface IGuardrailTenantPolicyService {
  /** The policy in force for the working tenant, per check and per direction. */
  getOwn(): Promise<TenantGuardrailPolicyResponse>;

  /** Change on/off flags under OCC. Field-level split gate: a tenant admin may change `enabled` only. */
  putOwn(request: UpdateTenantGuardrailPolicyRequest): Promise<TenantGuardrailPolicyResponse>;
}
