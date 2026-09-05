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

/**
 * The deployables that can CONSUME a setting over the internal effective-config
 * pull route. Declared here (not in `effective-config`) because a descriptor is
 * pure metadata and must not depend on the read service that queries it — the
 * dependency runs one way, `effective-config` → `settings-registry`.
 *
 * `EFFECTIVE_CONFIG_SERVICES` on the wire contract is THIS list, imported, so
 * the two can never drift.
 */
export const CONSUMING_DEPLOYABLES = ['text', 'nlp', 'stt', 'guardrail', 'harness', 'tts'] as const;

export type ConsumingDeployable = (typeof CONSUMING_DEPLOYABLES)[number];

/**
 * Which direction makes a value STRICTER, for keys a tenant may only TIGHTEN.
 *
 * Declaring it on the descriptor is what lets ONE generic enforcement point in
 * the write lane cover every such key — the alternative (a per-feature floor
 * function with its own key table) is what produced the orphaned
 * `guardrail.policy.*` guard that nothing ever called.
 *
 *  - `lower-is-stricter`    a SMALLER number is tighter (a detection threshold:
 *                           lower catches more content).
 *  - `higher-is-stricter`   a LARGER number is tighter (a confidence gate: a
 *                           positive claim becomes harder to earn).
 *  - `superset-is-stricter` an array the tenant may only ADD to — it may never
 *                           drop a category the platform floor mandates.
 */
export type SettingFloorDirection = 'lower-is-stricter' | 'higher-is-stricter' | 'superset-is-stricter';

export type SettingDataType = 'boolean' | 'number' | 'string' | 'string[]' | 'enum' | 'json' | 'secret';

/**
 * What happens when NO tier supplies a value — declared on the descriptor, never
 * decided at the call site.
 *
 *  - `closed`          throw. NEVER substitute a default. Mandatory for secrets
 *                     and for provider/model SELECTION, so an unresolved
 *                     selection can never silently become another tenant's — or
 *                     a global — value. Generalises the fail-closed posture of
 *                     `apps/guardrail/src/guardrail/core/tenant_config.py`
 *                     ("Selection is DB-only … the caller must not fall back to
 *                     env for provider/model selection").
 *  - `open-to-default` fall back to `descriptor.default`. Correct for tuning
 *                     knobs and feature flags, where a missing row should
 *                     degrade to today's behaviour rather than an outage.
 *
 * SCOPE: this governs an ABSENT VALUE only. A backend/transport error is NOT a
 * failure mode — those propagate unchanged, so a fail-open knob can never mask
 * an unreachable control plane as "the default". Bounded-staleness / negative
 * caching on backend errors is the read-path concern.
 */
export type SettingFailMode = 'closed' | 'open-to-default';

/**
 * `editableBy` sentinel for the `env` tier: a deploy-time value has NO admin
 * write path, so naming a CASL subject would imply an editor surface that does
 * not exist. Governance tests bind this to `tier: 'env'` in both directions.
 */
export const EDITABLE_BY_NONE = 'none';

/**
 * Mechanical dotted-key → env-var name mapping: dotted lowerCamel
 * segments become SCREAMING_SNAKE joined by `_`.
 *
 *   storage.minio.endpoint        →  STORAGE_MINIO_ENDPOINT
 *   jwt.secretKey                 →  JWT_SECRET_KEY
 *   harness.claimCheck.accessKey  →  HARNESS_CLAIM_CHECK_ACCESS_KEY
 *   guardrailV2.groundedness.enabled → GUARDRAIL_V2_GROUNDEDNESS_ENABLED
 *
 * For `vault-kv` the result is ALSO the Vault kv-v2 secret name — the path is
 * `<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/<NAME>` and `SecretsService.getSecret`
 * is keyed by that same NAME.
 *
 * Only `env` and `vault-kv` descriptors carry this obligation; `global-kv` /
 * `db-config` keys are DB-addressed and several predate the convention
 * (`rate-limit.enabled`, `audit-retention.retention-days`), so they are exempt.
 */
export function toEnvVarName(key: string): string {
  return key
    .split('.')
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase())
    .join('_');
}

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
  /** SUPER_ADMIN-only surface (SYSTEM defaults, plan matrix, platform kill-switches). */
  globalOnly?: boolean;
  /** Server-side taxonomy bucket (replaces the client-side keyword heuristic). */
  category: string;
  /**
   * Marks an enforcing kill-switch (gates quota/feature/engine enforcement).
   * Governance rule: a kill-switch MUST default OFF (fail-safe rollout) — the
   * registry asserts this at assembly via `killSwitches()`.
   */
  killSwitch?: boolean;
  /**
   * The declared failure mode. REQUIRED — there is no safe default: defaulting
   * to `open-to-default` would make every new secret fail open unless its author
   * remembered to opt in, and defaulting to `closed` would turn every forgotten
   * tuning knob into an outage. Both mistakes are silent, so the author states it.
   * The registry refuses to assemble a `secret` descriptor that is not `closed`.
   */
  failMode: SettingFailMode;
  /**
   * The tier this key will EVENTUALLY live in, when that differs from `tier`.
   *
   * `tier` is always the honest present-tense answer — where the value lives
   * TODAY. Classification does not migrate any value, so a key that
   * is still read from `process.env` is `tier: 'env'` even where the intended
   * home is `global-kv`. `targetTier` records that target so the pending
   * migration is queryable instead of buried in prose. Absent ⇒ `tier` is final.
   */
  targetTier?: StorageTier;
  /**
   * The deployable(s) that receive this key over
   * `GET /api/v1/internal/effective-config?service=<name>`. Naming a service
   * here is the ONLY step needed to put a key on that wire: the read service
   * QUERIES the registry on this field, so there is no per-service `switch`,
   * no response-DTO field and no defaults map to edit alongside it.
   *
   * Absent ⇒ the key is not served on the pull route at all. That is the
   * correct default, and deliberately so:
   *
   *  • CARDINALITY DECIDES THE CHANNEL (owner decision D-1). The pull route is
   *    PLATFORM-scope — one cached snapshot per service process, forever. Only
   *    a knob with NO tenant opinion belongs on it. Anything that could ever
   *    differ per tenant travels the PUSH channel (per-request gateway
   *    injection) instead, and naming a service here would turn one cached
   *    entry into one per tenant.
   *  • A `maxScope: 'tenant'` descriptor therefore must NOT declare
   *    `consumedBy` — `text.guardrailPolicy.*` is the worked example: the same
   *    two concepts exist at BOTH scopes as separate keys, the platform half
   *    (`text.externalGuardrail.*`) riding the pull route and the tenant half
   *    travelling per-request injection.
   *  • Secrets are never served regardless of what this says; the read service
   *    filters `sensitivity: 'secret'` out unconditionally.
   */
  consumedBy?: readonly ConsumingDeployable[];
  /**
   * Declares that a tenant override may only TIGHTEN this key relative to the
   * platform value, and in which direction. Enforced ONCE, generically, in the
   * settings write lane: a loosening write is REJECTED (403) rather than
   * silently clamped, so an admin is told their value was refused instead of
   * believing they set it.
   *
   * Absent ⇒ no floor. Only meaningful on a key a tenant may set at all
   * (`maxScope` deeper than `system`).
   */
  floorDirection?: SettingFloorDirection;
  /**
   * A CROSS-FIELD / ORDERING invariant this key must satisfy, checked in the settings write lane
   * after the value has passed the `dataType` gate. Return a human-readable message to REFUSE the
   * write (the lane raises it as a 400), or nothing to accept.
   *
   * `dataType` classifies a value's SHAPE — "a number", "an array of strings". It cannot express
   * a relationship BETWEEN entries, and for an ordered list that gap is where the real defect
   * lives: an ordered `string[]` passes its shape check in any order, including one that locks a
   * consultation's documents before the step that writes the note into them.
   *
   * Declared on the descriptor, never branched on in the write lane — the same rule that makes
   * `globalOnly`, `maxScope` and `floorDirection` work: registering a descriptor stays the ONLY
   * step needed to govern a key. The message is the admin's whole explanation, so it must say
   * WHY the value was refused, not merely that it was.
   *
   * Absent ⇒ no invariant beyond the type check.
   */
  validate?: (value: unknown) => string | void;
  label?: string;
  description?: string;
  /** The code default — the last fallback in the cascade. */
  default?: unknown;
  /**
   * A ready-to-use LOCAL DEV value for `.env.sample`'s generator only — never
   * read at runtime (unlike `default`, which `parseApiEnv`-style validators
   * feed back in as a real fallback whenever the env var is absent). Use this
   * for values that are safe and identical for every developer because they
   * match a FIXED local-only default the repo itself provisions (e.g. Docker
   * Compose's `postgres:postgres@localhost:5432`, Vault dev-mode's fixed
   * `root` token) — never for anything that varies per install or per
   * environment. The registry refuses to assemble a `secret` descriptor that
   * sets this (governance test), and the generator's `CHANGE_ME` redaction
   * for secrets always wins over it regardless.
   */
  sampleValue?: unknown;
}
