/**
 * Wire types mirroring the harness-admin policy DTOs in @arcaai/applications
 * (HarnessPolicyResponse, UpdateHarnessPolicyRequest, LiveDocEngineConfig*) —
 * the console cannot import that server package, so the shapes are declared
 * here once, field-for-field.
 */

/** Where the effective policy row was resolved from (HarnessPolicySource). */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/**
 * GET/PATCH /admin/harness/policy (+ /global) response — the 16 runtime knobs
 * the clinical loop reads. `version` is the OCC token the ETag interceptor
 * renders as `ETag: "<version>"` (0 = code-default placeholder, no ETag).
 */
export interface HarnessPolicy {
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

/**
 * PATCH body (UpdateHarnessPolicyRequest): sparse patch — omit = unchanged;
 * `null` clears smrProvider/smrModel/toolAllowlist. `reason` is the free-text
 * note recorded on the WORM HarnessPolicyChange row. `expectedVersion` is
 * folded from If-Match server-side; the client sends both.
 */
export interface UpdateHarnessPolicyRequest {
  entityFaithfulnessThreshold?: number;
  coverageThreshold?: number;
  citationPresenceThreshold?: number;
  numericDoseThreshold?: number;
  groundednessThreshold?: number;
  safetyEnabled?: boolean;
  phiEnabled?: boolean;
  phiFailClosed?: boolean;
  safetyProvider?: string;
  safetyModel?: string;
  smrProvider?: string | null;
  smrModel?: string | null;
  maxRegen?: number;
  gateSlaSeconds?: number;
  gateEscalationSeconds?: number;
  toolAllowlist?: string[] | null;
  reason?: string;
  expectedVersion?: number;
}

/** Where the live-doc engine enabled flag was resolved from. */
export type LiveDocEngineConfigSource = 'env-default' | 'redis-override';

/** GET/PATCH /admin/harness/live/config — the engine kill-switch (NOT versioned). */
export interface LiveDocEngineConfig {
  enabled: boolean;
  envDefault: boolean;
  source: LiveDocEngineConfigSource;
  updatedAt?: string;
  updatedBy?: string;
}

/** PATCH body (UpdateLiveDocEngineConfigRequest) — plain PATCH, no If-Match. */
export interface UpdateLiveDocEngineConfigRequest {
  enabled: boolean;
  reason?: string;
}
