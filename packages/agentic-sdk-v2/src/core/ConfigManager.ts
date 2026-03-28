import * as v from 'valibot';
import { deepmerge } from 'deepmerge-ts';

import { AppConfigSchema, SYSTEM_DEFAULTS, canUserEditField, getFieldPermission, type AppConfig, type DeepPartial } from './ConfigSchema.js';

type ConfigEventType = 'configChanged' | 'userPreferencesChanged' | 'tenantConfigChanged';
type ConfigEventHandler = (config: AppConfig) => void;

export interface ConfigManagerOptions {
  onPersistUserPreferences?: (prefs: DeepPartial<AppConfig>) => Promise<void>;
  onLoadUserPreferences?: () => Promise<DeepPartial<AppConfig> | null>;
}

/**
 * Three-tier configuration resolution engine.
 *
 * Resolution order:
 *   SYSTEM_DEFAULTS  (frozen, Tier 0)
 *   <- deepmerge with tenantOverrides  (admin, Tier 1)
 *   <- deepmerge with userPreferences  (user-editable only, Tier 2)
 *   = resolved config
 *
 * Locked paths and static permission tiers enforce that users cannot
 * override admin-only fields.
 */
export class ConfigManager {
  private tenantOverrides: DeepPartial<AppConfig> = {};
  private tenantLockedPaths: Set<string> = new Set();
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
  // Tier 2 — User preferences (user-managed)
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
    if (!canUserEditField(path, this.tenantLockedPaths)) return false;
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
    return canUserEditField(path, this.tenantLockedPaths);
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
    } catch {
      // Silently fall back to defaults
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
  // Read-only mode (TASK-245 — impersonation isolation)
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
    const afterTenant = deepmerge(SYSTEM_DEFAULTS, this.tenantOverrides) as AppConfig;
    const allowedUserPrefs = this.stripLockedAndAdminPaths(this.userPreferences);
    const merged = deepmerge(afterTenant, allowedUserPrefs) as AppConfig;
    this.resolved = v.parse(AppConfigSchema, merged);
  }

  private stripLockedAndAdminPaths(preferences: DeepPartial<AppConfig>, prefix = ''): DeepPartial<AppConfig> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(preferences)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (this.tenantLockedPaths.has(path)) continue;
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
    if (!this.options.onPersistUserPreferences) return;
    try {
      await this.options.onPersistUserPreferences(this.userPreferences);
    } catch {
      // Persist failures are non-fatal
    }
  }
}
