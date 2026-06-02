/**
 * @arcaai/vox - useArcaConfig Hook
 *
 * Configuration and personalization access hook.
 *
 * TASK-297 DEF-H3 — Reads from Zustand via discrete selectors rather than
 * subscribing to the whole store. Each `useAgenticStore(selectX)` call
 * only triggers re-render when its slice changes.
 *
 * TASK-297 DEF-C6 — Every mutation in this hook (`update`, `reset`,
 * `selectModel`, `setUserPreference`, `resetUserPreferences`) is gated on
 * `configReady`. Calling before the cascade is hydrated throws
 * `AgenticError('CONFIG_NOT_READY', ...)` rather than silently writing
 * to a half-initialized store.
 */

import { useMemo, useCallback } from 'react';
import {
  useAgenticStore,
  selectPreferences,
  selectTenantConfig,
  selectResolvedConfig,
  selectConfigReady,
  selectConfigManager,
  selectPersonalizationManager,
  selectModelRegistry,
  selectModelRegistryVersion,
  selectLogger,
} from '../store';
import type { UserPreferences, ModelDefinition, TenantAudioConfig, SttTask } from '../types';
import { AgenticError } from '../types';
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
      /** TASK-329 P3 — persisted local Whisper task (transcribe|translate). */
      sttTask?: SttTask;
    };
  };
  /** Tenant-scoped audio/AI configuration (null until loaded) */
  tenantConfig: TenantAudioConfig | null;
  /** Update user preferences */
  update: (updates: Partial<UserPreferences>) => Promise<void>;
  /** Select a model for a capability */
  selectModel: (type: 'stt' | 'vad' | 'ner', modelId: string) => void;
  /** TASK-329 P3 — persist the local STT task (transcribe|translate) */
  selectSttTask: (task: SttTask) => void;
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

export function useArcaConfig(): UseArcaConfigReturn {
  // TASK-297 DEF-H3 — discrete selector subscriptions; each only re-renders
  // on its own slice change.
  const preferences = useAgenticStore(selectPreferences);
  const tenantConfig = useAgenticStore(selectTenantConfig);
  const resolvedConfig = useAgenticStore(selectResolvedConfig);
  const configReady = useAgenticStore(selectConfigReady);
  const configManager = useAgenticStore(selectConfigManager);
  const personalizationManager = useAgenticStore(selectPersonalizationManager);
  const modelRegistry = useAgenticStore(selectModelRegistry);
  const modelRegistryVersion = useAgenticStore(selectModelRegistryVersion);
  const sdkLogger = useAgenticStore(selectLogger);
  const setPreferencesAction = useAgenticStore((s) => s.setPreferences);
  const updatePreferencesAction = useAgenticStore((s) => s.updatePreferences);
  const incrementModelRegistryVersion = useAgenticStore((s) => s.incrementModelRegistryVersion);

  const getLogger = useCallback((): ISDKLogger | undefined => {
    return sdkLogger?.child('useArcaConfig');
  }, [sdkLogger]);

  // TASK-297 DEF-C6 — gate every mutation on `configReady`.
  const requireReady = useCallback(
    (operation: string) => {
      if (!configReady) {
        throw new AgenticError('CONFIG_NOT_READY', `useArcaConfig.${operation}() called before configReady; await profile preload first.`, {
          context: { operation },
        });
      }
    },
    [configReady],
  );

  const get = useCallback(
    <K extends keyof UserPreferences>(key: K): UserPreferences[K] => {
      return preferences[key];
    },
    [preferences],
  );

  const update = useCallback(
    async (updates: Partial<UserPreferences>): Promise<void> => {
      requireReady('update');
      const logger = getLogger();

      const timer = logger?.startOperation('updatePreferences', {
        component: 'useArcaConfig',
        attributes: { updatedKeys: Object.keys(updates) },
      });

      if (!personalizationManager) {
        logger?.debug('PersonalizationManager not available, updating locally', {
          operation: 'updatePreferences',
          component: 'useArcaConfig',
        });
        updatePreferencesAction(updates);
        timer?.end(true, { attributes: { localOnly: true } });
        return;
      }

      try {
        await personalizationManager.updatePreferences(updates);
        setPreferencesAction(personalizationManager.getPreferences());
        timer?.end(true);
      } catch (error) {
        timer?.error(error as Error);
        throw error;
      }
    },
    [personalizationManager, setPreferencesAction, updatePreferencesAction, getLogger, requireReady],
  );

  const reset = useCallback(async (): Promise<void> => {
    requireReady('reset');
    const logger = getLogger();
    if (!personalizationManager) return;

    const timer = logger?.startOperation('resetPreferences', {
      component: 'useArcaConfig',
    });

    try {
      await personalizationManager.reset();
      setPreferencesAction(personalizationManager.getPreferences());
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
  }, [personalizationManager, setPreferencesAction, getLogger, requireReady]);

  const selectModel = useCallback(
    (type: 'stt' | 'vad' | 'ner', modelId: string): void => {
      requireReady('selectModel');
      const logger = getLogger();
      if (!modelRegistry) return;

      logger?.debug('Selecting model', {
        operation: 'selectModel',
        component: 'useArcaConfig',
        attributes: { type, modelId },
      });

      modelRegistry.selectModel(type, modelId);
      incrementModelRegistryVersion();
    },
    [modelRegistry, incrementModelRegistryVersion, getLogger, requireReady],
  );

  const selectSttTask = useCallback(
    (task: SttTask): void => {
      requireReady('selectSttTask');
      const logger = getLogger();
      if (!modelRegistry) return;

      logger?.debug('Selecting STT task', {
        operation: 'selectSttTask',
        component: 'useArcaConfig',
        attributes: { task },
      });

      modelRegistry.selectSttTask(task);
      incrementModelRegistryVersion();
    },
    [modelRegistry, incrementModelRegistryVersion, getLogger, requireReady],
  );

  const isLocked = useCallback(
    (path: string): boolean => {
      if (!configManager) return true;
      return !configManager.canUserEdit(path);
    },
    [configManager],
  );

  const setUserPreference = useCallback(
    (path: string, value: unknown): boolean => {
      requireReady('setUserPreference');
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
    [configManager, getLogger, requireReady],
  );

  const resetUserPreferences = useCallback((): void => {
    requireReady('resetUserPreferences');
    const logger = getLogger();
    if (!configManager) return;
    configManager.clearUserPreferences();
    logger?.info('User preferences reset via ConfigManager', {
      operation: 'resetUserPreferences',
      component: 'useArcaConfig',
    });
  }, [configManager, getLogger, requireReady]);

  const models = useMemo(() => {
    if (!modelRegistry) {
      return { stt: [], vad: [], ner: [], selected: {} };
    }
    return {
      stt: modelRegistry.getModelsByType('stt') ?? [],
      vad: modelRegistry.getModelsByType('vad') ?? [],
      ner: modelRegistry.getModelsByType('ner') ?? [],
      selected: modelRegistry.getSelected() ?? {},
    };
    // eslint-disable-next-line -- modelRegistryVersion is the explicit memo bust signal.
  }, [modelRegistry, modelRegistryVersion]);

  return useMemo(
    () => ({
      preferences,
      models,
      tenantConfig,
      update,
      selectModel,
      selectSttTask,
      get,
      reset,
      resolvedConfig,
      configReady,
      isLocked,
      setUserPreference,
      resetUserPreferences,
    }),
    [
      preferences,
      models,
      tenantConfig,
      update,
      selectModel,
      selectSttTask,
      get,
      reset,
      resolvedConfig,
      configReady,
      isLocked,
      setUserPreference,
      resetUserPreferences,
    ],
  );
}
