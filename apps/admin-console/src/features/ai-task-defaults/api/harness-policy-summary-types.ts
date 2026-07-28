/**
 * Read-only HarnessPolicy summary for the `/ai-configuration` "Effective
 * models" tab (TASK-547 requirement 4 — OD-2: a read-only effective-config
 * view is the accepted alternative to devolving global-only knobs).
 *
 * `/harness/policy` (the `harness-policy` feature) is the ONE authoritative
 * editor for this row; per rule 13's "one authoritative editor per resource"
 * pattern this surface is a read-only summary + a plain-href deep link, so
 * the wire type is declared again here rather than importing across
 * features. Mirrors `HarnessPolicy` in `features/harness-policy/api/types.ts`
 * field-for-field (both mirror `HarnessPolicyResponse` in `@arcaai/applications`).
 */

export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

export interface HarnessPolicySummary {
  id: string | null;
  tenantId: string;
  source: HarnessPolicySource;
  entityFaithfulnessThreshold: number;
  coverageThreshold: number;
  citationPresenceThreshold: number;
  numericDoseThreshold: number;
  groundednessThreshold: number;
  safetyEnabled: boolean;
  phiEnabled: boolean;
  phiFailClosed: boolean;
  safetyProvider: string;
  safetyModel: string;
  smrProvider: string | null;
  smrModel: string | null;
  maxRegen: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  toolAllowlist: string[] | null;
  updatedAt: string | null;
  version: number;
}

export type HarnessPolicyControlledBy = 'tenant' | 'global-admin';

export interface HarnessPolicyFieldControl {
  key: keyof HarnessPolicySummary;
  label: string;
  /** Mirrors `TENANT_LOCKED_POLICY_KEYS` in `harness-policy/components/policy-fields.ts` (kept duplicated per the no-cross-feature-import rule). */
  controlledBy: HarnessPolicyControlledBy;
}

/**
 * All 16 HarnessPolicy runtime knobs, each labeled with WHO can write it. The
 * 5 in `controlledBy: 'global-admin'` are `TENANT_LOCKED_POLICY_KEYS` on the
 * tenant PATCH route (`harness-policy.service.ts` `GLOBAL_ADMIN_ONLY_POLICY_KEYS`);
 * the rest are tenant-writable from `/harness/policy`.
 */
export const HARNESS_POLICY_FIELD_CONTROLS: HarnessPolicyFieldControl[] = [
  { key: 'entityFaithfulnessThreshold', label: 'Entity faithfulness threshold', controlledBy: 'tenant' },
  { key: 'coverageThreshold', label: 'Coverage threshold', controlledBy: 'tenant' },
  { key: 'citationPresenceThreshold', label: 'Citation presence threshold', controlledBy: 'tenant' },
  { key: 'numericDoseThreshold', label: 'Numeric / dose threshold', controlledBy: 'tenant' },
  { key: 'groundednessThreshold', label: 'Groundedness threshold', controlledBy: 'tenant' },
  { key: 'safetyEnabled', label: 'Safety guardrail', controlledBy: 'global-admin' },
  { key: 'phiEnabled', label: 'PHI detection', controlledBy: 'global-admin' },
  { key: 'phiFailClosed', label: 'PHI fail-closed', controlledBy: 'global-admin' },
  { key: 'safetyProvider', label: 'Safety provider', controlledBy: 'global-admin' },
  { key: 'safetyModel', label: 'Safety model', controlledBy: 'global-admin' },
  { key: 'smrProvider', label: 'SMR provider', controlledBy: 'tenant' },
  { key: 'smrModel', label: 'SMR model', controlledBy: 'tenant' },
  { key: 'maxRegen', label: 'Max regen budget', controlledBy: 'tenant' },
  { key: 'gateSlaSeconds', label: 'Gate SLA (seconds)', controlledBy: 'tenant' },
  { key: 'gateEscalationSeconds', label: 'Gate escalation (seconds)', controlledBy: 'tenant' },
  { key: 'toolAllowlist', label: 'Tool allowlist', controlledBy: 'tenant' },
];

/** Display form for one field's resolved value ("true" / "0.8" / "—"). */
export function harnessPolicyFieldDisplayValue(policy: HarnessPolicySummary, field: HarnessPolicyFieldControl): string {
  const value = policy[field.key];
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}
