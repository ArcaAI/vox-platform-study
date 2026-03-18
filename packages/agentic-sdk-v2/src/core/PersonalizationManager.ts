/**
 * @arcaai/vox - PersonalizationManager
 *
 * Manages user preferences with local/backend/hybrid storage and comprehensive logging.
 */

import type { PersonalizationConfig, UserPreferences, UserPreferencesUpdate } from '../types';
import { AgenticError } from '../types';
import type { AgenticClient } from './AgenticClient';
import {
  STORAGE_KEYS,
  PERSONALIZATION_ENDPOINTS,
  DEFAULT_SYNC_INTERVAL,
} from './constants';
import type { ISDKLogger } from './logger';

/**
 * Personalization change callback
 */
export type PreferencesChangeCallback = (preferences: UserPreferences) => void;

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

  constructor(config: PersonalizationConfig, apiClient: AgenticClient, logger?: ISDKLogger) {
    this.config = config;
    this.apiClient = apiClient;
    this.logger = logger;

    // Initialize with defaults, then load from local storage
    this.preferences = { ...config.defaults };
    const localPrefs = this.loadLocal();
    if (localPrefs) {
      this.preferences = { ...this.preferences, ...localPrefs };
      this.logger?.debug('Loaded preferences from local storage', {
        operation: 'loadLocal',
        component: 'PersonalizationManager',
        attributes: { preferenceKeys: Object.keys(localPrefs) },
      });
    }

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
      },
    });

    if (this.config.storage !== 'backend') {
      this.saveLocal();
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
  async set<K extends keyof UserPreferencesUpdate>(
    key: K,
    value: UserPreferencesUpdate[K]
  ): Promise<void> {
    await this.updatePreferences({ [key]: value } as UserPreferencesUpdate);
  }

  /**
   * Reset preferences to defaults
   */
  async reset(): Promise<void> {
    this.preferences = { ...(this.config.defaults || {}) };

    if (this.config.storage !== 'backend') {
      this.saveLocal();
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
   * Load preferences from local storage
   */
  private loadLocal(): UserPreferences | null {
    if (typeof window === 'undefined') return null;

    try {
      const stored = localStorage.getItem(STORAGE_KEYS.PREFERENCES);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      this.logger?.warn('Failed to load preferences from local storage', {
        operation: 'loadLocal',
        component: 'PersonalizationManager',
        error: error as Error,
      });
      return null;
    }
  }

  /**
   * Save preferences to local storage
   */
  private saveLocal(): void {
    if (typeof window === 'undefined') return;

    try {
      localStorage.setItem(
        STORAGE_KEYS.PREFERENCES,
        JSON.stringify(this.preferences)
      );
      this.logger?.trace('Saved preferences to local storage', {
        operation: 'saveLocal',
        component: 'PersonalizationManager',
      });
    } catch (error) {
      this.logger?.warn('Failed to save preferences to local storage', {
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
      await this.apiClient.post(
        PERSONALIZATION_ENDPOINTS.UPDATE_PREFERENCES,
        payload
      );
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
      const remote = await this.apiClient.get<UserPreferences>(
        PERSONALIZATION_ENDPOINTS.GET_PREFERENCES
      );

      if (remote) {
        // Deep merge localConfig from remote into existing
        if (remote.localConfig && this.preferences.localConfig) {
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
          this.saveLocal();
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
