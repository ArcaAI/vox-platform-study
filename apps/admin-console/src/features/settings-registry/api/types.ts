/**
 * Wire types for the settings REGISTRY lane.
 *
 * Shapes mirror the gateway DTOs (`SettingCatalogResponse` /
 * `EffectiveSettingResponse` / `WriteRegistrySettingResponse`) — the console
 * cannot import @arcaai/applications, so they are re-declared here once.
 *
 * ## Why this is a separate feature from `/settings`
 *
 * `/settings` is the LEGACY raw-row CRUD over the `GlobalSetting` table: it
 * lists rows, keyed by a name regex, and knows nothing about descriptors. This
 * lane is the opposite — it lists DESCRIPTORS (210 of them, RBAC-filtered) and
 * resolves each one's effective value through the cascade. Rule 13's "one
 * authoritative editor per backend resource" is satisfied because they address
 * different things: a descriptor-governed KEY here, a raw row (and secrets)
 * there. `/settings` keeps the row and secret administration it already owns.
 *
 * ## The governance fields ARE served
 *
 * This block used to say the opposite — that `killSwitch`, `failMode`,
 * `floorDirection`, `default`, `consumedBy` and `targetTier` were declared on
 * the descriptor but projected by nothing. That stopped being true when the
 * catalog projection widened, and the comment outlived it. All six are on the
 * wire, and TASK-932 adds the derived LOCK (`locked` / `lockLabel` /
 * `lockReason`).
 *
 * They stay OPTIONAL here for one reason only: a field the server may omit for a
 * given key (a secret's `default`, a lock on an unlocked key) must be optional or
 * every consumer would branch on a falsy value that means two things. They are
 * deliberately NOT reconstructed client-side — a hand-maintained table of 219
 * keys' governance metadata is exactly the desynchronisation this lane exists to
 * eliminate, and the lock is the newest example: it is derived on the server from
 * tier + sensitivity precisely so a new bootstrap variable cannot ship with an
 * editor nobody remembered to disable.
 */

/** Storage tier — decides whether this lane can write the key at all. */
export type SettingTier = 'vault-kv' | 'db-secret' | 'db-config' | 'global-kv' | 'redis-flag' | 'entitlement' | 'env';

/** Cascade scope, shallow → deep. */
export type SettingScope = 'system' | 'tenant' | 'department' | 'doctor';

export type SettingSensitivity = 'public' | 'internal' | 'secret';

export type SettingDataType = 'boolean' | 'number' | 'string' | 'string[]' | 'enum' | 'json' | 'secret';

/** What happens when NO tier supplies a value. */
export type SettingFailMode = 'closed' | 'open-to-default';

/** Which direction makes a value STRICTER, for keys a tenant may only tighten. */
export type SettingFloorDirection = 'lower-is-stricter' | 'higher-is-stricter' | 'superset-is-stricter';

/** One catalog entry (`SettingCatalogItemResponse`) — metadata, never a value. */
export interface SettingCatalogItem {
  key: string;
  tier: SettingTier;
  dataType: SettingDataType;
  sensitivity: SettingSensitivity;
  maxScope: SettingScope;
  /** CASL subject gating the edit, or the `none` sentinel for `env`-tier keys. */
  editableBy: string;
  category: string;
  /** SUPER_ADMIN-only surface (SYSTEM defaults, plan matrix, platform kill-switches). */
  globalOnly?: boolean;
  label?: string;
  description?: string;

  // ---- The governance half of the descriptor, served by the catalog route. ----

  /** An enforcing kill-switch whose safe position is OFF. */
  killSwitch?: boolean;
  /** `closed` = an unset value is an outage, not a fallback. */
  failMode?: SettingFailMode;
  /** Set when a tenant override may only TIGHTEN relative to the platform value. */
  floorDirection?: SettingFloorDirection;
  /** The code default — the last fallback in the cascade. Omitted for secrets. */
  default?: unknown;
  /** Deployables served this key on the effective-config pull route. */
  consumedBy?: readonly string[];
  /** Recorded eventual home when `tier` is not where the key ends up. */
  targetTier?: SettingTier;

  /**
   * TASK-932 R-6 / D-6 — un-editable from ANY admin surface, for every caller
   * including a super admin (bootstrap, credentials, data-plane transport).
   *
   * DERIVED SERVER-SIDE. The console must not re-derive it: the whole point is
   * that registering a descriptor is the only step needed to govern a key, and a
   * second copy of the rule here would drift the first time a tier changed.
   * Absent (not `false`) when the key is editable.
   */
  locked?: boolean;
  /** Short badge text for the lock KIND. Present iff `locked`. */
  lockLabel?: string;
  /** Why it is locked and where the value actually changes. Present iff `locked`. */
  lockReason?: string;
}

/** `GET admin/settings/catalog`. */
export interface SettingCatalog {
  items: SettingCatalogItem[];
  categories: string[];
}

/**
 * `GET admin/settings/registry/:key` — the effective value plus the version of
 * the row the caller intends to PUT.
 *
 * `version: 0` (or absent) means no row is stored: the value is still a code
 * default, the gateway emits no ETag, and a first write needs no precondition.
 */
export interface EffectiveSetting {
  key: string;
  tier: SettingTier;
  value: unknown;
  /** Which cascade tier actually supplied the value — the "why is it this?" answer. */
  sourceScope: string;
  version?: number;
}

/** `PUT admin/settings/registry/:key` result; `version` is the next If-Match. */
export interface WriteRegistrySettingResult {
  key: string;
  tier: SettingTier;
  value: unknown;
  scope: SettingScope;
  version: number;
}

/** `DELETE admin/settings/registry/:key?scope=tenant` result. */
export interface ResetRegistrySettingResult {
  key: string;
  tier: SettingTier;
  scope: SettingScope;
  /** `false` when there was no override to remove — a no-op, not a failure. */
  removed: boolean;
}
