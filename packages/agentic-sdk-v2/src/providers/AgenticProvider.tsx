/**
 * @arcaai/vox - AgenticProvider
 *
 * Root provider component for the SDK.
 */

import React, { useEffect, createContext, useContext, useMemo, useRef } from 'react';
import type { AgenticConfig } from '../types';
import { AgenticClient } from '../core/AgenticClient';
import { PluginManager } from '../core/PluginManager';
import { PersonalizationManager } from '../core/PersonalizationManager';
import { ModelRegistry } from '../core/ModelRegistry';
import { ConfigManager } from '../core/ConfigManager';
import type { AppConfig, DeepPartial } from '../core/ConfigSchema';
import { createSDKLogger, type SDKLogger, type ISDKLogger } from '../core/logger';
import { useAgenticStore } from '../store';
import { DEFAULT_AUDIO_CONFIG, DEFAULT_PERSONALIZATION_CONFIG } from '../types';

// =============================================================================
// IndexedDB persistence helpers (TASK-244 / Task 1.5)
// =============================================================================

const IDB_DB_NAME = 'arcaai-config';
const IDB_STORE_NAME = 'preferences';
const IDB_KEY = 'user-preferences';
const LS_FALLBACK_KEY = 'arcaai-user-preferences';

function openConfigDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openConfigDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const req = tx.objectStore(IDB_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openConfigDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadUserPreferencesFromStorage(): Promise<DeepPartial<AppConfig> | null> {
  try {
    const prefs = await idbGet<DeepPartial<AppConfig>>(IDB_KEY);
    if (prefs) return prefs;
  } catch {
    // IndexedDB unavailable (private browsing, SSR, etc.) — try localStorage
  }
  try {
    const raw = localStorage.getItem(LS_FALLBACK_KEY);
    if (raw) return JSON.parse(raw) as DeepPartial<AppConfig>;
  } catch {
    // localStorage unavailable
  }
  return null;
}

async function persistUserPreferencesToStorage(prefs: DeepPartial<AppConfig>): Promise<void> {
  try {
    await idbSet(IDB_KEY, prefs);
  } catch {
    // Fall back to localStorage if IndexedDB write fails
    try {
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(prefs));
    } catch {
      // Storage completely unavailable — silently degrade
    }
  }
}

// =============================================================================
// Context
// =============================================================================

interface AgenticContextValue {
  initialized: boolean;
  config: AgenticConfig;
  logger: ISDKLogger;
}

const AgenticContext = createContext<AgenticContextValue | null>(null);

// =============================================================================
// Provider Props
// =============================================================================

export interface AgenticProviderProps {
  /** SDK configuration */
  config: AgenticConfig;
  /** Children components */
  children: React.ReactNode;
}

// =============================================================================
// Provider Component
// =============================================================================

/**
 * Root provider component for the ARCAAI Agentic SDK.
 *
 * Wraps your application and provides SDK functionality via hooks.
 *
 * @example
 * ```tsx
 * const config = {
 *   api: { baseUrl: 'https://api.arcaai.com', apiKey: 'your-key' },
 *   audio: { noiseFilter: true, vad: true, stt: true },
 *   logging: {
 *     level: 'debug',
 *     highlight: { enabled: true, projectId: 'YOUR_PROJECT_ID' },
 *     otel: { enabled: true, endpoint: 'https://otel-collector.example.com' },
 *   },
 * };
 *
 * function App() {
 *   return (
 *     <AgenticProvider config={config}>
 *       <YourApp />
 *     </AgenticProvider>
 *   );
 * }
 * ```
 */
export function AgenticProvider({ config, children }: AgenticProviderProps) {
  const store = useAgenticStore();
  const loggerRef = useRef<SDKLogger | null>(null);

  // Keep a mutable ref to the latest config so the initialization effect
  // (which intentionally has [] deps) can read the most recent values.
  const configRef = useRef(config);
  configRef.current = config;

  // Initialize SDK on mount (supports React Strict Mode double-mount cycle)
  useEffect(() => {
    // Read the latest config from the ref — Zustand persist may have hydrated
    // between the first render and when this effect fires.
    const cfg = configRef.current;

    // Create logger first for observability
    const logger = createSDKLogger({
      level: cfg.logging?.level || (cfg.debug ? 'debug' : 'info'),
      debug: cfg.debug,
      serviceName: 'agentic-sdk',
      console: cfg.logging?.console ?? {
        enabled: true,
        colorize: cfg.debug,
        prettyPrint: cfg.debug,
      },
      highlight: cfg.logging?.highlight,
      loki: cfg.logging?.loki,
      otel: cfg.logging?.otel,
      redactFields: cfg.logging?.redactFields ?? ['apiKey', 'password', 'token', 'secret'],
      autoCorrelationId: cfg.logging?.autoCorrelationId ?? true,
    });
    loggerRef.current = logger;

    // Initialize logger transports asynchronously
    logger.initialize().catch((err) => {
      console.error('[AgenticProvider] Logger initialization failed:', err);
    });

    const providerLogger = logger.child('AgenticProvider');
    providerLogger.info('Initializing ARCAAI Agentic SDK', {
      operation: 'initialize',
      component: 'AgenticProvider',
      attributes: {
        baseUrl: cfg.api.baseUrl,
        hasTenantId: !!cfg.api.tenantId,
        audioEnabled: !!cfg.audio,
        personalizationStorage: cfg.personalization?.storage || 'local',
      },
    });

    // Create API client with logger
    const apiClient = new AgenticClient(cfg.api, logger.child('AgenticClient'));

    // Create plugin manager with audio config and apiClient (HOOK-02 fix)
    const audioConfig = cfg.audio ?? DEFAULT_AUDIO_CONFIG;
    const pluginManager = new PluginManager(audioConfig, logger.child('PluginManager'), apiClient, cfg.debug);

    // Create personalization manager
    const personalizationConfig = cfg.personalization ?? DEFAULT_PERSONALIZATION_CONFIG;
    const personalizationManager = new PersonalizationManager(
      personalizationConfig,
      apiClient,
      logger.child('PersonalizationManager')
    );

    // Create model registry
    const modelRegistry = new ModelRegistry(
      cfg.models ?? {},
      apiClient,
      logger.child('ModelRegistry')
    );

    // Initialize store
    store.initialize(
      cfg,
      apiClient,
      pluginManager,
      personalizationManager,
      modelRegistry,
      logger
    );

    // Initialize knowledge pipeline if NER is configured (NER-L-03 fix)
    // NER config lives under `plugins.ner` (PluginConfig), not `audio` (AudioPluginConfig).
    const nerConfig = cfg.plugins?.ner;
    if (nerConfig && nerConfig.enabled) {
      pluginManager.setNERConfig(nerConfig);
      const nerOp = providerLogger.startOperation('initKnowledgePipeline');
      pluginManager.initializeKnowledgePipeline().then(() => {
        nerOp.end(true);
        providerLogger.info('Knowledge pipeline initialized', {
          operation: 'initKnowledgePipeline',
          component: 'AgenticProvider',
          success: true,
        });
      }).catch((error) => {
        nerOp.error(error as Error);
        providerLogger.error('Failed to initialize knowledge pipeline', {
          operation: 'initKnowledgePipeline',
          component: 'AgenticProvider',
          error: error as Error,
        });
      });
    }

    // Start personalization sync if hybrid mode
    if (personalizationConfig.storage === 'hybrid') {
      personalizationManager.startSync();
      providerLogger.debug('Started hybrid personalization sync', {
        operation: 'startSync',
        attributes: { syncInterval: personalizationConfig.syncInterval },
      });
    }

    // Load preferences from backend if not local-only
    if (personalizationConfig.storage !== 'local') {
      const loadOp = providerLogger.startOperation('loadPreferences');
      personalizationManager.loadFromBackend().then(() => {
        store.setPreferences(personalizationManager.getPreferences());
        loadOp.end(true);
      }).catch((error) => {
        loadOp.error(error as Error, {
          attributes: { storage: personalizationConfig.storage },
        });
      });
    }

    // Load tenant configuration (server resolves tenant from JWT)
    const tenantOp = providerLogger.startOperation('loadTenantConfig');
    modelRegistry.loadTenantConfig().then((tenantConfig) => {
      store.setTenantConfig(tenantConfig);
      tenantOp.end(true, {
        attributes: {
          defaultSttModel: tenantConfig.defaultSttModel,
          features: tenantConfig.features,
        },
      });
    }).catch((error) => {
      tenantOp.error(error as Error);
    });

    // -----------------------------------------------------------------------
    // Three-tier ConfigManager (TASK-244)
    // -----------------------------------------------------------------------

    const configManager = new ConfigManager({
      onLoadUserPreferences: loadUserPreferencesFromStorage,
      onPersistUserPreferences: persistUserPreferencesToStorage,
    });

    store.setConfigManager(configManager);

    const unsubConfig = configManager.on('configChanged', (resolved) => {
      store.setResolvedConfig(resolved);
    });

    const configOp = providerLogger.startOperation('initConfigManager');
    (async () => {
      try {
        // Load tenant config overrides into tier 1.
        // The ModelRegistry's tenant config may carry audio/stt overrides
        // and locked paths — adapt them into the ConfigManager format.
        const tenantCfg = await modelRegistry.loadTenantConfig();
        const tenantOverrides: DeepPartial<AppConfig> = {};
        const lockedPaths: string[] = [];

        if (tenantCfg.defaultSttModel) {
          tenantOverrides.stt = { defaultModel: tenantCfg.defaultSttModel };
        }
        if (tenantCfg.features) {
          tenantOverrides.features = tenantCfg.features as DeepPartial<AppConfig['features']>;
        }

        // If tenant config contains explicit locked paths, use them
        if ('lockedPaths' in tenantCfg && Array.isArray((tenantCfg as Record<string, unknown>).lockedPaths)) {
          lockedPaths.push(...(tenantCfg as Record<string, unknown>).lockedPaths as string[]);
        }

        configManager.setTenantConfig(tenantOverrides, lockedPaths);

        // Load user preferences into tier 2 (IndexedDB -> localStorage -> server)
        await configManager.loadUserPreferences();

        store.setResolvedConfig(configManager.getResolved());
        store.setConfigReady(true);
        configOp.end(true);
        providerLogger.info('ConfigManager initialized', {
          operation: 'initConfigManager',
          component: 'AgenticProvider',
          success: true,
        });
      } catch (error) {
        // Non-fatal: SDK still works with SYSTEM_DEFAULTS
        store.setResolvedConfig(configManager.getResolved());
        store.setConfigReady(true);
        configOp.error(error as Error);
        providerLogger.warn('ConfigManager partially initialized (using defaults)', {
          operation: 'initConfigManager',
          component: 'AgenticProvider',
          error: error as Error,
        });
      }
    })();

    // Subscribe to preference changes
    const unsubscribe = personalizationManager.onChange((prefs) => {
      store.setPreferences(prefs);
      providerLogger.debug('Preferences updated', {
        operation: 'preferencesChange',
        attributes: { preferenceKeys: Object.keys(prefs) },
      });
    });

    providerLogger.info('ARCAAI Agentic SDK initialized successfully', {
      operation: 'initialize',
      success: true,
      attributes: {
        correlationId: logger.getCorrelationId(),
        transports: logger.getTransportNames(),
      },
    });

    // Cleanup on unmount
    return () => {
      providerLogger.info('Shutting down ARCAAI Agentic SDK', {
        operation: 'shutdown',
        component: 'AgenticProvider',
      });
      unsubscribe();
      unsubConfig();
      personalizationManager.destroy();
      pluginManager.destroy();
      logger.flush().then(() => {
        logger.shutdown();
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Run once on mount.
  // Cleanup properly destroys managers; React Strict Mode re-mount recreates them.
  }, []);

  // Synchronously sync auth/tenant config to the existing AgenticClient on every
  // render, BEFORE children mount or their effects fire. A useEffect would be too
  // late — React fires child effects before parent effects, so a child's
  // useEffect (e.g. ConsultationList fetching data) would run with stale creds.
  const client = store.apiClient;
  if (client) {
    if (config.api.tenantId) {
      if (client.getTenantId() !== config.api.tenantId) {
        client.updateTenantId(config.api.tenantId);
      }
    } else if (client.getTenantId()) {
      client.clearTenantId();
    }

    // During impersonation the SDK holds an impersonation JWT on the client
    // that differs from the original token stored in the external config.
    // Syncing config.api.accessToken here would overwrite the impersonation
    // token and revert all API calls back to the original admin identity.
    const isImpersonating = store.authImpersonatedUser !== null;

    if (!isImpersonating) {
      if (config.api.accessToken) {
        if (client.getAccessToken() !== config.api.accessToken) {
          client.updateAccessToken(config.api.accessToken);
        }
      } else if (client.getAccessToken()) {
        client.clearAccessToken();
      }
    }

    if (config.api.apiKey) {
      if (client.getApiKey() !== config.api.apiKey) {
        client.updateApiKey(config.api.apiKey);
      }
    } else if (client.getApiKey()) {
      client.clearApiKey();
    }
  }

  // Context value with logger
  const contextValue = useMemo<AgenticContextValue>(
    () => ({
      initialized: store.initialized,
      config,
      logger: loggerRef.current || createSDKLogger({ level: 'info' }),
    }),
    [store.initialized, config]
  );

  return (
    <AgenticContext.Provider value={contextValue}>
      {children}
    </AgenticContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Access the Agentic context directly.
 *
 * Most users should use `useArca()` instead.
 */
export function useAgenticContext(): AgenticContextValue {
  const context = useContext(AgenticContext);
  if (!context) {
    throw new Error(
      'useAgenticContext must be used within an <AgenticProvider>'
    );
  }
  return context;
}

/**
 * Access the SDK logger directly.
 *
 * Use this hook to get access to the logger for custom logging in your components.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const logger = useSDKLogger();
 *
 *   useEffect(() => {
 *     logger.info('Component mounted', { component: 'MyComponent' });
 *   }, []);
 * }
 * ```
 */
export function useSDKLogger(): ISDKLogger {
  const context = useAgenticContext();
  return context.logger;
}
