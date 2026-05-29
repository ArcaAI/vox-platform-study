/**
 * @arcaai/vox - AgenticProvider
 *
 * Root provider component for the SDK.
 *
 * TASK-297 — DEF-C5, DEF-C6, DEF-H1, DEF-H4, DEF-H5, DEF-H6.
 *   - DEF-C6: `/auth/me` is preloaded before `configReady` flips. Without
 *             credentials, `/auth/me` is skipped entirely and both
 *             `profileReady` and `configReady` remain false.
 *   - DEF-H5: the tenant-config fetch promise is cached so we never
 *             fan out two HTTP calls per mount.
 *   - DEF-H1: IndexedDB and localStorage keys are namespaced
 *             `${tenantId}::${userId}` (or `pre-login` until /auth/me).
 *             A second effect re-hydrates ConfigManager when `authUser?.id`
 *             or `authImpersonatedUser` change.
 *   - DEF-C5: when `me.departmentId` is present, the department prompt
 *             config is fetched and applied via `setDepartmentConfig`.
 *   - DEF-H4: `PersonalizationManager.setConfigManager()` is wired so
 *             user-editable updates flow into the 4-tier cascade.
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
import { AUTH_ENDPOINTS, DEPARTMENT_ENDPOINTS } from '../core/constants';
// TASK-304 Wave 2D — single source of truth for the `arcaai-config` IDB
// schema (now v2 with `user-preferences` and `personalization` stores).
import { configDBGet, configDBSet, USER_PREFERENCES_STORE } from '../core/configDB';

// =============================================================================
// IndexedDB persistence helpers (TASK-244 / Task 1.5; namespaced in TASK-297 DEF-H1;
// schema delegated to `core/configDB` in TASK-304 Wave 2D)
// =============================================================================

const LS_NAMESPACE_PREFIX = 'arcaai-user-preferences/';

/**
 * Compose a `tenantId::userId` namespace for keying per-user persistence.
 * Falls back to `pre-login` when either id is missing.
 */
function makeNamespace(tenantId: string | null | undefined, userId: string | null | undefined): string {
  if (!tenantId || !userId) return 'pre-login';
  return `${tenantId}::${userId}`;
}

function makeIdbKey(namespace: string): string {
  return `user-preferences/${namespace}`;
}

function makeLsKey(namespace: string): string {
  return `${LS_NAMESPACE_PREFIX}${namespace}`;
}

/**
 * Build a load function bound to a namespace ref. The ref is read every
 * time so a single ConfigManager instance can follow a user-id change.
 */
function makeLoadUserPreferencesFromStorage(nsRef: { current: string }) {
  return async function loadUserPreferencesFromStorage(): Promise<DeepPartial<AppConfig> | null> {
    const ns = nsRef.current;
    try {
      const prefs = await configDBGet<DeepPartial<AppConfig>>(USER_PREFERENCES_STORE, makeIdbKey(ns));
      if (prefs) return prefs;
    } catch {
      // IDB unavailable — fall through to localStorage.
    }
    try {
      const raw = localStorage.getItem(makeLsKey(ns));
      if (raw) return JSON.parse(raw) as DeepPartial<AppConfig>;
    } catch {
      // LS unavailable.
    }
    return null;
  };
}

function makePersistUserPreferencesToStorage(nsRef: { current: string }) {
  return async function persistUserPreferencesToStorage(prefs: DeepPartial<AppConfig>): Promise<void> {
    const ns = nsRef.current;
    try {
      await configDBSet(USER_PREFERENCES_STORE, makeIdbKey(ns), prefs);
    } catch {
      try {
        localStorage.setItem(makeLsKey(ns), JSON.stringify(prefs));
      } catch {
        // Storage completely unavailable — silently degrade.
      }
    }
  };
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
 */
export function AgenticProvider({ config, children }: AgenticProviderProps) {
  const store = useAgenticStore();
  const loggerRef = useRef<SDKLogger | null>(null);
  const configManagerRef = useRef<ConfigManager | null>(null);
  const namespaceRef = useRef<string>('pre-login');
  const tenantConfigPromiseRef = useRef<Promise<unknown> | null>(null);

  // Keep a mutable ref to the latest config so the initialization effect
  // (which intentionally has [] deps) can read the most recent values.
  const configRef = useRef(config);
  configRef.current = config;

  // Initialize SDK on mount (supports React Strict Mode double-mount cycle)
  useEffect(() => {
    const cfg = configRef.current;

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

    const apiClient = new AgenticClient(cfg.api, logger.child('AgenticClient'));

    const audioConfig = cfg.audio ?? DEFAULT_AUDIO_CONFIG;
    const pluginManager = new PluginManager(audioConfig, logger.child('PluginManager'), apiClient, cfg.debug);

    const personalizationConfig = cfg.personalization ?? DEFAULT_PERSONALIZATION_CONFIG;
    // TASK-317 W1.1/W1.2 (AC-1/AC-4, review C-1) — the namespace starts at
    // `pre-login` (the user-id arrives later from /auth/me). PersonalizationManager
    // and ModelRegistry are handed a LIVE accessor over `namespaceRef`, so they
    // derive their browser-storage keys per access and follow the real
    // `${tenantId}::${userId}` once it is known — instead of capturing `pre-login`
    // by value at construction. The managers are re-hydrated after /auth/me
    // resolves (below) and on tenant/user switch (rehydrate effect). Mirrors the
    // `nsRef` closure already used for USER_PREFERENCES_STORE.
    namespaceRef.current = makeNamespace(cfg.api.tenantId, null);
    const nsAccessor = () => namespaceRef.current;
    const personalizationManager = new PersonalizationManager(personalizationConfig, apiClient, logger.child('PersonalizationManager'), nsAccessor);

    // TASK-304 Wave 2D — hydrate the IDB cache asynchronously. We don't
    // await here so the rest of init (which is mostly synchronous) is
    // unblocked; the onChange listener wired below picks up the merged
    // snapshot once hydration completes, and we explicitly push it into
    // PluginManager as soon as it lands.
    personalizationManager
      .hydrate()
      .then(() => {
        const cached = personalizationManager.getPreferences();
        store.setPreferences(cached);
        pluginManager.setUserPreferences(cached);
      })
      .catch((error) => {
        providerLogger.warn('Personalization IDB hydrate failed', {
          operation: 'hydratePersonalization',
          component: 'AgenticProvider',
          error: error as Error,
        });
      });

    // TASK-317 W1.5 (AC-4) — key the selected-models localStorage entry by the
    // same live `${tenantId}::${userId}` accessor; re-keyed after /auth/me.
    const modelRegistry = new ModelRegistry(cfg.models ?? {}, apiClient, logger.child('ModelRegistry'), nsAccessor);

    store.initialize(cfg, apiClient, pluginManager, personalizationManager, modelRegistry, logger);

    // Initialize knowledge pipeline if NER is configured (NER-L-03 fix)
    const nerConfig = cfg.plugins?.ner;
    if (nerConfig && nerConfig.enabled) {
      pluginManager.setNERConfig(nerConfig);
      const nerOp = providerLogger.startOperation('initKnowledgePipeline');
      pluginManager
        .initializeKnowledgePipeline()
        .then(() => {
          nerOp.end(true);
          providerLogger.info('Knowledge pipeline initialized', {
            operation: 'initKnowledgePipeline',
            component: 'AgenticProvider',
            success: true,
          });
        })
        .catch((error) => {
          nerOp.error(error as Error);
          providerLogger.error('Failed to initialize knowledge pipeline', {
            operation: 'initKnowledgePipeline',
            component: 'AgenticProvider',
            error: error as Error,
          });
        });
    }

    if (personalizationConfig.storage === 'hybrid') {
      personalizationManager.startSync();
      providerLogger.debug('Started hybrid personalization sync', {
        operation: 'startSync',
        attributes: { syncInterval: personalizationConfig.syncInterval },
      });
    }

    if (personalizationConfig.storage !== 'local') {
      const loadOp = providerLogger.startOperation('loadPreferences');
      personalizationManager
        .loadFromBackend()
        .then(() => {
          const loaded = personalizationManager.getPreferences();
          store.setPreferences(loaded);
          // TASK-304 Wave 2 W2-SDK-7 — refresh the PluginManager snapshot once
          // the DB-side preferences land so any pipeline built after this
          // moment uses the user's saved local-STT config.
          pluginManager.setUserPreferences(loaded);
          loadOp.end(true);
        })
        .catch((error) => {
          loadOp.error(error as Error, {
            attributes: { storage: personalizationConfig.storage },
          });
        });
    }

    // -----------------------------------------------------------------------
    // 4-tier ConfigManager + cascade init (TASK-244 + TASK-297 DEF-C5/C6/H1/H4/H5)
    // -----------------------------------------------------------------------

    // Namespace bootstrapped to `pre-login` above (TASK-317 W1.1/W1.2); the
    // managers follow `namespaceRef` lazily and are re-hydrated once /auth/me
    // resolves the real `${tenantId}::${userId}`.
    const configManager = new ConfigManager({
      onLoadUserPreferences: makeLoadUserPreferencesFromStorage(namespaceRef),
      onPersistUserPreferences: makePersistUserPreferencesToStorage(namespaceRef),
      logger: logger.child('ConfigManager'),
    });
    configManagerRef.current = configManager;
    store.setConfigManager(configManager);

    // TASK-297 DEF-H4 — wire the cascade sink so PersonalizationManager
    // forwards user-editable fields straight into ConfigManager.setUserValue.
    personalizationManager.setConfigManager(configManager);

    const unsubConfig = configManager.on('configChanged', (resolved) => {
      store.setResolvedConfig(resolved);
    });

    // TASK-297 DEF-H5 — cache the tenant-config promise so subsequent
    // consumers (this effect, ModelRegistry callers) share a single fetch.
    if (!tenantConfigPromiseRef.current) {
      tenantConfigPromiseRef.current = modelRegistry.loadTenantConfig();
    }
    const tenantConfigPromise = tenantConfigPromiseRef.current as Promise<Awaited<ReturnType<ModelRegistry['loadTenantConfig']>>>;

    const tenantOp = providerLogger.startOperation('loadTenantConfig');
    tenantConfigPromise
      .then((tenantConfig) => {
        store.setTenantConfig(tenantConfig);
        tenantOp.end(true, {
          attributes: {
            defaultSttModel: tenantConfig.defaultSttModel,
            features: tenantConfig.features,
          },
        });
      })
      .catch((error) => {
        tenantOp.error(error as Error);
      });

    const hasCredentials = !!(cfg.api.accessToken || cfg.api.apiKey);

    const configOp = providerLogger.startOperation('initConfigManager');
    const init = async () => {
      // TASK-297 DEF-C6 — without credentials we cannot call /auth/me, so
      // we deliberately leave `configReady` false. The companion effect
      // (auth user change) will rehydrate once credentials arrive.
      if (!hasCredentials) {
        providerLogger.info('No credentials at mount — skipping /auth/me; configReady stays false', {
          operation: 'initConfigManager',
          component: 'AgenticProvider',
        });
        return;
      }

      // ---- Step 1: preload /auth/me before flipping `configReady`.
      let me: { id?: string; tenantId?: string; departmentId?: string } | null = null;
      try {
        me = await apiClient.get<{ id?: string; tenantId?: string; departmentId?: string }>(AUTH_ENDPOINTS.ME);
      } catch (error) {
        providerLogger.warn('Profile preload (/auth/me) failed — configReady stays false', {
          operation: 'initConfigManager',
          component: 'AgenticProvider',
          error: error as Error,
        });
        configOp.error(error as Error);
        return;
      }

      if (me) {
        store.setAuthUser(me);
        store.setIsAuthenticated(true);
        store.setProfileReady(true);
        namespaceRef.current = makeNamespace(me.tenantId ?? cfg.api.tenantId, me.id);
        // TASK-317 W1.2 (AC-1/AC-4, review C-1) — the namespace is now the real
        // `${tenantId}::${userId}`. Re-key the managers (they read the live
        // accessor) and re-hydrate from the authenticated rows so a shared
        // workstation never serves the previous user's cached personalization
        // or model selection.
        modelRegistry.reloadSelected();
        try {
          await personalizationManager.hydrate();
          const rekeyed = personalizationManager.getPreferences();
          store.setPreferences(rekeyed);
          pluginManager.setUserPreferences(rekeyed);
        } catch {
          // `hydrate()` already logs at warn; keep init resilient.
        }
      }

      // ---- Step 2: apply tenant config from the cached promise.
      try {
        const tenantCfg = await tenantConfigPromise;
        const tenantOverrides: DeepPartial<AppConfig> = {};
        const lockedPaths: string[] = [];
        if (tenantCfg.defaultSttModel) {
          tenantOverrides.stt = { defaultModel: tenantCfg.defaultSttModel };
        }
        if (tenantCfg.features) {
          tenantOverrides.features = tenantCfg.features as DeepPartial<AppConfig['features']>;
        }
        if ('lockedPaths' in tenantCfg && Array.isArray((tenantCfg as Record<string, unknown>).lockedPaths)) {
          lockedPaths.push(...((tenantCfg as Record<string, unknown>).lockedPaths as string[]));
        }
        configManager.setTenantConfig(tenantOverrides, lockedPaths);
      } catch (error) {
        providerLogger.warn('Failed to apply tenant cascade tier (continuing)', {
          operation: 'initConfigManager',
          component: 'AgenticProvider',
          error: error as Error,
        });
      }

      // ---- Step 3 (DEF-C5): if a departmentId is present, fetch the
      // department prompt-config and apply tier 2.
      if (me?.departmentId) {
        try {
          const deptCfg = await apiClient.get<{
            overrides?: DeepPartial<AppConfig>;
            lockedPaths?: string[];
          }>(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(me.departmentId));
          if (deptCfg) {
            configManager.setDepartmentConfig(deptCfg.overrides ?? {}, deptCfg.lockedPaths ?? []);
          }
        } catch (error) {
          providerLogger.warn('Failed to apply department cascade tier (continuing)', {
            operation: 'initConfigManager',
            component: 'AgenticProvider',
            error: error as Error,
            attributes: { departmentId: me.departmentId },
          });
        }
      }

      // ---- Step 4: load user preferences (IDB -> LS) for the now-known namespace.
      try {
        await configManager.loadUserPreferences();
      } catch (error) {
        providerLogger.warn('configManager.loadUserPreferences threw', {
          operation: 'initConfigManager',
          component: 'AgenticProvider',
          error: error as Error,
        });
      }

      // ---- Step 5: publish resolved config and finally flip readiness.
      store.setResolvedConfig(configManager.getResolved());
      store.setConfigReady(true);
      configOp.end(true);
      providerLogger.info('ConfigManager initialized', {
        operation: 'initConfigManager',
        component: 'AgenticProvider',
        success: true,
      });
    };

    init().catch((error) => {
      configOp.error(error as Error);
      providerLogger.error('ConfigManager init crashed', {
        operation: 'initConfigManager',
        component: 'AgenticProvider',
        error: error as Error,
      });
    });

    // TASK-304 Wave 2 W2-SDK-7 — push user preferences (localConfig +
    // activeVoiceProfile) into PluginManager so the next pipeline build picks
    // them up and a running pipeline receives the delta live (language /
    // noise level / VAD sensitivity / reserved speaker).
    pluginManager.setUserPreferences(personalizationManager.getPreferences());

    const unsubscribe = personalizationManager.onChange((prefs) => {
      store.setPreferences(prefs);
      pluginManager.setUserPreferences(prefs);
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

    return () => {
      providerLogger.info('Shutting down ARCAAI Agentic SDK', {
        operation: 'shutdown',
        component: 'AgenticProvider',
      });
      unsubscribe();
      unsubConfig();
      personalizationManager.destroy();
      pluginManager.destroy();
      tenantConfigPromiseRef.current = null;
      configManagerRef.current = null;
      logger.flush().then(() => {
        logger.shutdown();
      });
    };
    // eslint-disable-next-line -- Run once on mount; cleanup recreates managers in Strict Mode.
  }, []);

  // ---------------------------------------------------------------------------
  // TASK-297 DEF-H1 — re-hydrate ConfigManager when the active user changes.
  // ---------------------------------------------------------------------------
  const authUser = store.authUser as { id?: string; tenantId?: string; departmentId?: string } | null;
  const impersonated = store.authImpersonatedUser as { id?: string; tenantId?: string; departmentId?: string } | null;
  const effectiveUserId = impersonated?.id ?? authUser?.id ?? null;
  const effectiveTenantId = impersonated?.tenantId ?? authUser?.tenantId ?? configRef.current.api.tenantId ?? null;
  const effectiveDepartmentId = impersonated?.departmentId ?? authUser?.departmentId ?? null;

  useEffect(() => {
    const configManager = configManagerRef.current;
    const apiClient = store.apiClient;
    if (!configManager || !apiClient) return;
    if (!effectiveUserId) return;

    const nextNamespace = makeNamespace(effectiveTenantId, effectiveUserId);
    if (namespaceRef.current === nextNamespace) return;
    namespaceRef.current = nextNamespace;

    const providerLogger = (loggerRef.current ?? createSDKLogger({ level: 'info' })).child('AgenticProvider');
    providerLogger.info('Rehydrating ConfigManager for new user namespace', {
      operation: 'rehydrateUserNamespace',
      component: 'AgenticProvider',
      attributes: { namespace: nextNamespace },
    });

    // TASK-317 W1.2 (AC-1/AC-4, review C-1) — managers read the live namespace
    // accessor; re-key them to the incoming namespace so a tenant/user switch
    // in the same tab reads the new user's rows (and writes under their
    // namespace), never the outgoing user's.
    const personalizationManager = store.personalizationManager;
    const modelRegistry = store.modelRegistry;

    (async () => {
      try {
        modelRegistry?.reloadSelected();
        if (personalizationManager) {
          await personalizationManager.hydrate();
          store.setPreferences(personalizationManager.getPreferences());
        }

        configManager.clearUserPreferences();
        await configManager.loadUserPreferences();

        if (effectiveDepartmentId) {
          try {
            const deptCfg = await apiClient.get<{
              overrides?: DeepPartial<AppConfig>;
              lockedPaths?: string[];
            }>(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(effectiveDepartmentId));
            if (deptCfg) {
              configManager.setDepartmentConfig(deptCfg.overrides ?? {}, deptCfg.lockedPaths ?? []);
            }
          } catch (error) {
            providerLogger.warn('Department rehydration failed', {
              operation: 'rehydrateUserNamespace',
              component: 'AgenticProvider',
              error: error as Error,
            });
          }
        } else {
          configManager.clearDepartmentConfig();
        }

        store.setResolvedConfig(configManager.getResolved());
        store.setConfigReady(true);
      } catch (error) {
        providerLogger.warn('Rehydration after user change failed', {
          operation: 'rehydrateUserNamespace',
          component: 'AgenticProvider',
          error: error as Error,
        });
      }
    })();
    // eslint-disable-next-line -- store is a stable singleton; rerun only on user identity change.
  }, [effectiveUserId, effectiveTenantId, effectiveDepartmentId]);

  // Synchronously sync auth/tenant config to the existing AgenticClient on every
  // render, BEFORE children mount or their effects fire.
  const client = store.apiClient;
  if (client) {
    if (config.api.tenantId) {
      if (client.getTenantId() !== config.api.tenantId) {
        client.updateTenantId(config.api.tenantId);
      }
    } else if (client.getTenantId()) {
      client.clearTenantId();
    }

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

  const contextValue = useMemo<AgenticContextValue>(
    () => ({
      initialized: store.initialized,
      config,
      logger: loggerRef.current || createSDKLogger({ level: 'info' }),
    }),
    [store.initialized, config],
  );

  return <AgenticContext.Provider value={contextValue}>{children}</AgenticContext.Provider>;
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
    throw new Error('useAgenticContext must be used within an <AgenticProvider>');
  }
  return context;
}

/**
 * Access the SDK logger directly.
 */
export function useSDKLogger(): ISDKLogger {
  const context = useAgenticContext();
  return context.logger;
}
