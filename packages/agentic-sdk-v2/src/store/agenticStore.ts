/**
 * @arcaai/vox - Agentic Store
 *
 * Internal Zustand store for SDK state management.
 * This store is NOT exported publicly - state is accessed via hooks.
 */

import { create } from 'zustand';
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

// =============================================================================
// Store Creation
// =============================================================================

export const useAgenticStore = create<AgenticState & AgenticActions>((set, get) => ({
  ...initialState,

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
      ...initialState,
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

  clearSensitiveData: () =>
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
    }),

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
}));

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
