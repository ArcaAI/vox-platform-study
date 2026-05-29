/**
 * @arcaai/vox - PersonalizationManager
 *
 * Manages user preferences with local/backend/hybrid storage and comprehensive logging.
 */

import type { PersonalizationConfig, UserPreferences, UserPreferencesUpdate } from '../types';
import { AgenticError } from '../types';
import type { AgenticClient } from './AgenticClient';
import { PERSONALIZATION_ENDPOINTS, DEFAULT_SYNC_INTERVAL } from './constants';
import { configDBGet, configDBSet, PERSONALIZATION_STORE } from './configDB';
import type { ISDKLogger } from './logger';

/**
 * TASK-317 W1.1 (AC-1) — prefix for the personalization IDB cache row inside
 * the shared `arcaai-config` DB's `personalization` store. The row is keyed
 * per `${tenantId}::${userId}` namespace via {@link personalizationCacheKey}
 * so a shared workstation cannot hydrate the next user from the previous
 * user's voice-profile / model ids (closes audit C-3). Matches the legacy
 * unscoped key, which the configDB v3 upgrade deletes one-time (AC-2).
 */
export const PERSONALIZATION_CACHE_KEY_PREFIX = 'arcaai-personalization' as const;

/**
 * Compose the personalization cache key for a given namespace. Mirrors the
 * `USER_PREFERENCES_STORE` namespacing AgenticProvider already applies.
 * When no namespace is supplied the bare prefix is used (the SDK always
 * supplies one in production; this fallback only serves direct construction).
 */
export function personalizationCacheKey(namespace?: string): string {
  return namespace ? `${PERSONALIZATION_CACHE_KEY_PREFIX}/${namespace}` : PERSONALIZATION_CACHE_KEY_PREFIX;
}

/**
 * Personalization change callback
 */
export type PreferencesChangeCallback = (preferences: UserPreferences) => void;

/**
 * TASK-297 DEF-H4 — minimal ConfigManager surface the PersonalizationManager
 * forwards user-editable preference writes into. Kept structurally compatible
 * with `ConfigManager` so the real instance can be passed straight in.
 */
export interface PersonalizationConfigManager {
  setUserValue(path: string, value: unknown): boolean;
}

/**
 * TASK-297 DEF-H4 — map of `UserPreferences` field → `ConfigManager` dot-path.
 * Only fields with a `CONFIG_PERMISSIONS['user']` entry are forwarded.
 */
const PERSONALIZATION_FORWARDS: Readonly<Record<string, string>> = {
  language: 'ui.language',
};

/**
 * Manages user preferences with local/backend/hybrid storage.
 *
 * Supports three storage modes:
 * - `local`: Preferences stored only in localStorage
 * - `backend`: Preferences stored only on backend (requires API calls)
 * - `hybrid`: Local storage with periodic backend sync
 *
 * @example
 * ```typescript
 * const manager = new PersonalizationManager(
 *   { storage: 'hybrid', syncInterval: 60000, defaults: { language: 'en' } },
 *   apiClient
 * );
 *
 * // Load from backend (for hybrid/backend modes)
 * await manager.loadFromBackend();
 *
 * // Update preferences
 * await manager.updatePreferences({ language: 'th' });
 *
 * // Start periodic sync (for hybrid mode)
 * manager.startSync();
 * ```
 */
export class PersonalizationManager {
  private config: PersonalizationConfig;
  private apiClient: AgenticClient;
  private preferences: UserPreferences;
  private syncTimer?: ReturnType<typeof setInterval>;
  private changeListeners: Set<PreferencesChangeCallback> = new Set();
  private lastSyncAt?: Date;
  private isSyncing = false;
  private logger?: ISDKLogger;
  /**
   * TASK-297 H-4 — when true, `updatePreferences` mutates in-memory only:
   * it does NOT call `saveLocal()` or `syncToBackend()`. Wired from
   * `useAuth.impersonate` (true) / `useAuth.endImpersonation` (false).
   */
  private impersonationReadOnly = false;
  /** TASK-297 DEF-H4 — optional cascade sink. */
  private configManager?: PersonalizationConfigManager;
  /** TASK-317 W1.1 (AC-1) — per-`${tenantId}::${userId}` IDB cache key. */
  private readonly cacheKey: string;

  constructor(config: PersonalizationConfig, apiClient: AgenticClient, logger?: ISDKLogger, namespace?: string) {
    this.config = config;
    this.apiClient = apiClient;
    this.logger = logger;
    this.cacheKey = personalizationCacheKey(namespace);

    // TASK-304 Wave 2D — constructor stays synchronous; the IDB hydrate
    // step is exposed as the async `hydrate()` method so AgenticProvider
    // can await it before forwarding preferences to PluginManager.
    this.preferences = { ...config.defaults };

    this.logger?.debug('PersonalizationManager initialized', {
      operation: 'constructor',
      component: 'PersonalizationManager',
      attributes: {
        storage: config.storage,
        hasDefaults: !!config.defaults,
        syncInterval: config.syncInterval,
      },
    });
  }

  /**
   * Hydrate the in-memory preferences from the IDB cache.
   *
   * Safe to call multiple times. Failures are logged at `warn` level and
   * leave the existing in-memory state intact, so the SDK can still
   * proceed against backend defaults if storage is unavailable.
   *
   * TASK-304 Wave 2D — replaces the sync `localStorage` read used by
   * earlier versions; legacy `arcaai-preferences` localStorage data is
   * intentionally NOT migrated (user choice: `ignore-old-data`).
   */
  async hydrate(): Promise<void> {
    if (typeof window === 'undefined') return;

    try {
      const cached = await configDBGet<UserPreferences>(PERSONALIZATION_STORE, this.cacheKey);
      if (!cached) return;

      this.preferences = { ...this.preferences, ...cached };
      this.logger?.debug('Loaded preferences from IDB cache', {
        operation: 'hydrate',
        component: 'PersonalizationManager',
        attributes: { preferenceKeys: Object.keys(cached) },
      });
      this.notifyListeners();
    } catch (error) {
      this.logger?.warn('Failed to hydrate preferences from cache', {
        operation: 'hydrate',
        component: 'PersonalizationManager',
        error: error as Error,
      });
    }
  }

  /**
   * Get current preferences
   */
  getPreferences(): UserPreferences {
    return { ...this.preferences };
  }

  /**
   * Get a specific preference value
   */
  get<K extends keyof UserPreferences>(key: K): UserPreferences[K] {
    return this.preferences[key];
  }

  /**
   * Update preferences (deep merge for nested objects like localConfig).
   * remoteConfig is read-only and never sent to the backend.
   */
  async updatePreferences(updates: UserPreferencesUpdate): Promise<void> {
    const timer = this.logger?.startOperation('updatePreferences', {
      component: 'PersonalizationManager',
    });
    const previousPrefs = this.deepClone(this.preferences);

    // Deep merge localConfig instead of shallow replace
    if (updates.localConfig && this.preferences.localConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Deep-merge arbitrary localConfig JSON.
      const mergedLocal: Record<string, any> = { ...this.preferences.localConfig };
      for (const [key, value] of Object.entries(updates.localConfig)) {
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof mergedLocal[key] === 'object' &&
          mergedLocal[key] !== null
        ) {
          mergedLocal[key] = { ...mergedLocal[key], ...value };
        } else {
          mergedLocal[key] = value;
        }
      }
      this.preferences = {
        ...this.preferences,
        ...updates,
        localConfig: mergedLocal as UserPreferences['localConfig'],
      };
    } else {
      this.preferences = { ...this.preferences, ...updates };
    }

    this.logger?.debug('Updating preferences', {
      operation: 'updatePreferences',
      component: 'PersonalizationManager',
      attributes: {
        updatedKeys: Object.keys(updates),
        storage: this.config.storage,
        impersonationReadOnly: this.impersonationReadOnly,
      },
    });

    // TASK-297 DEF-H4 — forward overlapping user-editable fields into the
    // cascade so the resolved config tracks the personalization edit.
    this.forwardToConfigManager(updates);

    // TASK-297 H-4 — under impersonation, the admin's preference edits must
    // NOT touch the impersonated user's IDB record nor sync to the backend.
    // We still notify in-memory listeners so the UI reflects the change.
    if (this.impersonationReadOnly) {
      timer?.end(true, { attributes: { impersonationReadOnly: true } });
      this.notifyListeners();
      return;
    }

    if (this.config.storage !== 'backend') {
      await this.saveLocal();
    }

    if (this.config.storage === 'backend' || this.config.storage === 'hybrid') {
      try {
        await this.syncToBackend();
        timer?.end(true, { attributes: { syncedToBackend: true } });
      } catch (error) {
        if (this.config.storage === 'backend') {
          this.preferences = previousPrefs;
          timer?.error(error as Error, { attributes: { rolledBack: true } });
          throw error;
        }
        this.logger?.warn('Failed to sync preferences to backend (hybrid mode - keeping local changes)', {
          operation: 'updatePreferences',
          component: 'PersonalizationManager',
          error: error as Error,
        });
        timer?.end(true, { attributes: { syncedToBackend: false, localOnly: true } });
      }
    } else {
      timer?.end(true, { attributes: { syncedToBackend: false } });
    }

    this.notifyListeners();
  }

  /**
   * Set a specific preference value (only for doctor-writable fields)
   */
  async set<K extends keyof UserPreferencesUpdate>(key: K, value: UserPreferencesUpdate[K]): Promise<void> {
    await this.updatePreferences({ [key]: value } as UserPreferencesUpdate);
  }

  /**
   * Reset preferences to defaults
   */
  async reset(): Promise<void> {
    this.preferences = { ...(this.config.defaults || {}) };

    if (this.config.storage !== 'backend') {
      await this.saveLocal();
    }

    if (this.config.storage === 'backend' || this.config.storage === 'hybrid') {
      try {
        await this.syncToBackend();
      } catch (error) {
        if (this.config.storage === 'backend') {
          throw error;
        }
        this.logger?.warn('Failed to sync reset preferences to backend', {
          operation: 'reset',
          component: 'PersonalizationManager',
          error: error as Error,
        });
      }
    }

    this.notifyListeners();
  }

  /**
   * Persist preferences to the IDB cache (best-effort).
   *
   * Wraps the `configDBSet` call so callers can `await` without worrying
   * about quota/SSR/private-mode failures: any error is logged at `warn`
   * level and swallowed — the in-memory state and backend sync are the
   * source of truth.
   *
   * TASK-304 Wave 2D — replaces `localStorage.setItem`.
   */
  private async saveLocal(): Promise<void> {
    if (typeof window === 'undefined') return;

    try {
      await configDBSet(PERSONALIZATION_STORE, this.cacheKey, this.preferences);
      this.logger?.trace('Saved preferences to IDB cache', {
        operation: 'saveLocal',
        component: 'PersonalizationManager',
      });
    } catch (error) {
      this.logger?.warn('Failed to save preferences to IDB cache', {
        operation: 'saveLocal',
        component: 'PersonalizationManager',
        error: error as Error,
      });
    }
  }

  /**
   * Sync preferences to backend.
   * Strips remoteConfig (read-only) before sending.
   */
  private async syncToBackend(): Promise<void> {
    if (this.isSyncing) {
      this.logger?.debug('Sync already in progress, skipping', {
        operation: 'syncToBackend',
        component: 'PersonalizationManager',
      });
      return;
    }

    this.isSyncing = true;
    const timer = this.logger?.startOperation('syncToBackend', {
      component: 'PersonalizationManager',
    });

    try {
      const payload: UserPreferencesUpdate = {
        workflowMode: this.preferences.workflowMode,
        language: this.preferences.language,
        dnaStyleId: this.preferences.dnaStyleId,
        localConfig: this.preferences.localConfig,
        custom: this.preferences.custom,
      };
      // TASK-297 DEF-H2 — backend handler is `@Patch()`; using POST returns 405.
      await this.apiClient.patch(PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES, payload);
      this.lastSyncAt = new Date();
      timer?.end(true);
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Load preferences from backend.
   * The response includes read-only remoteConfig which is stored locally for display.
   */
  async loadFromBackend(): Promise<void> {
    if (this.config.storage === 'local') {
      this.logger?.debug('Storage mode is local, skipping backend load', {
        operation: 'loadFromBackend',
        component: 'PersonalizationManager',
      });
      return;
    }

    const timer = this.logger?.startOperation('loadFromBackend', {
      component: 'PersonalizationManager',
    });

    try {
      const remote = await this.apiClient.get<UserPreferences>(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES);

      if (remote) {
        // Deep merge localConfig from remote into existing
        if (remote.localConfig && this.preferences.localConfig) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Deep-merge arbitrary localConfig JSON.
          const mergedLocal: Record<string, any> = { ...this.preferences.localConfig };
          for (const [key, value] of Object.entries(remote.localConfig)) {
            if (
              value !== null &&
              typeof value === 'object' &&
              !Array.isArray(value) &&
              typeof mergedLocal[key] === 'object' &&
              mergedLocal[key] !== null
            ) {
              mergedLocal[key] = { ...mergedLocal[key], ...value };
            } else {
              mergedLocal[key] = value;
            }
          }
          this.preferences = {
            ...this.preferences,
            ...remote,
            localConfig: mergedLocal as UserPreferences['localConfig'],
          };
        } else {
          this.preferences = { ...this.preferences, ...remote };
        }

        if (this.config.storage === 'hybrid') {
          await this.saveLocal();
        }

        this.lastSyncAt = new Date();
        this.notifyListeners();
        timer?.end(true, {
          attributes: {
            preferenceKeys: Object.keys(remote),
            savedLocally: this.config.storage === 'hybrid',
          },
        });
      } else {
        timer?.end(true, { attributes: { preferencesFound: false } });
      }
    } catch (error) {
      if (error instanceof AgenticError && error.code === 'NOT_FOUND') {
        this.logger?.debug('No preferences found on backend, using defaults', {
          operation: 'loadFromBackend',
          component: 'PersonalizationManager',
        });
        timer?.end(true, { attributes: { preferencesFound: false, usingDefaults: true } });
        return;
      }
      timer?.error(error as Error);
      throw error;
    }
  }

  /**
   * Start periodic sync (for hybrid mode)
   */
  startSync(): void {
    if (this.config.storage !== 'hybrid') {
      this.logger?.debug('Storage mode is not hybrid, sync not started', {
        operation: 'startSync',
        component: 'PersonalizationManager',
        attributes: { storage: this.config.storage },
      });
      return;
    }
    if (this.syncTimer) {
      this.logger?.debug('Sync already running', {
        operation: 'startSync',
        component: 'PersonalizationManager',
      });
      return;
    }

    const interval = this.config.syncInterval ?? DEFAULT_SYNC_INTERVAL;

    this.logger?.info('Starting periodic preference sync', {
      operation: 'startSync',
      component: 'PersonalizationManager',
      attributes: { intervalMs: interval },
    });

    this.syncTimer = setInterval(async () => {
      try {
        await this.syncToBackend();
      } catch (error) {
        this.logger?.warn('Periodic preference sync failed', {
          operation: 'periodicSync',
          component: 'PersonalizationManager',
          error: error as Error,
        });
      }
    }, interval);
  }

  /**
   * Stop periodic sync
   */
  stopSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
      this.logger?.debug('Stopped periodic preference sync', {
        operation: 'stopSync',
        component: 'PersonalizationManager',
      });
    }
  }

  /**
   * Force sync to backend now
   */
  async syncNow(): Promise<void> {
    if (this.config.storage === 'local') {
      this.logger?.debug('Storage mode is local, skipping sync', {
        operation: 'syncNow',
        component: 'PersonalizationManager',
      });
      return;
    }
    this.logger?.debug('Forcing immediate sync to backend', {
      operation: 'syncNow',
      component: 'PersonalizationManager',
    });
    await this.syncToBackend();
  }

  /**
   * Get last sync timestamp
   */
  getLastSyncAt(): Date | undefined {
    return this.lastSyncAt;
  }

  /**
   * Check if syncing is in progress
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * Add a change listener
   */
  onChange(callback: PreferencesChangeCallback): () => void {
    this.changeListeners.add(callback);
    return () => this.changeListeners.delete(callback);
  }

  /**
   * Notify all change listeners
   */
  private notifyListeners(): void {
    const prefs = this.getPreferences();
    const listenerCount = this.changeListeners.size;

    this.logger?.trace('Notifying preference change listeners', {
      operation: 'notifyListeners',
      component: 'PersonalizationManager',
      attributes: { listenerCount },
    });

    for (const listener of this.changeListeners) {
      try {
        listener(prefs);
      } catch (error) {
        this.logger?.error('Preference change listener error', {
          operation: 'notifyListeners',
          component: 'PersonalizationManager',
          error: error as Error,
        });
      }
    }
  }

  /**
   * TASK-297 H-4 — gate persistence/sync while impersonating.
   * When `flag === true`, subsequent `updatePreferences` calls update
   * `this.preferences` and `notifyListeners()` only; they do NOT call
   * `saveLocal()` or `syncToBackend()`.
   */
  setImpersonationReadOnly(flag: boolean): void {
    this.impersonationReadOnly = flag;
    this.logger?.info('PersonalizationManager impersonation read-only flag toggled', {
      operation: 'setImpersonationReadOnly',
      component: 'PersonalizationManager',
      attributes: { impersonationReadOnly: flag },
    });
  }

  isImpersonationReadOnly(): boolean {
    return this.impersonationReadOnly;
  }

  /**
   * TASK-297 DEF-H4 — wire a ConfigManager sink so that user-editable
   * fields written via `updatePreferences` are forwarded into the 4-tier
   * cascade. Safe to call multiple times (replaces the previous sink).
   */
  setConfigManager(cfg: PersonalizationConfigManager | undefined): void {
    this.configManager = cfg;
  }

  private forwardToConfigManager(updates: UserPreferencesUpdate): void {
    if (!this.configManager) return;
    for (const [field, path] of Object.entries(PERSONALIZATION_FORWARDS)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lookup against UserPreferencesUpdate.
      const value = (updates as any)[field];
      if (value === undefined) continue;
      try {
        this.configManager.setUserValue(path, value);
      } catch (err) {
        this.logger?.warn('Failed to forward preference into ConfigManager', {
          operation: 'forwardToConfigManager',
          component: 'PersonalizationManager',
          error: err as Error,
          attributes: { field, path },
        });
      }
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.logger?.debug('Destroying PersonalizationManager', {
      operation: 'destroy',
      component: 'PersonalizationManager',
      attributes: { listenerCount: this.changeListeners.size },
    });
    this.stopSync();
    this.changeListeners.clear();
  }

  private deepClone(obj: UserPreferences): UserPreferences {
    return JSON.parse(JSON.stringify(obj));
  }
}
