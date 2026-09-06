/**
 * @arcaai/vox - AgenticProvider
 *
 * Root provider component for the SDK.
 *
 * Key behaviors:
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
import { createSDKLogger, installGlobalCapture, type SDKLogger, type ISDKLogger } from '../core/logger';
import { useStore } from 'zustand';
import { createAgenticStore, AgenticStoreContext, type AgenticStoreApi } from '../store';
import { DEFAULT_AUDIO_CONFIG, DEFAULT_PERSONALIZATION_CONFIG } from '../types';
import { AUTH_ENDPOINTS, PERSONALIZATION_ENDPOINTS, USER_SETTINGS_ENDPOINTS } from '../core/constants';
// Single source of truth for the `arcaai-config` IDB
// schema (now v2 with `user-preferences` and `personalization` stores).
import { configDBGet, configDBSet, USER_PREFERENCES_STORE } from '../core/configDB';
// Schema discovery, fetched exactly like `modelRegistry.loadTenantConfig()` below.
import { fetchConsultationSchema } from '../core/ConsultationSchemaClient';
import type { ConsultationSchemaBundle } from '../types/consultationSchema';

// =============================================================================
// IndexedDB persistence helpers (namespaced per tenant/user;
// schema delegated to `core/configDB`)
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
// Server persistence
//
// ADDITIVE server sync of the user-pref tier. SDK prefs live under the
// server-owned `arcaai-sdk` namespace with DOT-PATH keys (e.g. `stt.language`),
// mirroring the read path (GET /users/me/settings → reconstruct by splitting the
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
 * `dataType` sent on `PATCH /users/me/settings/:ns/:key`. These are the
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
 * and PATCHes each leaf to `/users/me/settings/arcaai-sdk/{dotPath}`. Each PATCH
 * is best-effort: a failure is logged and the loop continues, and nothing here
 * ever throws (a failed sync must not break local-storage persistence).
 *
 * Gating to "not impersonating" is handled by ConfigManager's read-only
 * short-circuit at SCHEDULE time, AND re-checked here at FLUSH time
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
  // Own ONE isolated store instance per provider mount
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
  // Cached exactly like `tenantConfigPromiseRef` so mount and a
  // subsequent tenant switch each fan out at most one discovery-bundle fetch.
  const consultationSchemaPromiseRef = useRef<Promise<ConsultationSchemaBundle> | null>(null);

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
      clarity: cfg.logging?.clarity,
      loki: cfg.logging?.loki,
      otel: cfg.logging?.otel,
      redactFields: cfg.logging?.redactFields ?? ['apiKey', 'password', 'token', 'secret'],
      autoCorrelationId: cfg.logging?.autoCorrelationId ?? true,
    });
    loggerRef.current = logger;

    // The `console` path here is the
    // INTENDED fail-safe base case, not an incidental error handler.
    //
    // `createSDKLogger` installs a ConsoleTransport by default (unless a
    // consumer opts out via `config.logging.console.enabled = false`) whose
    // `initialize()` is a guaranteed no-op (see console.transport.ts), so it
    // can never fail and is functional regardless of `logger.initialize()`.
    // Only the OPTIONAL remote transports (highlight / clarity / loki / otel) perform
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

    // Bridge browser-wide telemetry (console.*, uncaught errors, unhandled
    // rejections) into the transport pipeline. Installed synchronously so
    // failures during the rest of provider setup are already captured.
    // `console` capture is opt-in; global error capture is on by default.
    const uninstallGlobalCapture = installGlobalCapture(logger, {
      console: cfg.logging?.capture?.console,
      consoleMethods: cfg.logging?.capture?.consoleMethods,
      globalErrors: cfg.logging?.capture?.globalErrors,
      maxArgLength: cfg.logging?.capture?.maxArgLength,
      maxEventsPerMinute: cfg.logging?.capture?.maxEventsPerMinute,
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
    // The namespace starts at
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

    // Hydrate the IDB cache asynchronously. We don't
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

    // Key the selected-models localStorage entry by the
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

    // Capture the backend-preferences load so init() can await
    // it and read the per-user resolved `remoteConfig.pipelineId` before the
    // first cascade resolve (see Step 2). Resolves even on failure so the
    // tenant tier still applies without the pipeline id.
    let preferencesLoadPromise: Promise<void> = Promise.resolve();
    if (personalizationConfig.storage !== 'local') {
      const loadOp = providerLogger.startOperation('loadPreferences');
      preferencesLoadPromise = personalizationManager
        .loadFromBackend()
        .then(() => {
          const loaded = personalizationManager.getPreferences();
          store.setPreferences(loaded);
          // Refresh the PluginManager snapshot once
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
    // 4-tier ConfigManager + cascade init
    // -----------------------------------------------------------------------

    // Namespace bootstrapped to `pre-login` above; the
    // managers follow `namespaceRef` lazily and are re-hydrated once /auth/me
    // resolves the real `${tenantId}::${userId}`.
    const configManagerLogger = logger.child('ConfigManager');
    const configManager = new ConfigManager({
      onLoadUserPreferences: makeLoadUserPreferencesFromStorage(namespaceRef),
      onPersistUserPreferences: makePersistUserPreferencesToStorage(namespaceRef),
      // Additive, debounced server sync. ConfigManager's
      // read-only short-circuit keeps this from firing while the
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

    // Wire the cascade sink so PersonalizationManager
    // forwards user-editable fields straight into ConfigManager.setUserValue.
    personalizationManager.setConfigManager(configManager);

    const unsubConfig = configManager.on('configChanged', (resolved) => {
      store.setResolvedConfig(resolved);
    });

    // Cache the tenant-config promise so subsequent
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

    // Cache the consultation context schema discovery-bundle fetch
    // exactly like `tenantConfigPromise` above: kicked off once here so the
    // store is populated as soon as it resolves even if `init()` below never
    // runs (no credentials), then awaited AGAIN inside `init()` before
    // `configReady` flips (Step 4.5), so a consumer that sees `configReady`
    // can trust `consultationSchema` is already settled. `fetchConsultationSchema`
    // never rejects — a schema-plane outage resolves to the safe "unconfigured"
    // bundle rather than blocking readiness.
    if (!consultationSchemaPromiseRef.current) {
      consultationSchemaPromiseRef.current = fetchConsultationSchema(apiClient, providerLogger);
    }
    const consultationSchemaPromise = consultationSchemaPromiseRef.current;
    consultationSchemaPromise.then((bundle) => {
      // A DEPARTMENT-scoped re-fetch (kicked once `me.departmentId`
      // is known in Step 1 below) may already have superseded this
      // tenant-scoped default in the ref. Guard so a late-resolving
      // tenant-scoped response can never clobber the more specific one.
      if (consultationSchemaPromiseRef.current === consultationSchemaPromise) {
        store.setConsultationSchema(bundle);
      }
    });

    const hasCredentials = !!(cfg.api.accessToken || cfg.api.apiKey);

    const configOp = providerLogger.startOperation('initConfigManager');
    const init = async () => {
      // Without credentials we cannot call /auth/me, so
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

      // Once `me.departmentId` is known, prefer a
      // DEPARTMENT-scoped schema bundle over the tenant-scoped default kicked
      // off eagerly above (before `me` was known, to cover the no-credentials
      // path where init() never reaches this line). The discovery endpoint
      // resolves DEPARTMENT -> TENANT, so a department-scoped bundle is
      // always a safe, more specific choice when a department is known;
      // falls back to the tenant-scoped promise otherwise (D-2 behaviour
      // unchanged for the no-department case).
      let effectiveSchemaPromise = consultationSchemaPromise;
      if (me?.departmentId) {
        const departmentSchemaPromise = fetchConsultationSchema(apiClient, providerLogger, {
          departmentId: me.departmentId,
        });
        consultationSchemaPromiseRef.current = departmentSchemaPromise;
        effectiveSchemaPromise = departmentSchemaPromise;
        departmentSchemaPromise.then((bundle) => {
          if (consultationSchemaPromiseRef.current === departmentSchemaPromise) {
            store.setConsultationSchema(bundle);
          }
        });
      }

      if (me) {
        store.setAuthUser(me);
        store.setIsAuthenticated(true);
        store.setProfileReady(true);
        namespaceRef.current = makeNamespace(me.tenantId ?? cfg.api.tenantId, me.id);
        // The namespace is now the real
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
        // Surface the server-computed effective local raw-capture
        // flag as a tenant-tier override. It is admin-owned in CONFIG_PERMISSIONS,
        // so the cascade's stripLockedAndAdminPaths prevents user prefs from
        // overriding it; the panel reads resolvedConfig.audio.captureRawAudio.
        if (tenantCfg.captureRawAudio !== undefined) {
          tenantOverrides.audio = { ...(tenantOverrides.audio ?? {}), captureRawAudio: tenantCfg.captureRawAudio };
        }
        // The assigned remote ASR pipeline is resolved per-user
        // server-side (per-user admin override -> tenant default -> global) and
        // returned on GET /users/me/preferences as `remoteConfig.pipelineId`.
        // Surface it as an admin-owned tenant-tier override
        // (stt.transcriptionPipelineId is permission:'admin' in
        // CONFIG_PERMISSIONS), so the cascade's stripLockedAndAdminPaths keeps
        // it authoritative against user prefs and the consultation panel runs
        // the correct pipeline instead of DEFAULT_TRANSCRIPTION_PIPELINE_ID.
        // Awaiting the in-flight backend-prefs load (started above) adds no new
        // request and only blocks the tier on a fetch the SDK already issues.
        try {
          await preferencesLoadPromise;
          const resolvedPrefs = personalizationManager.getPreferences();
          const remotePipelineId = resolvedPrefs.remoteConfig?.pipelineId;
          if (remotePipelineId) {
            tenantOverrides.stt = { ...(tenantOverrides.stt ?? {}), transcriptionPipelineId: remotePipelineId };
          }
          // The EFFECTIVE transcription mode is resolved per-user
          // server-side and returned on the prefs response. Surface it as an
          // admin-owned tenant-tier override (stt.transcriptionMode is
          // permission:'admin') so the cascade keeps it authoritative against
          // user prefs and the clinical workspace branches LOCAL vs BACKEND.
          if (resolvedPrefs.transcriptionMode) {
            tenantOverrides.stt = { ...(tenantOverrides.stt ?? {}), transcriptionMode: resolvedPrefs.transcriptionMode };
          }
        } catch {
          // loadFromBackend already logs at error; the tenant tier still
          // applies — the panel just falls back to its default pipeline id.
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

      // ---- Step 3 (DEF-C5): the department tier is NOT applied.
      // It never was: the read targeted `GET admin/departments/:id/prompt-config`,
      // a route the gateway does not serve (it serves the PATCH alone), so every
      // call 404'd into the catch below and the tier stayed empty. TASK-890's
      // wave-3 close removed the dead read rather than leave the SDK claiming a
      // cascade tier it cannot resolve; restoring it needs a self-scoped READ
      // route on the gateway first (§8 follow-up) — an admin-plane path is
      // refused outright by `AgenticClient` now (OD-F/OD-K).

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

      // ---- Step 4.5 (department-scoped): resolve the
      // pinned consultation context schema before `configReady` flips, so a
      // client's first render already has the tenant's (or department's)
      // context-kind vocabulary (or the safe "unconfigured" bundle) to build
      // its workflow from — mirrors Step 2's `tenantConfigPromise` await.
      // Awaits `effectiveSchemaPromise` (the department-scoped fetch when
      // Step 1 found `me.departmentId`, otherwise the tenant-scoped default).
      // `fetchConsultationSchema` never rejects, so this try/catch is
      // defensive-only, matching this function's style.
      try {
        const schemaBundle = await effectiveSchemaPromise;
        store.setConsultationSchema(schemaBundle);
      } catch (error) {
        providerLogger.warn('Failed to apply consultation context schema (continuing without one)', {
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

    // Push user preferences (localConfig +
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
      uninstallGlobalCapture();
      unsubscribe();
      unsubConfig();
      personalizationManager.destroy();
      pluginManager.destroy();
      tenantConfigPromiseRef.current = null;
      consultationSchemaPromiseRef.current = null;
      configManagerRef.current = null;
      logger.flush().then(() => {
        logger.shutdown();
      });
    };
    // Deps intentionally narrowed: Run once on mount; cleanup recreates managers in Strict Mode.
  }, []);

  // ---------------------------------------------------------------------------
  // Re-hydrate ConfigManager when the active user changes.
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

    // Reset the OUTGOING tenant's
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

    // Managers read the live namespace
    // accessor; re-key them to the incoming namespace so a tenant/user switch
    // in the same tab reads the new user's rows (and writes under their
    // namespace), never the outgoing user's.
    const personalizationManager = store.personalizationManager;
    const modelRegistry = store.modelRegistry;

    (async () => {
      try {
        modelRegistry?.reloadSelected();
        // `reloadSelected()` replaces the registry's
        // in-memory selection with the incoming namespace's (or empty); bump
        // the version so the `useArcaConfig` `models` memo recomputes and
        // consumers immediately stop rendering the previous tenant's selection.
        store.incrementModelRegistryVersion();

        // `clearTenantSessionData()` nulls
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
            const nextTenantCfg = await nextTenantConfigPromise;
            store.setTenantConfig(nextTenantCfg);
            store.incrementModelRegistryVersion();

            // Re-apply the CASCADE tenant tier for
            // the INCOMING identity. The mount-time init() (deps []) is the only
            // other place that calls `configManager.setTenantConfig`, and it
            // injects the per-user server-resolved remote ASR pipeline
            // (`remoteConfig.pipelineId` from GET /users/me/preferences) into
            // `stt.transcriptionPipelineId`. init() runs ONCE with the MOUNTING
            // identity (e.g. the admin), so on a same-tab user/impersonation
            // switch the cascade kept the previous user's tenant tier — leaving
            // `stt.transcriptionPipelineId` empty for the switched-in user, so the
            // consultation/clinical panels fell back to
            // DEFAULT_TRANSCRIPTION_PIPELINE_ID (a SYSTEM pipeline that 404s for a
            // customer tenant). Re-fetch the incoming user's resolved pipeline and
            // rebuild the tier here. This GET is read-only and does NOT write the
            // personalization user-pref tier, so it never races the playground's
            // single-writer impersonation prefs (F-2 below).
            let remotePipelineId: string | undefined;
            let effectiveTranscriptionMode: 'LOCAL' | 'BACKEND' | undefined;
            try {
              const remotePrefs = await apiClient.get<{
                remoteConfig?: { pipelineId?: string };
                transcriptionMode?: 'LOCAL' | 'BACKEND';
              }>(PERSONALIZATION_ENDPOINTS.GET_PREFERENCES);
              remotePipelineId = remotePrefs?.remoteConfig?.pipelineId;
              effectiveTranscriptionMode = remotePrefs?.transcriptionMode;
            } catch (error) {
              providerLogger.warn('Remote pipeline fetch after user switch failed', {
                operation: 'rehydrateUserNamespace',
                component: 'AgenticProvider',
                error: error as Error,
              });
            }
            const nextTenantOverrides: DeepPartial<AppConfig> = {};
            const nextLockedPaths: string[] = [];
            if (nextTenantCfg.defaultSttModel) {
              nextTenantOverrides.stt = { defaultModel: nextTenantCfg.defaultSttModel };
            }
            if (nextTenantCfg.features) {
              nextTenantOverrides.features = nextTenantCfg.features as DeepPartial<AppConfig['features']>;
            }
            if (nextTenantCfg.captureRawAudio !== undefined) {
              nextTenantOverrides.audio = { ...(nextTenantOverrides.audio ?? {}), captureRawAudio: nextTenantCfg.captureRawAudio };
            }
            if (remotePipelineId) {
              nextTenantOverrides.stt = { ...(nextTenantOverrides.stt ?? {}), transcriptionPipelineId: remotePipelineId };
            }
            // Re-apply the switched-in user's effective transcription mode.
            if (effectiveTranscriptionMode) {
              nextTenantOverrides.stt = { ...(nextTenantOverrides.stt ?? {}), transcriptionMode: effectiveTranscriptionMode };
            }
            if ('lockedPaths' in nextTenantCfg && Array.isArray((nextTenantCfg as Record<string, unknown>).lockedPaths)) {
              nextLockedPaths.push(...((nextTenantCfg as Record<string, unknown>).lockedPaths as string[]));
            }
            configManager.setTenantConfig(nextTenantOverrides, nextLockedPaths);
          } catch (error) {
            providerLogger.warn('Tenant config reload after switch failed', {
              operation: 'rehydrateUserNamespace',
              component: 'AgenticProvider',
              error: error as Error,
            });
          }
        }

        // Re-fetch the consultation context schema discovery
        // bundle for the INCOMING identity. `clearTenantSessionData()`
        // already nulled `consultationSchema` synchronously above (before
        // this async tail runs), so without this the outgoing tenant's
        // schema would simply stay absent for the switched-in tenant rather
        // than being replaced by tenant B's own pin — the same gap the
        // tenant-config reload block above closes for `tenantConfig`.
        // `fetchConsultationSchema` never rejects, so this try/catch is
        // defensive-only, matching the surrounding blocks' style.
        // Unlike mount (where `me.departmentId` isn't known until
        // AFTER the schema fetch is kicked off), `effectiveDepartmentId` is
        // already resolved for the INCOMING identity by the time this effect
        // runs (same value the department cascade re-fetch below uses), so a
        // single department-scoped fetch replaces the tenant-scoped default
        // directly — no two-fetch dance needed here.
        try {
          const nextConsultationSchemaPromise = fetchConsultationSchema(apiClient, providerLogger, {
            departmentId: effectiveDepartmentId ?? undefined,
          });
          consultationSchemaPromiseRef.current = nextConsultationSchemaPromise;
          const nextConsultationSchema = await nextConsultationSchemaPromise;
          store.setConsultationSchema(nextConsultationSchema);
        } catch (error) {
          providerLogger.warn('Consultation context schema reload after switch failed', {
            operation: 'rehydrateUserNamespace',
            component: 'AgenticProvider',
            error: error as Error,
          });
        }

        if (personalizationManager) {
          await personalizationManager.hydrate();
          store.setPreferences(personalizationManager.getPreferences());
        }

        // While impersonating, the playground is the SINGLE
        // writer of the user-pref tier: it loads the impersonated user's REAL
        // backend prefs (GET /users/me/settings via the doctor JWT) read-only.
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

        // The department tier carries nothing (see step 3 of `initConfigManager`):
        // there is no gateway READ route behind it, so the only correct state on
        // a user/department change is an EMPTY tier rather than a stale one.
        configManager.clearDepartmentConfig();

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
    // Deps intentionally narrowed: store actions are stable (per-provider instance); rerun only on user identity change.
  }, [effectiveUserId, effectiveTenantId, effectiveDepartmentId]);

  // ---------------------------------------------------------------------------
  // Auto-wire the 401→refresh single-flight handler.
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
    // A host that owns its own 401 handling can opt out
    // (e.g. a consumer's impersonation-aware `useAutoRefresh`), leaving the
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
        // single-use) so the next 401 can refresh again.
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

  // Publish the per-provider store instance so every
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
