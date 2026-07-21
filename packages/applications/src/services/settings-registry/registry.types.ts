// Capability/settings registry types.
//
// The typed vocabulary that classifies every admin-controllable variable by
// data class → storage tier, scope, sensitivity, and editor. A descriptor is
// pure metadata; it does NOT store the value — it says WHERE the value
// lives, WHO may edit it, and HOW DEEP the scope may go.

/**
 * Storage tier = the data class the setting belongs to. Determines the
 * physical home and whether/how it is encrypted.
 *  - `vault-kv`    class 1: shared platform secret in Vault kv-v2 (operator-set).
 *  - `db-secret`   class 2: per-tenant secret as Vault-Transit ciphertext in a DB column.
 *  - `db-config`   class 3: non-secret typed config in a dedicated table + cascade.
 *  - `global-kv`   class 4: GlobalSetting KV (AppSettings cache).
 *  - `redis-flag`  class 4: instant-fan-out kill-switch (Redis-backed).
 *  - `entitlement` class 5: plan/tenant entitlement matrix.
 *  - `env`         class 6: deploy-time env, resolved by IConfigService (not admin-editable).
 */
export type StorageTier = 'vault-kv' | 'db-secret' | 'db-config' | 'global-kv' | 'redis-flag' | 'entitlement' | 'env';

/** Cascade scope, shallow → deep. The clamp forbids setting a value deeper than a setting's maxScope. */
export type SettingScope = 'system' | 'tenant' | 'department' | 'doctor';

/** Depth ordering for the max-scope clamp; larger = deeper/more specific. */
export const SCOPE_DEPTH: Record<SettingScope, number> = {
  system: 0,
  tenant: 1,
  department: 2,
  doctor: 3,
};

export type SettingSensitivity = 'public' | 'internal' | 'secret';

export type SettingDataType = 'boolean' | 'number' | 'string' | 'string[]' | 'enum' | 'json' | 'secret';

/**
 * One controllable variable's policy. Feature modules contribute descriptors;
 * the assembled registry is the single queryable catalog (powers server-side
 * categorization, the uniform max-scope clamp, and the future admin catalog API).
 */
export interface SettingDescriptor {
  /** Canonical dotted key, e.g. `pipeline.autoSummaryEnabled`, `tts.credential.azure`. */
  key: string;
  tier: StorageTier;
  dataType: SettingDataType;
  sensitivity: SettingSensitivity;
  /** Deepest scope a tenant admin may set this at (the clamp). */
  maxScope: SettingScope;
  /** CASL subject that gates who may edit it (e.g. `PipelinePolicy`, `TenantTtsConfig`). */
  editableBy: string;
  /** GLOBAL_ADMIN-only surface (SYSTEM defaults, plan matrix, platform kill-switches). */
  globalOnly?: boolean;
  /** Server-side taxonomy bucket (replaces the client-side keyword heuristic). */
  category: string;
  /**
   * Marks an enforcing kill-switch (gates quota/feature/engine enforcement).
   * Governance rule: a kill-switch MUST default OFF (fail-safe rollout) — the
   * registry asserts this at assembly via `killSwitches()`.
   */
  killSwitch?: boolean;
  label?: string;
  description?: string;
  /** The code default — the last fallback in the cascade. */
  default?: unknown;
}
