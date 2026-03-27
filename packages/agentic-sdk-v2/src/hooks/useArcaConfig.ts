/**
 * @arcaai/vox - useArcaConfig Hook
 *
 * Configuration and personalization access hook.
 */

import { useMemo, useCallback } from 'react';
import { useAgenticStore } from '../store';
import type { UserPreferences, ModelDefinition, TenantAudioConfig } from '../types';
import type { AppConfig } from '../core/ConfigSchema';
import type { ISDKLogger } from '../core/logger';

// =============================================================================
// Return Type
// =============================================================================

export interface UseArcaConfigReturn {
  /** Current user preferences */
  preferences: UserPreferences;
  /** Available models by type */
  models: {
    stt: ModelDefinition[];
    vad: ModelDefinition[];
    ner: ModelDefinition[];
    selected: {
      stt?: string;
      vad?: string;
      ner?: string;
    };
  };
  /** Tenant-scoped audio/AI configuration (null until loaded) */
  tenantConfig: TenantAudioConfig | null;
  /** Update user preferences */
  update: (updates: Partial<UserPreferences>) => Promise<void>;
  /** Select a model for a capability */
  selectModel: (type: 'stt' | 'vad' | 'ner', modelId: string) => void;
  /** Get a specific preference value */
  get: <K extends keyof UserPreferences>(key: K) => UserPreferences[K];
  /** Reset preferences to defaults */
  reset: () => Promise<void>;

  // Three-tier config (TASK-244)
  /** Merged config from SYSTEM_DEFAULTS <- tenant <- user (null until loaded) */
  resolvedConfig: AppConfig | null;
  /** True once all config tiers have been loaded */
  configReady: boolean;
  /** Check if a dot-path field is locked (tenant-locked or admin-only) */
  isLocked: (path: string) => boolean;
  /** Set a single user preference by dot-path; returns false if locked/admin-only */
  setUserPreference: (path: string, value: unknown) => boolean;
  /** Clear all user preference overrides (reverts to tenant + system defaults) */
  resetUserPreferences: () => void;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Configuration and personalization access hook.
 *
 * Use this hook to access and update user preferences and model selection.
 *
 * @example
 * ```tsx
 * function SettingsPage() {
 *   const { preferences, models, update, selectModel } = useArcaConfig();
 *
 *   return (
 *     <div>
 *       <select
 *         value={preferences.language}
 *         onChange={e => update({ language: e.target.value })}
 *       >
 *         <option value="en">English</option>
 *         <option value="th">Thai</option>
 *       </select>
 *
 *       <h3>STT Models</h3>
 *       {models.stt.map(model => (
 *         <button
 *           key={model.id}
 *           onClick={() => selectModel('stt', model.id)}
 *         >
 *           {model.name} {models.selected.stt === model.id && '✓'}
 *         </button>
 *       ))}
 *     </div>
 *   );
 * }
 * ```
 */
export function useArcaConfig(): UseArcaConfigReturn {
  const store = useAgenticStore();

  // Get logger from store
  const getLogger = useCallback((): ISDKLogger | undefined => {
    return store.logger?.child('useArcaConfig');
  }, [store.logger]);

  // Get preference value
  const get = useCallback(
    <K extends keyof UserPreferences>(key: K): UserPreferences[K] => {
      return store.preferences[key];
    },
    [store.preferences],
  );

  // Update preferences
  const update = useCallback(
    async (updates: Partial<UserPreferences>): Promise<void> => {
      const { personalizationManager } = store;
      const logger = getLogger();

      const timer = logger?.startOperation('updatePreferences', {
        component: 'useArcaConfig',
        attributes: { updatedKeys: Object.keys(updates) },
      });

      if (!personalizationManager) {
        // Fallback to local update only
        logger?.debug('PersonalizationManager not available, updating locally', {
          operation: 'updatePreferences',
          component: 'useArcaConfig',
        });
        store.updatePreferences(updates);
        timer?.end(true, { attributes: { localOnly: true } });
        return;
      }

      try {
        await personalizationManager.updatePreferences(updates);
        store.setPreferences(personalizationManager.getPreferences());
        timer?.end(true);
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [store, getLogger],
  );

  // Reset preferences
  const reset = useCallback(async (): Promise<void> => {
    const { personalizationManager } = store;
    const logger = getLogger();
    if (!personalizationManager) return;

    const timer = logger?.startOperation('resetPreferences', {
      component: 'useArcaConfig',
    });

    try {
      await personalizationManager.reset();
      store.setPreferences(personalizationManager.getPreferences());
      timer?.end(true);
      logger?.info('Preferences reset to defaults', {
        operation: 'resetPreferences',
        component: 'useArcaConfig',
        success: true,
      });
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }, [store, getLogger]);

  // Select model
  const selectModel = useCallback(
    (type: 'stt' | 'vad' | 'ner', modelId: string): void => {
      const { modelRegistry } = store;
      const logger = getLogger();
      if (!modelRegistry) return;

      logger?.debug('Selecting model', {
        operation: 'selectModel',
        component: 'useArcaConfig',
        attributes: { type, modelId },
      });

      modelRegistry.selectModel(type, modelId);
      store.incrementModelRegistryVersion();
    },
    [store, getLogger],
  );

  // Three-tier config helpers (TASK-244)
  const isLocked = useCallback(
    (path: string): boolean => {
      const { configManager } = store;
      if (!configManager) return true;
      return !configManager.canUserEdit(path);
    },
    [store.configManager],
  );

  const setUserPreference = useCallback(
    (path: string, value: unknown): boolean => {
      const { configManager } = store;
      const logger = getLogger();
      if (!configManager) return false;
      const ok = configManager.setUserValue(path, value);
      if (ok) {
        logger?.debug('User preference set', {
          operation: 'setUserPreference',
          component: 'useArcaConfig',
          attributes: { path },
        });
      } else {
        logger?.debug('User preference rejected (locked or admin-only)', {
          operation: 'setUserPreference',
          component: 'useArcaConfig',
          attributes: { path },
        });
      }
      return ok;
    },
    [store.configManager, getLogger],
  );

  const resetUserPreferences = useCallback((): void => {
    const { configManager } = store;
    const logger = getLogger();
    if (!configManager) return;
    configManager.clearUserPreferences();
    logger?.info('User preferences reset via ConfigManager', {
      operation: 'resetUserPreferences',
      component: 'useArcaConfig',
    });
  }, [store.configManager, getLogger]);

  // Models state — only query types supported by ModelRegistry ('stt' | 'vad' | 'ner')
  const models = useMemo(() => {
    const { modelRegistry } = store;
    if (!modelRegistry) {
      return {
        stt: [],
        vad: [],
        ner: [],
        selected: {},
      };
    }

    return {
      stt: modelRegistry.getModelsByType('stt') ?? [],
      vad: modelRegistry.getModelsByType('vad') ?? [],
      ner: modelRegistry.getModelsByType('ner') ?? [],
      selected: modelRegistry.getSelected() ?? {},
    };
  }, [store.modelRegistry, store.modelRegistryVersion]);

  return useMemo(
    () => ({
      preferences: store.preferences,
      models,
      tenantConfig: store.tenantConfig,
      update,
      selectModel,
      get,
      reset,
      resolvedConfig: store.resolvedConfig,
      configReady: store.configReady,
      isLocked,
      setUserPreference,
      resetUserPreferences,
    }),
    [
      store.preferences,
      models,
      store.tenantConfig,
      update,
      selectModel,
      get,
      reset,
      store.resolvedConfig,
      store.configReady,
      isLocked,
      setUserPreference,
      resetUserPreferences,
    ],
  );
}
