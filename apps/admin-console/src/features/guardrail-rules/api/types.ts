/** TASK-1050 W3a — wire types of `GET/PUT admin/guardrail/policy` (the tenant admin's guardrail rules). */

export type GuardrailDirection = 'inbound' | 'outbound';
export type GuardrailAction = 'ignore' | 'warn' | 'block';

export interface GuardrailCheckState {
  checkId: string;
  label: string;
  description: string;
  directions: GuardrailDirection[];
  enabled: boolean;
  /** What a violation does. Read-only for a tenant admin. */
  action: GuardrailAction;
  allowedActions: GuardrailAction[];
  locked: boolean;
  lockReason: 'catalogue' | 'platform' | null;
  editable: boolean;
  dataRegionAction?: GuardrailAction;
  minScore?: number;
  inherited: boolean;
  setBy: 'platform_admin' | 'tenant_admin' | null;
}

export interface TenantGuardrailPolicy {
  tenantId: string;
  /** `0` = no row yet; `If-Match: "0"` creates it. */
  version: number;
  directions: Record<GuardrailDirection, { enabled: boolean }>;
  checks: GuardrailCheckState[];
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Only on/off is tenant-writable. */
export interface UpdateTenantGuardrailPolicyRequest {
  directions?: Partial<Record<GuardrailDirection, { enabled: boolean }>>;
  checks?: Record<string, { enabled: boolean }>;
}
