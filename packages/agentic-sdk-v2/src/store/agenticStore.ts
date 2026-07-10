/**
 * @arcaai/vox - Agentic Store
 *
 * Internal Zustand store for SDK state management.
 * This store is NOT exported publicly - state is accessed via hooks.
 */

import { createContext, useContext } from 'react';
import { create, useStore } from 'zustand';
import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla';
import type {
  Consultation,
  ContextItem,
  MedicalEntity,
  UserPreferences,
  AudioPluginStates,
  SummaryResponse,
  DNAStyle,
  AgenticConfig,
  PipelineStateInfo,
  TenantAudioConfig,
} from '../types';
import type { TranscriptSegment } from '../types/audio';
import { DEFAULT_AUDIO_PLUGIN_STATES } from '../types';
import type { AgenticClient } from '../core/AgenticClient';
import type { PluginManager } from '../core/PluginManager';
import { personalizationCacheKey, type PersonalizationManager } from '../core/PersonalizationManager';
import { configDBDelete, PERSONALIZATION_STORE } from '../core/configDB';
import type { ModelRegistry } from '../core/ModelRegistry';
import type { ConfigManager } from '../core/ConfigManager';
import type { AppConfig } from '../core/ConfigSchema';
import type { SDKLogger } from '../core/logger';

// =============================================================================
// State Interface
// =============================================================================

export interface AgenticState {
  // Initialization
  initialized: boolean;
  config: AgenticConfig | null;

  // Core managers (internal)
  apiClient: AgenticClient | null;
  pluginManager: PluginManager | null;
  personalizationManager: PersonalizationManager | null;
  modelRegistry: ModelRegistry | null;
  logger: SDKLogger | null;

  // Consultation state
  consultation: Consultation | null;
  relatedConsultations: Consultation[];
  sessionLoading: boolean;
  sessionError: Error | null;

  // Context state
  contextItems: ContextItem[];
  sharedContext: ContextItem[];
  entities: MedicalEntity[];
  contextLoading: boolean;
  contextError: Error | null;

  // Audio state
  isCapturing: boolean;
  isMuted: boolean;
  audioLevel: number;
  isSpeaking: boolean;
  currentTranscript: string;
  transcriptSegments: TranscriptSegment[];
  audioLanguage: string;
  audioPlugins: AudioPluginStates;
  audioError: Error | null;
  activeStream: MediaStream | null;
  activeAudioContext: AudioContext | null;
  /**
   * TASK-464 — outbound audio frames dropped at the streaming STT client's
   * backpressure watermark during the current capture session. The dropped PCM
   * never reached the durable transcript.
   */
  audioDroppedFrameCount: number;
  /**
   * TASK-464 — session-sticky latch: true once ANY audio was lost this session.
   * SURVIVES reconnect (backpressure precedes the disconnect, so a reconnect
   * reset would erase the signal exactly when loss happened — the bug TASK-454
   * fixed on review); clears ONLY on capture start/stop.
   */
  audioLostThisSession: boolean;

  // Summary state
  summaries: SummaryResponse[];
  dnaStyle: DNAStyle | null;
  summaryGenerating: boolean;
  summaryError: Error | null;

  // Preferences
  preferences: UserPreferences;

  // Pipeline states
  transcriptionPipelineState: PipelineStateInfo | null;
  knowledgePipelineState: PipelineStateInfo | null;

  // Cross-tab state
  isAudioSource: boolean;
  audioSourceTabId: string | null;

  // Auth state
  authUser: unknown;
  authIsAuthenticated: boolean;
  authImpersonatedUser: unknown;
  // NOTE: `authOriginalToken` was removed in TASK-264 W0-3. The admin JWT now
  // lives inside `AgenticClient` (module-level WeakMap, not enumerable on the
  // instance). See `AgenticClient.startImpersonation()` / `stopImpersonation()`.
  authOriginalUser: unknown;

  // Global error
  globalError: Error | null;

  // Model registry version (M-001: forces memo recomputation on mutation)
  modelRegistryVersion: number;

  // Tenant configuration (parsed from GlobalSettings)
  tenantConfig: TenantAudioConfig | null;

  // Three-tier config management (TASK-244)
  configManager: ConfigManager | null;
  resolvedConfig: AppConfig | null;
  configReady: boolean;
  /**
   * TASK-297 DEF-C6 — true after the provider has successfully preloaded
   * `/auth/me` (and therefore knows `authUser`, `tenantId`, `departmentId`).
   * Always false before the first `/auth/me` resolves.
   */
  profileReady: boolean;
}

// =============================================================================
// Actions Interface
// =============================================================================

export interface AgenticActions {
  // Initialization
  initialize: (
    config: AgenticConfig,
    apiClient: AgenticClient,
    pluginManager: PluginManager,
    personalizationManager: PersonalizationManager,
    modelRegistry: ModelRegistry,
    logger: SDKLogger,
  ) => void;
  reset: () => void;

  // Consultation actions
  setConsultation: (consultation: Consultation | null) => void;
  setRelatedConsultations: (consultations: Consultation[]) => void;
  setSessionLoading: (loading: boolean) => void;
  setSessionError: (error: Error | null) => void;

  // Context actions
  setContextItems: (items: ContextItem[]) => void;
  addContextItem: (item: ContextItem) => void;
  updateContextItem: (id: string, updates: Partial<ContextItem>) => void;
  removeContextItem: (id: string) => void;
  setSharedContext: (items: ContextItem[]) => void;
  setEntities: (entities: MedicalEntity[]) => void;
  addEntities: (entities: MedicalEntity[]) => void;
  setContextLoading: (loading: boolean) => void;
  setContextError: (error: Error | null) => void;
  clearContext: () => void;

  // Audio actions
  setIsCapturing: (capturing: boolean) => void;
  setIsMuted: (muted: boolean) => void;
  setAudioLevel: (level: number) => void;
  setIsSpeaking: (speaking: boolean) => void;
  setCurrentTranscript: (transcript: string) => void;
  setTranscriptSegments: (segments: TranscriptSegment[]) => void;
  addTranscriptSegment: (segment: TranscriptSegment) => void;
  setAudioLanguage: (language: string) => void;
  setAudioPlugins: (plugins: AudioPluginStates) => void;
  setAudioError: (error: Error | null) => void;
  setActiveStream: (stream: MediaStream | null) => void;
  setActiveAudioContext: (ctx: AudioContext | null) => void;
  // TASK-464 — audio-drop surfacing (push channel from the streaming STT provider)
  /** Increment the per-session dropped-frame count by one (one call per dropped frame). */
  incrementDroppedFrames: () => void;
  /** Latch `audioLostThisSession` true (session-sticky; survives reconnect). */
  markAudioLost: () => void;
  /** Clear both the count and the latch — called on capture start/stop only. */
  resetAudioDropped: () => void;

  // Summary actions
  setSummaries: (summaries: SummaryResponse[]) => void;
  addSummary: (summary: SummaryResponse) => void;
  setDNAStyle: (style: DNAStyle | null) => void;
  setSummaryGenerating: (generating: boolean) => void;
  setSummaryError: (error: Error | null) => void;

  // Preferences actions
  setPreferences: (preferences: UserPreferences) => void;
  updatePreferences: (updates: Partial<UserPreferences>) => void;

  // Pipeline state actions
  setTranscriptionPipelineState: (state: PipelineStateInfo | null) => void;
  setKnowledgePipelineState: (state: PipelineStateInfo | null) => void;

  // Cross-tab actions
  setIsAudioSource: (isSource: boolean) => void;
  setAudioSourceTabId: (tabId: string | null) => void;

  // Auth actions
  setAuthUser: (user: unknown) => void;
  setIsAuthenticated: (isAuthenticated: boolean) => void;
  setImpersonatedUser: (user: unknown) => void;
  // NOTE: `setOriginalToken` was removed in TASK-264 W0-3. See `AgenticClient`.
  setOriginalUser: (user: unknown) => void;

  // Error actions
  setGlobalError: (error: Error | null) => void;

  // Security actions
  /**
   * TASK-317 W2.1 (AC-7, review C-1) — reset ONLY the tenant-scoped PHI/session
   * slices (consultation / relatedConsultations / context / sharedContext /
   * entities / summaries / transcript / dnaStyle / tenantConfig), leaving auth
   * and impersonation fields untouched. Used by the same-tab tenant-switch
   * handler, which must NOT touch the auth/impersonation state driving the
   * in-flight switch. Shared base for `clearSensitiveData()`.
   */
  clearTenantSessionData: () => void;
  clearSensitiveData: () => void;
  /**
   * TASK-317 W1.4 (AC-3) — scope logout cleanup to the OUTGOING
   * `${tenantId}::${userId}` namespace only. Removes the outgoing
   * `arcaai-user-preferences/${ns}` localStorage key and the
   * `arcaai-personalization/${ns}` IDB row; never sweeps other namespaces.
   */
  clearOnLogout: (ns: string) => void;

  // Model registry version (M-001)
  incrementModelRegistryVersion: () => void;

  // Tenant config
  // TASK-317 W2.1 (AC-7) — accepts `null` so a same-tab tenant switch can reset
  // the outgoing tenant's resolved audio/AI config (the state field is already
  // `TenantAudioConfig | null`).
  setTenantConfig: (config: TenantAudioConfig | null) => void;

  // Runtime config (ENH-05)
  updateRuntimeConfig: (patch: { logLevel?: string }) => void;

  // Three-tier config management (TASK-244)
  setConfigManager: (manager: ConfigManager | null) => void;
  setResolvedConfig: (config: AppConfig | null) => void;
  setConfigReady: (ready: boolean) => void;
  /** TASK-297 DEF-C6 — provider toggles after `/auth/me` resolves. */
  setProfileReady: (ready: boolean) => void;
  /** TASK-297 DEF-H6 — allow provider to re-create manager keyed on user. */
  setPersonalizationManager: (manager: PersonalizationManager | null) => void;
}

// =============================================================================
// Initial State
// =============================================================================

const initialState: AgenticState = {
  // Initialization
  initialized: false,
  config: null,

  // Core managers
  apiClient: null,
  pluginManager: null,
  personalizationManager: null,
  modelRegistry: null,
  logger: null,

  // Consultation state
  consultation: null,
  relatedConsultations: [],
  sessionLoading: false,
  sessionError: null,

  // Context state
  contextItems: [],
  sharedContext: [],
  entities: [],
  contextLoading: false,
  contextError: null,

  // Audio state
  isCapturing: false,
  isMuted: false,
  audioLevel: 0,
  isSpeaking: false,
  currentTranscript: '',
  transcriptSegments: [],
  audioLanguage: 'en',
  audioPlugins: DEFAULT_AUDIO_PLUGIN_STATES,
  audioError: null,
  activeStream: null,
  activeAudioContext: null,
  // TASK-464 — audio-drop signal starts clean each session.
  audioDroppedFrameCount: 0,
  audioLostThisSession: false,

  // Summary state
  summaries: [],
  dnaStyle: null,
  summaryGenerating: false,
  summaryError: null,

  // Preferences
  preferences: {},

  // Pipeline states
  transcriptionPipelineState: null,
  knowledgePipelineState: null,

  // Cross-tab state
  isAudioSource: false,
  audioSourceTabId: null,

  // Auth state (TASK-264 W0-3: `authOriginalToken` deliberately omitted)
  authUser: null,
  authIsAuthenticated: false,
  authImpersonatedUser: null,
  authOriginalUser: null,

  // Global error
  globalError: null,

  // Model registry version
  modelRegistryVersion: 0,

  // Tenant config
  tenantConfig: null,

  // Three-tier config management (TASK-244)
  configManager: null,
  resolvedConfig: null,
  configReady: false,
  // TASK-297 DEF-C6 — flips true once `/auth/me` has resolved.
  profileReady: false,
};

// TASK-317 W4 (review M-2) — every store instance (the @deprecated singleton AND
// each per-provider `createAgenticStore()`) must start from its OWN deep copy of
// the initial state. Spreading the shared `initialState` const directly would
// alias its mutable members (`preferences`, the `[]` slices, `audioPlugins`)
// across instances; isolation would then rely on every action updating
// immutably (true today, but convention-dependent). A fresh structuredClone per
// instance makes that isolation structural rather than incidental.
const createInitialState = (): AgenticState => structuredClone(initialState);

// =============================================================================
// Store Creation
// =============================================================================

// TASK-317 W4.1 (AC-12) — the store config is extracted into a named
// `StateCreator` so it can be instantiated either as the module singleton
// (`useAgenticStore`, retained for external importers) OR per-provider via
// `createAgenticStore()`. The slice/action bodies below are UNCHANGED from
// W1–W3; only the wrapper around them moved.
const agenticStoreInitializer: StateCreator<AgenticState & AgenticActions> = (set, get) => ({
  ...createInitialState(),

  // Initialization
  initialize: (config, apiClient, pluginManager, personalizationManager, modelRegistry, logger) =>
    set({
      initialized: true,
      config,
      apiClient,
      pluginManager,
      personalizationManager,
      modelRegistry,
      logger,
      preferences: personalizationManager.getPreferences(),
    }),

  reset: () =>
    set({
      ...createInitialState(),
      // Keep managers during reset
      initialized: get().initialized,
      config: get().config,
      apiClient: get().apiClient,
      pluginManager: get().pluginManager,
      personalizationManager: get().personalizationManager,
      modelRegistry: get().modelRegistry,
      logger: get().logger,
      preferences: get().preferences,
    }),

  // Consultation actions
  setConsultation: (consultation) => set({ consultation }),
  setRelatedConsultations: (consultations) => set({ relatedConsultations: consultations }),
  setSessionLoading: (loading) => set({ sessionLoading: loading }),
  setSessionError: (error) => set({ sessionError: error }),

  // Context actions
  setContextItems: (items) => set({ contextItems: items }),
  addContextItem: (item) =>
    set((state) => {
      const exists = state.contextItems.some((i) => i.id === item.id);
      return {
        contextItems: exists ? state.contextItems.map((i) => (i.id === item.id ? item : i)) : [...state.contextItems, item],
      };
    }),
  updateContextItem: (id, updates) =>
    set((state) => ({
      contextItems: state.contextItems.map((item) => (item.id === id ? { ...item, ...updates } : item)),
    })),
  removeContextItem: (id) =>
    set((state) => ({
      contextItems: state.contextItems.filter((item) => item.id !== id),
    })),
  setSharedContext: (items) => set({ sharedContext: items }),
  setEntities: (entities) => set({ entities }),
  addEntities: (newEntities) =>
    set((state) => {
      const existingIds = new Set(state.entities.map((e) => e.id));
      const toUpdate = newEntities.filter((e) => existingIds.has(e.id));
      const toAdd = newEntities.filter((e) => !existingIds.has(e.id));
      const updateIds = new Set(toUpdate.map((e) => e.id));
      const merged = state.entities.map((e) => (updateIds.has(e.id) ? toUpdate.find((u) => u.id === e.id)! : e));
      return { entities: [...merged, ...toAdd] };
    }),
  setContextLoading: (loading) => set({ contextLoading: loading }),
  setContextError: (error) => set({ contextError: error }),
  clearContext: () =>
    set({
      contextItems: [],
      sharedContext: [],
      entities: [],
      contextError: null,
    }),

  // Audio actions
  setIsCapturing: (capturing) => set({ isCapturing: capturing }),
  setIsMuted: (muted) => set({ isMuted: muted }),
  setAudioLevel: (level) => set({ audioLevel: level }),
  setIsSpeaking: (speaking) => set({ isSpeaking: speaking }),
  setCurrentTranscript: (transcript) => set({ currentTranscript: transcript }),
  setTranscriptSegments: (segments) => set({ transcriptSegments: segments }),
  addTranscriptSegment: (segment) => set((state) => ({ transcriptSegments: [...state.transcriptSegments, segment] })),
  setAudioLanguage: (language) => set({ audioLanguage: language }),
  setAudioPlugins: (plugins) => set({ audioPlugins: plugins }),
  setAudioError: (error) => set({ audioError: error }),
  setActiveStream: (stream) => set({ activeStream: stream }),
  setActiveAudioContext: (ctx) => set({ activeAudioContext: ctx }),

  // TASK-464 — audio-drop surfacing. `incrementDroppedFrames` is called once per
  // dropped frame; `markAudioLost` latches the session signal; `resetAudioDropped`
  // clears both on start/stop (the latch deliberately survives reconnect).
  incrementDroppedFrames: () => set((state) => ({ audioDroppedFrameCount: state.audioDroppedFrameCount + 1 })),
  markAudioLost: () => set({ audioLostThisSession: true }),
  resetAudioDropped: () => set({ audioDroppedFrameCount: 0, audioLostThisSession: false }),

  // Summary actions
  setSummaries: (summaries) => set({ summaries }),
  addSummary: (summary) =>
    set((state) => {
      const exists = state.summaries.some((s) => s.id === summary.id);
      return {
        summaries: exists ? state.summaries.map((s) => (s.id === summary.id ? summary : s)) : [...state.summaries, summary],
      };
    }),
  setDNAStyle: (style) => set({ dnaStyle: style }),
  setSummaryGenerating: (generating) => set({ summaryGenerating: generating }),
  setSummaryError: (error) => set({ summaryError: error }),

  // Preferences actions
  setPreferences: (preferences) => set({ preferences }),
  updatePreferences: (updates) => set((state) => ({ preferences: { ...state.preferences, ...updates } })),

  // Pipeline state actions
  setTranscriptionPipelineState: (pipelineState) => set({ transcriptionPipelineState: pipelineState }),
  setKnowledgePipelineState: (pipelineState) => set({ knowledgePipelineState: pipelineState }),

  // Cross-tab actions
  setIsAudioSource: (isSource) => set({ isAudioSource: isSource }),
  setAudioSourceTabId: (tabId) => set({ audioSourceTabId: tabId }),

  // Error actions
  setAuthUser: (user) => set({ authUser: user }),
  setIsAuthenticated: (isAuthenticated) => set({ authIsAuthenticated: isAuthenticated }),
  setImpersonatedUser: (user) => set({ authImpersonatedUser: user }),
  // NOTE: TASK-264 W0-3 — `setOriginalToken` removed; admin JWT lives in `AgenticClient`.
  setOriginalUser: (user) => set({ authOriginalUser: user }),

  setGlobalError: (error) => set({ globalError: error }),

  // TASK-317 W2.1 (AC-7, review C-1) — single source of truth for the
  // tenant-scoped PHI/session reset. Clears EVERY tenant-A slice surfaced
  // through useArca()/useArcaConfig() (consultation, relatedConsultations,
  // contextItems, sharedContext, entities [medical NER PHI], summaries,
  // currentTranscript [raw transcript PHI], transcriptSegments, dnaStyle,
  // tenantConfig) but NEVER touches auth/impersonation state — those drive the
  // in-flight tenant switch and must survive it. Empty values mirror
  // `initialState`.
  clearTenantSessionData: () =>
    set({
      consultation: null,
      relatedConsultations: [],
      contextItems: [],
      sharedContext: [],
      entities: [],
      summaries: [],
      currentTranscript: '',
      transcriptSegments: [],
      dnaStyle: null,
      tenantConfig: null,
      // TASK-464 — a tenant switch ends the capture context; the outgoing tenant's
      // audio-drop signal must not bleed into the next. (`clearSensitiveData`
      // delegates here, so the security wipe is covered too.)
      audioDroppedFrameCount: 0,
      audioLostThisSession: false,
    }),

  clearSensitiveData: () => {
    // DRY (review C-1): reuse the tenant-scoped PHI/session reset, then null the
    // auth/impersonation state plus the residual error/audio-resource fields
    // this security wipe owns. `clearTenantSessionData` additionally nulls
    // `tenantConfig`, which is correct for a full sensitive-data wipe.
    get().clearTenantSessionData();
    set({
      authUser: null,
      authIsAuthenticated: false,
      authImpersonatedUser: null,
      authOriginalUser: null,
      sessionError: null,
      contextError: null,
      audioError: null,
      summaryError: null,
      globalError: null,
      activeStream: null,
      activeAudioContext: null,
    });
  },

  incrementModelRegistryVersion: () => set((state) => ({ modelRegistryVersion: state.modelRegistryVersion + 1 })),

  setTenantConfig: (config) => set({ tenantConfig: config }),

  updateRuntimeConfig: (patch) => {
    const state = get();
    if (patch.logLevel && state.logger) {
      state.logger.setLevel(patch.logLevel as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal');
    }
  },

  // Three-tier config management (TASK-244)
  setConfigManager: (manager) => set({ configManager: manager }),
  setResolvedConfig: (config) => set({ resolvedConfig: config }),
  setConfigReady: (ready) => set({ configReady: ready }),
  setProfileReady: (ready) => set({ profileReady: ready }),
  setPersonalizationManager: (manager) => set({ personalizationManager: manager }),

  clearOnLogout: (ns: string) => {
    if (typeof window !== 'undefined') {
      try {
        // TASK-317 W1.4 (AC-3) — remove ONLY the outgoing namespace's
        // localStorage key. The previous iterate-and-delete-all sweep wiped
        // every tenant's `arcaai-user-preferences/*` data on a shared
        // workstation (audit C-2). Mirrors `LS_NAMESPACE_PREFIX` in
        // AgenticProvider.
        localStorage.removeItem(`arcaai-user-preferences/${ns}`);
      } catch {
        /* SSR or restricted storage */
      }

      // TASK-317 W1.4 (AC-3) — delete ONLY the outgoing namespace's
      // personalization IDB row instead of wholesale-clearing the stores
      // (which also wiped other tenants). Fire-and-forget; failures are
      // swallowed (storage may be unavailable in SSR / private mode).
      void configDBDelete(PERSONALIZATION_STORE, personalizationCacheKey(ns)).catch(() => {
        /* IDB unavailable or schema mismatch — ignore */
      });
    }
    set({
      consultation: null,
      relatedConsultations: [],
      contextItems: [],
      sharedContext: [],
      entities: [],
      summaries: [],
      currentTranscript: '',
      transcriptSegments: [],
      dnaStyle: null,
      // TASK-464 — logout ends the capture context; clear the audio-drop signal.
      audioDroppedFrameCount: 0,
      audioLostThisSession: false,
      authUser: null,
      authIsAuthenticated: false,
      authImpersonatedUser: null,
      authOriginalUser: null,
      sessionError: null,
      contextError: null,
      audioError: null,
      summaryError: null,
      globalError: null,
      activeStream: null,
      activeAudioContext: null,
      // TASK-297 DEF-H6 — drop personalization tier so next mount rebuilds
      // a fresh ConfigManager / PersonalizationManager keyed to the new user.
      preferences: {},
      tenantConfig: null,
      resolvedConfig: null,
      configReady: false,
      profileReady: false,
      configManager: null,
      personalizationManager: null,
    });
  },
});

// =============================================================================
// Store factory (TASK-317 W4.1, AC-12)
// =============================================================================

/** A vanilla Zustand store instance for the agentic SDK. */
export type AgenticStoreApi = StoreApi<AgenticState & AgenticActions>;

/**
 * TASK-317 W4.1 (AC-12) — build a fresh, fully-independent store instance.
 *
 * `AgenticProvider` calls this exactly once per mount (held in a `useRef`) so
 * each provider — and therefore each concurrent tenant in a multi-tenant
 * operator console / impersonation tree — owns isolated state. This closes
 * audit finding C-1 (cross-tenant state bleed via a shared module singleton).
 *
 * It wraps the SAME `agenticStoreInitializer` config as the module singleton,
 * using vanilla `createStore` (no React binding) so non-React consumers
 * (managers, plugin manager, cross-tab sync) can call
 * `getState`/`setState`/`subscribe` on the per-instance store.
 */
export function createAgenticStore(): AgenticStoreApi {
  return createStore<AgenticState & AgenticActions>(agenticStoreInitializer);
}

// =============================================================================
// Per-provider store context + hooks (TASK-317 W4.2/W4.3, AC-12)
// =============================================================================

/**
 * React context carrying the `StoreApi` owned by the nearest `AgenticProvider`.
 * Defaults to `null` (outside any provider) so `useStoreApi()` can fail loud
 * instead of silently falling back to a global singleton.
 */
export const AgenticStoreContext = createContext<AgenticStoreApi | null>(null);
AgenticStoreContext.displayName = 'AgenticStoreContext';

/**
 * TASK-317 W4.2 (AC-12) — read the per-provider `StoreApi` from context.
 *
 * Throws when used outside an `<AgenticProvider>` (fail-loud: never silently
 * fall back to the module singleton, which would reintroduce the C-1 leak).
 * Use this for imperative, non-reactive access (`getState`/`setState`/
 * `subscribe`); for reactive reads, use `useAgenticStore(selector)`.
 */
export function useStoreApi(): AgenticStoreApi {
  const api = useContext(AgenticStoreContext);
  if (!api) {
    throw new Error('useStoreApi() (and the @arcaai/vox hooks built on it) must be used within an <AgenticProvider>.');
  }
  return api;
}

const identitySelector = <T>(state: T): T => state;

/**
 * TASK-317 W4.3 (AC-12) — the INTERNAL store hook. Reads the per-provider store
 * from `AgenticStoreContext`, so every concurrent tenant gets isolated state.
 *
 * `useAgenticStore(selector)` is sugar for `useStore(useStoreApi(), selector)`;
 * with no selector it returns the whole state — behaviourally identical to the
 * previous singleton hook, only now scoped to the provider. Throws (via
 * `useStoreApi`) if used outside an `<AgenticProvider>`.
 *
 * The SDK's own hooks/components import THIS from `../store`. The PUBLIC
 * `useAgenticStore` re-exported from `@arcaai/vox` is the @deprecated module
 * singleton below (kept for external importers).
 */
export function useAgenticStore(): AgenticState & AgenticActions;
export function useAgenticStore<U>(selector: (state: AgenticState & AgenticActions) => U): U;
export function useAgenticStore<U>(selector?: (state: AgenticState & AgenticActions) => U): U | (AgenticState & AgenticActions) {
  return useStore(useStoreApi(), (selector ?? identitySelector) as (state: AgenticState & AgenticActions) => U);
}

/**
 * @deprecated TASK-317 W4.3 (AC-12) — module-level singleton store retained
 * ONLY so external importers (`import { useAgenticStore } from '@arcaai/vox'`)
 * keep compiling and working as before. INTERNAL SDK code MUST NOT read this —
 * use the context-backed `useAgenticStore` hook / `useStoreApi()` instead.
 * Reading this singleton inside a multi-tenant tree reintroduces audit finding
 * C-1 (cross-tenant state bleed). Exposed publicly via `core.ts` under the
 * legacy name `useAgenticStore`.
 */
export const agenticStoreSingleton = create<AgenticState & AgenticActions>(agenticStoreInitializer);

// =============================================================================
// Selectors (derived state)
// =============================================================================

/**
 * Get transcription items only
 */
export const selectTranscriptions = (state: AgenticState): ContextItem[] => state.contextItems.filter((item) => item.type === 'transcription');

/**
 * Get case note items only
 */
export const selectCaseNotes = (state: AgenticState): ContextItem[] => state.contextItems.filter((item) => item.type === 'case_note');

/**
 * Get summary items only
 */
export const selectWorknotes = (state: AgenticState): ContextItem[] => state.contextItems.filter((item) => item.type === 'WORKNOTE');

export const selectAttachments = (state: AgenticState): ContextItem[] => state.contextItems.filter((item) => item.type === 'ATTACHMENT');

export const selectSummaryItems = (state: AgenticState): ContextItem[] =>
  state.contextItems.filter((item) => item.type === 'summary' || item.type === 'pre_summary');

/**
 * Get latest summary
 */
export const selectLatestSummary = (state: AgenticState): SummaryResponse | null => {
  const summaries = state.summaries.filter((s) => s.type === 'summary');
  return summaries.length > 0 ? summaries[summaries.length - 1] : null;
};

/**
 * Get latest pre-summary
 */
export const selectLatestPreSummary = (state: AgenticState): SummaryResponse | null => {
  const preSummaries = state.summaries.filter((s) => s.type === 'pre_summary');
  return preSummaries.length > 0 ? preSummaries[preSummaries.length - 1] : null;
};

/**
 * Check if this tab is the audio source
 */
export const selectIsAudioSource = (state: AgenticState): boolean => state.isAudioSource;

/**
 * Get transcription pipeline state
 */
export const selectTranscriptionPipelineState = (state: AgenticState) => state.transcriptionPipelineState;

/**
 * Get knowledge pipeline state
 */
export const selectKnowledgePipelineState = (state: AgenticState) => state.knowledgePipelineState;

// =============================================================================
// Granular Selectors (BUG-01)
//
// Use these with `useAgenticStore(selectXxx)` to subscribe to only the
// specific slice of state you need, avoiding full-store re-renders.
// =============================================================================

export const selectConsultation = (state: AgenticState) => state.consultation;
export const selectIsCapturing = (state: AgenticState) => state.isCapturing;
export const selectAudioLevel = (state: AgenticState) => state.audioLevel;
export const selectEntities = (state: AgenticState) => state.entities;
export const selectSummaries = (state: AgenticState) => state.summaries;
export const selectIsMuted = (state: AgenticState) => state.isMuted;
export const selectIsSpeaking = (state: AgenticState) => state.isSpeaking;
export const selectCurrentTranscript = (state: AgenticState) => state.currentTranscript;
/**
 * TASK-464 — running count of outbound audio frames dropped this session. Read
 * from the EXTERNAL vox UI with `useArcaStore(selectAudioDropped)` (never a
 * direct store import; select atomically to avoid full-store re-renders).
 */
export const selectAudioDropped = (state: AgenticState) => state.audioDroppedFrameCount;
/**
 * TASK-464 — session-sticky "audio was lost this session" latch (survives
 * reconnect, clears only on start/stop). Read via `useArcaStore(selectAudioDegraded)`
 * to render a degraded-connection banner/badge.
 */
export const selectAudioDegraded = (state: AgenticState) => state.audioLostThisSession;
export const selectSessionLoading = (state: AgenticState) => state.sessionLoading;
export const selectSessionError = (state: AgenticState) => state.sessionError;
export const selectContextItems = (state: AgenticState) => state.contextItems;
export const selectPreferences = (state: AgenticState) => state.preferences;
export const selectDnaStyle = (state: AgenticState) => state.dnaStyle;
export const selectAudioPlugins = (state: AgenticState) => state.audioPlugins;
export const selectInitialized = (state: AgenticState) => state.initialized;
export const selectApiClient = (state: AgenticState) => state.apiClient;
export const selectLogger = (state: AgenticState) => state.logger;
export const selectPluginManager = (state: AgenticState) => state.pluginManager;
export const selectTenantConfig = (state: AgenticState) => state.tenantConfig;
export const selectConfigManager = (state: AgenticState) => state.configManager;
export const selectResolvedConfig = (state: AgenticState) => state.resolvedConfig;
export const selectConfigReady = (state: AgenticState) => state.configReady;
/** TASK-297 DEF-C6 — true after `/auth/me` resolves. */
export const selectProfileReady = (state: AgenticState) => state.profileReady;
/** TASK-297 DEF-H6 — selector for the personalization manager instance. */
export const selectPersonalizationManager = (state: AgenticState) => state.personalizationManager;
/** TASK-297 — selector for in-flight authenticated user. */
export const selectAuthUser = (state: AgenticState) => state.authUser;
/** TASK-297 — selector for the impersonated user (or null). */
export const selectAuthImpersonatedUser = (state: AgenticState) => state.authImpersonatedUser;
/** TASK-297 — selector for the model registry (used by useArcaConfig). */
export const selectModelRegistry = (state: AgenticState) => state.modelRegistry;
/** TASK-297 — selector for model registry version (forces memoization on selection). */
export const selectModelRegistryVersion = (state: AgenticState) => state.modelRegistryVersion;
/** TASK-297 DEF-H3 — selector for shared context items. */
export const selectSharedContext = (state: AgenticState) => state.sharedContext;
/** TASK-297 DEF-H3 — selector for the current context loading state. */
export const selectContextLoading = (state: AgenticState) => state.contextLoading;
/** TASK-297 DEF-H3 — selector for the current context error. */
export const selectContextError = (state: AgenticState) => state.contextError;
