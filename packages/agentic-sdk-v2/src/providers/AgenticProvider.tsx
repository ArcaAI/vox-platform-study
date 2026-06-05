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
import type { RefreshTokenResponse } from '../types/auth';
import { AgenticClient } from '../core/AgenticClient';
import { PluginManager } from '../core/PluginManager';
import { PersonalizationManager } from '../core/PersonalizationManager';
import { ModelRegistry } from '../core/ModelRegistry';
import { ConfigManager } from '../core/ConfigManager';
import type { AppConfig, DeepPartial } from '../core/ConfigSchema';
import { createSDKLogger, type SDKLogger, type ISDKLogger } from '../core/logger';
import { useStore } from 'zustand';
import { createAgenticStore, AgenticStoreContext, type AgenticStoreApi } from '../store';
import { DEFAULT_AUDIO_CONFIG, DEFAULT_PERSONALIZATION_CONFIG } from '../types';
import { AUTH_ENDPOINTS, DEPARTMENT_ENDPOINTS, USER_SETTINGS_ENDPOINTS } from '../core/constants';
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
// Server persistence (TASK-331 doc-07 F5a)
//
// ADDITIVE server sync of the user-pref tier. SDK prefs live under the
// server-owned `arcaai-sdk` namespace with DOT-PATH keys (e.g. `stt.language`),
// mirroring the read path (GET /user/me/settings → reconstruct by splitting the
// key on `.`) and the existing `selectedPipelineId` persistence in usePipelines.
// =============================================================================

/** Namespace SDK user-preferences are stored under (matches usePipelines). */
const SDK_SETTINGS_NAMESPACE = 'arcaai-sdk';

/**
 * Debounce window for the server sync. Rapid edits (e.g. dragging a slider or
 * toggling several flags) coalesce into a single round of PATCHes carrying the
 * latest values.
 */
const SERVER_PREF_SYNC_DEBOUNCE_MS = 500;

/**
 * `dataType` sent on `PATCH /user/me/settings/:ns/:key`. These are the
 * server's `ValueType` enum members (PascalCase) — the WRITE DTO validates
 * with `@IsEnum(ValueType)`, and the read-side reconstruction upper-cases the
 * stored type before comparing, so they round-trip correctly.
 */
type ServerPrefDataType = 'String' | 'Boolean' | 'Integer' | 'Float';

interface ServerPrefLeaf {
  /** Dot-path key, e.g. `stt.language`. */
  key: string;
  /** Stringified value (the server column is a string). */
  value: string;
  dataType: ServerPrefDataType;
}

/**
 * Flatten the (nested) user-pref tier into dot-path leaves with a stringified
 * value + inferred `dataType`. Objects recurse; arrays / null / undefined are
 * skipped (the user-pref tier has no array leaves).
 */
function flattenUserPrefsToLeaves(prefs: DeepPartial<AppConfig>, prefix = ''): ServerPrefLeaf[] {
  const leaves: ServerPrefLeaf[] = [];
  for (const [key, value] of Object.entries(prefs)) {
    if (value === undefined || value === null) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      leaves.push(...flattenUserPrefsToLeaves(value as DeepPartial<AppConfig>, path));
    } else if (typeof value === 'boolean') {
      leaves.push({ key: path, value: String(value), dataType: 'Boolean' });
    } else if (typeof value === 'number') {
      leaves.push({ key: path, value: String(value), dataType: Number.isInteger(value) ? 'Integer' : 'Float' });
    } else if (typeof value === 'string') {
      leaves.push({ key: path, value, dataType: 'String' });
    }
    // Other types (arrays, etc.) are intentionally not synced.
  }
  return leaves;
}

/**
 * Build a debounced server-sync persist callback. Flattens the user-pref tier
 * and PATCHes each leaf to `/user/me/settings/arcaai-sdk/{dotPath}`. Each PATCH
 * is best-effort: a failure is logged and the loop continues, and nothing here
 * ever throws (a failed sync must not break local-storage persistence).
 *
 * Gating to "not impersonating" is handled by ConfigManager's read-only
 * short-circuit (TASK-245) at SCHEDULE time, AND re-checked here at FLUSH time
 * via `isReadOnly()`: because the sync is debounced, an edit scheduled by the
 * admin just before impersonation starts must not have its pending PATCH land
 * on the impersonated user's profile.
 */
function makePersistUserPreferencesToServer(apiClient: AgenticClient, logger: ISDKLogger, isReadOnly: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: DeepPartial<AppConfig> | null = null;

  const flush = async (): Promise<void> => {
    timer = null;
    const prefs = pending;
    pending = null;
    if (!prefs) return;
    // Re-check at flush time — impersonation may have started during the
    // debounce window (the admin's pending edit must never reach the server
    // under the impersonation JWT).
    if (isReadOnly()) return;
    for (const leaf of flattenUserPrefsToLeaves(prefs)) {
      try {
        await apiClient.patch(USER_SETTINGS_ENDPOINTS.updateByKey(SDK_SETTINGS_NAMESPACE, leaf.key), {
          value: leaf.value,
          dataType: leaf.dataType,
        });
      } catch (error) {
        logger.warn('Failed to sync user preference to server', {
          operation: 'persistUserPreferencesToServer',
          component: 'AgenticProvider',
          error: error as Error,
          attributes: { key: leaf.key },
        });
      }
    }
  };

  return async function persistUserPreferencesToServer(prefs: DeepPartial<AppConfig>): Promise<void> {
    pending = prefs;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, SERVER_PREF_SYNC_DEBOUNCE_MS);
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
  // TASK-317 W4.2 (AC-12) — own ONE isolated store instance per provider mount
  // (lazy-init into a ref so it survives re-renders) instead of the shared
  // module singleton. Each concurrent tenant in a multi-tenant tree therefore
  // gets independent state (audit C-1). The instance is published via
  // `AgenticStoreContext` below so descendant hooks bind to THIS store; the
  // provider's own reactive reads use `useStore(storeApi)`, and its imperative
  // writes / the managers it wires go through `storeApi.getState()` (same
  // `store.*` accessor as before — the slice/action calls are unchanged).
  const storeRef = useRef<AgenticStoreApi | null>(null);
  if (!storeRef.current) {
    storeRef.current = createAgenticStore();
  }
  const storeApi = storeRef.current;
  const store = useStore(storeApi);
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

    // TASK-317 W5.3 (AC-16 / audit E-1): the `console` path here is the
    // INTENDED fail-safe base case, not an incidental error handler.
    //
    // `createSDKLogger` installs a ConsoleTransport by default (unless a
    // consumer opts out via `config.logging.console.enabled = false`) whose
    // `initialize()` is a guaranteed no-op (see console.transport.ts), so it
    // can never fail and is functional regardless of `logger.initialize()`.
    // Only the OPTIONAL remote transports (highlight / loki / otel) perform
    // async init that can reject (network / SDK-load failures); this `.catch`
    // contains any such rejection so it can never throw past the provider
    // effect, while the console transport keeps logging. At runtime,
    // `SDKLogger.dispatch()` likewise wraps every per-entry `transport.log()`
    // in try/catch → `console.error`, so a transport that breaks later
    // degrades to console rather than throwing. A separate fallback transport
    // is therefore deliberately NOT wired — the console transport already
    // serves as the base sink.
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
    const configManagerLogger = logger.child('ConfigManager');
    const configManager = new ConfigManager({
      onLoadUserPreferences: makeLoadUserPreferencesFromStorage(namespaceRef),
      onPersistUserPreferences: makePersistUserPreferencesToStorage(namespaceRef),
      // TASK-331 doc-07 F5a — additive, debounced server sync. ConfigManager's
      // read-only short-circuit (TASK-245) keeps this from firing while the
      // playground impersonates, so impersonated edits never reach the server;
      // the flush-time `isReadOnly` re-check also covers the debounce window.
      onPersistUserPreferencesToServer: makePersistUserPreferencesToServer(
        apiClient,
        configManagerLogger,
        () => configManagerRef.current?.isReadOnly() ?? false,
      ),
      logger: configManagerLogger,
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
        // TASK-332 — surface the server-computed effective local raw-capture
        // flag as a tenant-tier override. It is admin-owned in CONFIG_PERMISSIONS,
        // so the cascade's stripLockedAndAdminPaths prevents user prefs from
        // overriding it; the panel reads resolvedConfig.audio.captureRawAudio.
        if (tenantCfg.captureRawAudio !== undefined) {
          tenantOverrides.audio = { ...(tenantOverrides.audio ?? {}), captureRawAudio: tenantCfg.captureRawAudio };
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

    // TASK-317 W2.1 (AC-7, audit C-5; review C-1) — reset the OUTGOING tenant's
    // FULL PHI/session set SYNCHRONOUSLY, the instant the effective tenant/user
    // changes and BEFORE the async re-hydrate below resolves the new tenant's
    // config. This closes the window where tenant B is already active in the
    // same tab while tenant A's PHI — consultation, relatedConsultations,
    // contextItems, sharedContext, entities (medical NER), currentTranscript
    // (raw transcript), transcriptSegments, summaries, dnaStyle — plus the
    // tenant-scoped model/audio config (tenantConfig) remain resident and
    // visible through useArca()/useArcaConfig(). `clearTenantSessionData()` is
    // the single source of truth for that set and DELIBERATELY does NOT touch
    // auth/impersonation (authUser / authImpersonatedUser / effectiveTenantId),
    // which drive this in-flight switch. Uses the store API the provider already
    // holds (rule 08-vox-sdk: access via the store, never import it directly).
    // The registry selection itself is re-keyed by `modelRegistry.reloadSelected()`
    // (below); `incrementModelRegistryVersion()` refreshes the model config that
    // `useArcaConfig` surfaces so consumers stop rendering tenant A's data.
    store.clearTenantSessionData();

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
        // TASK-317 W2.1 (AC-7) — `reloadSelected()` replaced the registry's
        // in-memory selection with the incoming namespace's (or empty); bump
        // the version so the `useArcaConfig` `models` memo recomputes and
        // consumers immediately stop rendering the previous tenant's selection.
        store.incrementModelRegistryVersion();

        // TASK-317 W2.1 (review M-2) — `clearTenantSessionData()` nulled
        // `tenantConfig` synchronously above, but the mount-time
        // `loadTenantConfig()` promise resolved the OUTGOING tenant's audio/AI
        // config and is never re-run on a same-tab switch. Re-fetch the INCOMING
        // tenant's config (the apiClient now carries the switched identity, the
        // same assumption the department fetch below relies on) and refresh the
        // shared promise ref so `useArcaConfig().tenantConfig` reflects tenant B
        // instead of staying null until a remount. The extra version bump
        // publishes any tenant-default model the reload applied. Isolated in its
        // own try/catch (mirrors the department block) so a config-fetch failure
        // never blocks `configReady`.
        if (modelRegistry) {
          try {
            const nextTenantConfigPromise = modelRegistry.loadTenantConfig();
            tenantConfigPromiseRef.current = nextTenantConfigPromise;
            store.setTenantConfig(await nextTenantConfigPromise);
            store.incrementModelRegistryVersion();
          } catch (error) {
            providerLogger.warn('Tenant config reload after switch failed', {
              operation: 'rehydrateUserNamespace',
              component: 'AgenticProvider',
              error: error as Error,
            });
          }
        }

        if (personalizationManager) {
          await personalizationManager.hydrate();
          store.setPreferences(personalizationManager.getPreferences());
        }

        // TASK-331 doc-05 F-2 — while impersonating, the playground is the SINGLE
        // writer of the user-pref tier: it loads the impersonated user's REAL
        // backend prefs (GET /user/me/settings via the doctor JWT) read-only.
        // `loadUserPreferences()` is LOCAL-IDB-ONLY (the impersonated user has no
        // namespace on the admin's machine) and `clearUserPreferences()` wipes the
        // tier — running either here would race with / clobber those backend prefs
        // (whichever async resolves last wins). Skip ONLY the user-pref clear/load
        // while impersonating; the tenant-session reset, model-registry reload,
        // tenant config and DEPARTMENT tier (F-9) above still run. On END
        // impersonation `effectiveUserId` reverts to the admin and this effect
        // re-runs (impersonated === null) to reload the admin's own namespace.
        if (!impersonated) {
          configManager.clearUserPreferences();
          await configManager.loadUserPreferences();
        }

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
    // eslint-disable-next-line -- store actions are stable (per-provider instance); rerun only on user identity change.
  }, [effectiveUserId, effectiveTenantId, effectiveDepartmentId]);

  // ---------------------------------------------------------------------------
  // TASK-320 B2 — auto-wire the 401→refresh single-flight handler.
  //
  // `AgenticClient` already implements a 401→refresh-once mutex
  // (`deduplicatedRefresh`/`setOnUnauthorized`), but it only fires when a
  // handler is registered — and nothing in the SDK ever registered one, so
  // auto-refresh was inert. We register it HERE so token refresh works out of
  // the box. The backend `/auth/refresh` is BODY-based (see
  // apps/api auth.controller `refresh()`), so the handler POSTs the in-memory
  // refresh token captured at login (AgenticClient WeakMap), applies the
  // rotated access + refresh tokens, and returns true so the original request
  // is retried once.
  //
  // Registered in a guarded effect keyed on the client instance so it runs
  // ONCE per AgenticClient (not on every render). `/auth/refresh` is in
  // `AgenticClient.REFRESH_SKIP_ENDPOINTS`, so the refresh POST itself can't
  // recurse into another refresh. We skip refresh while impersonating: the
  // active token is the short-lived impersonation JWT and the stored refresh
  // token belongs to the admin's own session — refreshing here would mint an
  // admin access token and silently clobber the impersonation token/state, so
  // we return false and let the 401 propagate (mirrors the `if (!isImpersonating)`
  // access-token special-casing in the sync block below).
  // ---------------------------------------------------------------------------
  const refreshWiredForClientRef = useRef<AgenticClient | null>(null);
  useEffect(() => {
    const apiClient = store.apiClient;
    if (!apiClient) return;
    // TASK-331 doc-05 F-5 — a host that owns its own 401 handling can opt out
    // (e.g. ui-playground's impersonation-aware `useAutoRefresh`), leaving the
    // single-slot `setOnUnauthorized` a single deterministic owner. Default
    // (undefined / true) preserves the B2 auto-refresh. Read via `configRef`
    // so this guarded, client-keyed effect doesn't re-run on config identity.
    if (configRef.current.autoWireTokenRefresh === false) return;
    if (refreshWiredForClientRef.current === apiClient) return;
    refreshWiredForClientRef.current = apiClient;

    apiClient.setOnUnauthorized(async (): Promise<boolean> => {
      if (apiClient.isImpersonating()) return false;
      const refreshToken = apiClient.getRefreshToken();
      if (!refreshToken) return false;
      try {
        const data = await apiClient.post<RefreshTokenResponse>(AUTH_ENDPOINTS.REFRESH, { refreshToken });
        if (!data?.token) return false;
        apiClient.updateAccessToken(data.token);
        // Rotate the in-memory refresh token (backend refresh tokens are
        // single-use — TASK-307 W1.3) so the next 401 can refresh again.
        if (data.refreshToken) {
          apiClient.setRefreshToken(data.refreshToken);
        }
        return true;
      } catch {
        return false;
      }
    });
  }, [store.apiClient]);

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

  // TASK-317 W4.2 (AC-12) — publish the per-provider store instance so every
  // descendant hook (`useArca`, `useArcaConfig`, …) binds to THIS tenant's
  // store via `useStoreApi()`/the context-backed `useAgenticStore`, never the
  // module singleton.
  return (
    <AgenticStoreContext.Provider value={storeApi}>
      <AgenticContext.Provider value={contextValue}>{children}</AgenticContext.Provider>
    </AgenticStoreContext.Provider>
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
