/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// TASK-886 — per-tenant guardrail AVAILABILITY. ONE row per tenant (the SYSTEM
// tenant owns the platform default set). `policies` is the selected set, keyed
// by the check names declared in `apps/guardrail/.../services/screening.py`:
// `{ "<checkName>": { "enabled": bool, "<threshold>": number } }`.
//
// The entity deliberately types it as an opaque record. The CATALOGUE — which
// names are legal, which carry a threshold, and in which direction that
// threshold tightens — is an APPLICATION concern that must be shared with the
// console and the Python runtime, so it lives in
// `packages/applications/src/services/guardrail-availability/policy-catalogue.ts`
// rather than being restated here. Structural invariants only in `validate()`;
// the tighten-only rule is a business rule and belongs in the service
// (`.claude/rules/03-domain-layer.md` §Strict Rules).
export interface ITenantGuardrailPolicyEntity extends IBaseTenantEntity {
  policies: Record<string, unknown>;
  reason?: string | null;
}

export class TenantGuardrailPolicyEntity extends BaseTenantEntity {
  private _policies: ITenantGuardrailPolicyEntity['policies'];
  private _reason?: ITenantGuardrailPolicyEntity['reason'];

  constructor(init: ITenantGuardrailPolicyEntity) {
    super(init);
    this._policies = init.policies;
    this._reason = init.reason;
  }

  get policies(): ITenantGuardrailPolicyEntity['policies'] {
    return this._policies;
  }

  set policies(value: ITenantGuardrailPolicyEntity['policies']) {
    this.setProperty('policies', value);
  }

  get reason(): ITenantGuardrailPolicyEntity['reason'] {
    return this._reason;
  }

  set reason(value: ITenantGuardrailPolicyEntity['reason']) {
    this.setProperty('reason', value);
  }

  /**
   * STRUCTURAL invariant only: the selection must be a JSON object.
   *
   * It must NOT reject an empty object. An empty (or all-disabled) selection is
   * the DECLARED way a tenant says "no opinion" and resolves to the SYSTEM set
   * at runtime — the guarantee is that there is no "off", not that every row
   * names at least one check.
   */
  validate(): void {
    if (this._policies === null || typeof this._policies !== 'object' || Array.isArray(this._policies)) {
      throw new BusinessException('TenantGuardrailPolicy.policies must be a JSON object keyed by check name');
    }
  }
}
