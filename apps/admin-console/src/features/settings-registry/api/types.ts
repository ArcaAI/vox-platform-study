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
 * ## Fields the gateway does NOT currently serve
 *
 * `SettingDescriptor` in @arcaai/applications declares `killSwitch`,
 * `failMode`, `floorDirection`, `default`, `consumedBy` and `targetTier`, and
 * `SettingsCatalogController.getCatalog` maps NONE of them onto the wire — it
 * projects ten fields by hand. They are declared OPTIONAL below and every
 * consumer degrades gracefully when they are absent, so the affordances that
 * depend on them light up the moment the catalog projection widens, with no
 * further console change. They are deliberately NOT reconstructed client-side:
 * a hand-maintained table of 210 keys' governance metadata is exactly the
 * desynchronisation this lane exists to eliminate.
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

  // ---- Declared on the descriptor; NOT yet projected by the catalog route. ----
  // Present-and-typed so the UI is complete the day the gateway serves them.

  /** An enforcing kill-switch whose safe position is OFF. */
  killSwitch?: boolean;
  /** `closed` = an unset value is an outage, not a fallback. */
  failMode?: SettingFailMode;
  /** Set when a tenant override may only TIGHTEN relative to the platform value. */
  floorDirection?: SettingFloorDirection;
  /** The code default — the last fallback in the cascade. */
  default?: unknown;
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
