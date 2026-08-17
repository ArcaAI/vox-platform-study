/**
 * Wire types for the super-admin Agentic Policy surface (, tier
 * 10-19). Shapes mirror the gateway DTOs in @arcaai/applications
 * (HarnessPolicyResponse / UpdateHarnessPolicyRequest, LiveDocEngineConfig*,
 * SettingCatalog*) — the console cannot import that server package, so the
 * fields are re-declared here once, matching the gateway. Features never
 * import one another (rule 13), so these deliberately duplicate the
 * harness-policy feature's overlapping types.
 */

/** Where the effective policy row resolved from (HarnessPolicySource). */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/**
 * GET /admin/harness/policy/global response — the SYSTEM-tenant GLOBAL-DEFAULT
 * agentic loop policy. `version` is the OCC token the ETag interceptor renders
 * as `ETag: "<version>"`. The agentic loop knobs are nullable
 * overrides (null = harness env/code default) and may be absent on older rows.
 */
export interface AgenticPolicy {
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
  // agentic loop knobs (nullable overrides; may be undefined on the wire).
  optimisticDeliveryEnabled?: boolean | null;
  atomicFactEnabled?: boolean | null;
  retrievalEnabled?: boolean | null;
  warmStartEnabled?: boolean | null;
  nerPriorsEnabled?: boolean | null;
  maxEditReruns?: number | null;
  regenFeedbackEnabled?: boolean | null;
  // MCP external-tools master switch (null = OFF). Super-admin
  // governed, so the effective value always comes from the SYSTEM row.
  mcpToolsEnabled?: boolean | null;
  updatedAt: string | null;
  version: number;
}

/**
 * PATCH body (UpdateHarnessPolicyRequest): sparse — omit = unchanged; `null`
 * clears an override back to the harness env/code default. `reason` rides on
 * the WORM HarnessPolicyChange row. `expectedVersion` is folded from If-Match
 * server-side; the client sends both.
 */
export interface UpdateAgenticPolicyRequest {
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
  optimisticDeliveryEnabled?: boolean | null;
  atomicFactEnabled?: boolean | null;
  retrievalEnabled?: boolean | null;
  warmStartEnabled?: boolean | null;
  nerPriorsEnabled?: boolean | null;
  maxEditReruns?: number | null;
  regenFeedbackEnabled?: boolean | null;
  mcpToolsEnabled?: boolean | null;
  reason?: string;
  expectedVersion?: number;
}

/** Where the live-doc engine enabled flag resolved from. */
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

/** One entry of the settings catalog (SettingCatalogItemResponse) — metadata only. */
export interface SettingCatalogItem {
  key: string;
  tier: string;
  dataType: string;
  sensitivity: string;
  maxScope: string;
  editableBy: string;
  category: string;
  globalOnly?: boolean;
  label?: string;
  description?: string;
}

/** GET /admin/settings/catalog envelope (SettingCatalogResponse). */
export interface SettingCatalog {
  items: SettingCatalogItem[];
  categories: string[];
}

/**
 * One registry setting's EFFECTIVE value plus its backing-row
 * version. `version: 0` (or absent) means the value is still the code default:
 * no row is stored, so the gateway emits no ETag and a first write needs none.
 */
export interface EffectiveSetting {
  key: string;
  tier: string;
  value: unknown;
  /** Which cascade tier supplied the value (`global-kv` | `code-default` | ...). */
  sourceScope: string;
  version?: number;
}

/** Result of a registry write; `version` is the next `If-Match`. */
export interface WriteRegistrySettingResult {
  key: string;
  tier: string;
  value: unknown;
  scope: string;
  version: number;
}
