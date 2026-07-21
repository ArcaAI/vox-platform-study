import * as v from 'valibot';
import { deepmerge } from 'deepmerge-ts';

import { AppConfigSchema, SYSTEM_DEFAULTS, canUserEditField, getFieldPermission, type AppConfig, type DeepPartial } from './ConfigSchema.js';

type ConfigEventType =
  | 'configChanged'
  | 'userPreferencesChanged'
  | 'tenantConfigChanged'
  /** Emitted whenever the department tier changes. */
  | 'departmentConfigChanged';
type ConfigEventHandler = (config: AppConfig) => void;

/**
 * Minimal logger surface the ConfigManager can call into
 * to surface I/O failures (load / persist). Kept tiny and structurally
 * compatible with `ISDKLogger` so `logger.child(...)` can be passed straight
 * in from the provider.
 */
export interface ConfigManagerLogger {
  // Method syntax (not an arrow property) so parameter checking is
  // bivariant. This lets a full `ISDKLogger` (whose `warn(message, meta?: LogMeta)`
  // is narrower in its 2nd param) be passed where a `ConfigManagerLogger` is
  // expected, without coupling ConfigManager to the SDK logger's `LogMeta` type.
  warn(message: string, context?: unknown): void;
}

export interface ConfigManagerOptions {
  onPersistUserPreferences?: (prefs: DeepPartial<AppConfig>) => Promise<void>;
  /**
   * OPTIONAL additive server sync of the user-pref tier
   * (e.g. debounced `PATCH /user/me/settings`). Runs ALONGSIDE
   * `onPersistUserPreferences` and is gated by the SAME read-only
   * short-circuit, so an admin's edits while impersonating never
   * reach the impersonated user's server profile. A rejection here is
   * isolated and never breaks local-storage persistence.
   */
  onPersistUserPreferencesToServer?: (prefs: DeepPartial<AppConfig>) => Promise<void>;
  onLoadUserPreferences?: () => Promise<DeepPartial<AppConfig> | null>;
  /** Optional SDK logger; if provided, load/persist errors are surfaced via `warn`. */
  logger?: ConfigManagerLogger;
}

/**
 * Four-tier configuration resolution engine.
 *
 * Resolution order:
 *   SYSTEM_DEFAULTS         (frozen, Tier 0)
 *   <- tenantOverrides      (admin, Tier 1)
 *   <- departmentOverrides  (department admin, Tier 2)
 *   <- userPreferences      (user-editable only, Tier 3)
 *   = resolved config
 *
 * Locked paths from both tenant AND department are unioned for the user
 * strip, so a user cannot override a path locked by either tier.
 */
export class ConfigManager {
  private tenantOverrides: DeepPartial<AppConfig> = {};
  private tenantLockedPaths: Set<string> = new Set();
  /** Department tier (Tier 2). */
  private departmentOverrides: DeepPartial<AppConfig> = {};
  /** Paths locked by the department tier. */
  private departmentLockedPaths: Set<string> = new Set();
  private userPreferences: DeepPartial<AppConfig> = {};
  private resolved: AppConfig = SYSTEM_DEFAULTS;
  private listeners = new Map<ConfigEventType, Set<ConfigEventHandler>>();
  private options: ConfigManagerOptions;
  private readOnly = false;

  constructor(options: ConfigManagerOptions = {}) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // Tier 1 — Tenant config (admin-managed)
  // ---------------------------------------------------------------------------

  setTenantConfig(overrides: DeepPartial<AppConfig>, lockedPaths: string[] = []): void {
    this.tenantOverrides = overrides;
    this.tenantLockedPaths = new Set(lockedPaths);
    this.resolve();
    this.emit('tenantConfigChanged', this.resolved);
  }

  getTenantLockedPaths(): ReadonlySet<string> {
    return this.tenantLockedPaths;
  }

  // ---------------------------------------------------------------------------
  // Tier 2 — Department config
  // ---------------------------------------------------------------------------

  /**
   * Apply department-tier overrides on top of tenant. `lockedPaths` here are
   * unioned with the tenant's locked paths when stripping user preferences.
   */
  setDepartmentConfig(overrides: DeepPartial<AppConfig>, lockedPaths: string[] = []): void {
    this.departmentOverrides = overrides;
    this.departmentLockedPaths = new Set(lockedPaths);
    this.resolve();
    this.emit('departmentConfigChanged', this.resolved);
  }

  /** Drop the department tier (e.g. on department change / impersonation end). */
  clearDepartmentConfig(): void {
    this.departmentOverrides = {};
    this.departmentLockedPaths = new Set();
    this.resolve();
    this.emit('departmentConfigChanged', this.resolved);
  }

  getDepartmentLockedPaths(): ReadonlySet<string> {
    return this.departmentLockedPaths;
  }

  // ---------------------------------------------------------------------------
  // Tier 3 — User preferences (user-managed)
  // ---------------------------------------------------------------------------

  setUserPreferences(prefs: DeepPartial<AppConfig>): void {
    this.userPreferences = prefs;
    this.resolve();
    this.emit('userPreferencesChanged', this.resolved);
  }

  /**
   * Set a single user preference by dot-notation path.
   * Returns false if the path is locked by tenant or is admin-only.
   */
  setUserValue(path: string, value: unknown): boolean {
    if (!canUserEditField(path, this.allLockedPaths())) return false;
    if (getFieldPermission(path) !== 'user') return false;

    const parts = path.split('.');
    let target: Record<string, unknown> = this.userPreferences as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!target[part] || typeof target[part] !== 'object') {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;

    this.resolve();
    this.emit('userPreferencesChanged', this.resolved);
    this.persistUserPreferences();
    return true;
  }

  canUserEdit(path: string): boolean {
    return canUserEditField(path, this.allLockedPaths());
  }

  /**
   * Union of tenant + department locked paths.
   */
  private allLockedPaths(): ReadonlySet<string> {
    if (this.departmentLockedPaths.size === 0) return this.tenantLockedPaths;
    if (this.tenantLockedPaths.size === 0) return this.departmentLockedPaths;
    const merged = new Set(this.tenantLockedPaths);
    for (const p of this.departmentLockedPaths) merged.add(p);
    return merged;
  }

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  getResolved(): AppConfig {
    return this.resolved;
  }

  getSection<K extends keyof AppConfig>(section: K): AppConfig[K] {
    return this.resolved[section];
  }

  getValue<K extends keyof AppConfig, F extends keyof AppConfig[K]>(section: K, field: F): AppConfig[K][F] {
    return this.resolved[section][field];
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  async loadUserPreferences(): Promise<void> {
    if (!this.options.onLoadUserPreferences) return;
    try {
      const prefs = await this.options.onLoadUserPreferences();
      if (prefs) {
        this.userPreferences = prefs;
        this.resolve();
        this.emit('userPreferencesChanged', this.resolved);
      }
    } catch (error) {
      // Surface load failures via the SDK logger so the
      // host app can wire them into Highlight / OTel. Behaviour-wise we
      // still fall back to defaults so the SDK keeps working.
      this.options.logger?.warn?.('[ConfigManager] loadUserPreferences failed; falling back to defaults', {
        error: error as Error,
      });
    }
  }

  async saveUserPreferences(): Promise<void> {
    await this.persistUserPreferences();
  }

  clearUserPreferences(): void {
    this.userPreferences = {};
    this.resolve();
    this.emit('userPreferencesChanged', this.resolved);
    this.persistUserPreferences();
  }

  getUserPreferences(): DeepPartial<AppConfig> {
    return this.userPreferences;
  }

  // ---------------------------------------------------------------------------
  // Read-only mode (impersonation isolation)
  // ---------------------------------------------------------------------------

  setReadOnly(flag: boolean): void {
    this.readOnly = flag;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Load another user's preferences without triggering persistence.
   * Replaces the current user preferences entirely.
   */
  loadExternalPreferences(prefs: DeepPartial<AppConfig>): void {
    this.userPreferences = prefs;
    this.resolve();
    this.emit('userPreferencesChanged', this.resolved);
  }

  /**
   * Return a deep copy of the current user preferences for later restoration.
   */
  snapshotUserPreferences(): DeepPartial<AppConfig> {
    return JSON.parse(JSON.stringify(this.userPreferences));
  }

  /**
   * Restore user preferences from a previous snapshot.
   * Respects read-only mode for persistence.
   */
  restoreUserPreferences(snapshot: DeepPartial<AppConfig>): void {
    this.userPreferences = JSON.parse(JSON.stringify(snapshot));
    this.resolve();
    this.emit('userPreferencesChanged', this.resolved);
    this.persistUserPreferences();
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  on(event: ConfigEventType, handler: ConfigEventHandler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  off(event: ConfigEventType, handler: ConfigEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private resolve(): void {
    // 4-tier: SYSTEM <- tenant <- department <- user
    const afterTenant = deepmerge(SYSTEM_DEFAULTS, this.tenantOverrides) as AppConfig;
    const afterDept = deepmerge(afterTenant, this.departmentOverrides) as AppConfig;
    const allowedUserPrefs = this.stripLockedAndAdminPaths(this.userPreferences);
    const merged = deepmerge(afterDept, allowedUserPrefs) as AppConfig;
    this.resolved = v.parse(AppConfigSchema, merged);
  }

  private stripLockedAndAdminPaths(preferences: DeepPartial<AppConfig>, prefix = ''): DeepPartial<AppConfig> {
    const locked = this.allLockedPaths();
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(preferences)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (locked.has(path)) continue;
      if (getFieldPermission(path) !== 'user' && prefix !== '') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const nested = this.stripLockedAndAdminPaths(value as Record<string, unknown>, path);
        if (Object.keys(nested).length > 0) {
          result[key] = nested;
        }
      } else {
        result[key] = value;
      }
    }
    return result as DeepPartial<AppConfig>;
  }

  private emit(event: ConfigEventType, config: AppConfig): void {
    this.listeners.get(event)?.forEach((handler) => {
      try {
        handler(config);
      } catch {
        // Listener errors should not break resolution
      }
    });
    if (event !== 'configChanged') {
      this.listeners.get('configChanged')?.forEach((handler) => {
        try {
          handler(config);
        } catch {
          // Listener errors should not break resolution
        }
      });
    }
  }

  private async persistUserPreferences(): Promise<void> {
    if (this.readOnly) return;
    const prefs = this.userPreferences;

    if (this.options.onPersistUserPreferences) {
      try {
        await this.options.onPersistUserPreferences(prefs);
      } catch (error) {
        this.options.logger?.warn?.('[ConfigManager] persistUserPreferences failed', {
          error: error as Error,
        });
      }
    }

    // Additive server sync. Isolated try/catch so a
    // failed PATCH can never break the local-storage persistence above.
    if (this.options.onPersistUserPreferencesToServer) {
      try {
        await this.options.onPersistUserPreferencesToServer(prefs);
      } catch (error) {
        this.options.logger?.warn?.('[ConfigManager] persistUserPreferencesToServer failed', {
          error: error as Error,
        });
      }
    }
  }
}
