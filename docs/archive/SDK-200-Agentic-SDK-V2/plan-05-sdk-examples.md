# Plan 05: SDK v2 Examples (Revised)

| Field | Value |
|-------|-------|
| **Parent Ticket** | SDK-200 |
| **Phase** | 5 - Examples |
| **Created Date** | 2026-01-11 |
| **Last Updated** | 2026-01-12 |
| **Status** | Completed |
| **Dependencies** | Plan 03 (API Layer) ✅, Plan 04 (SDK v2) |

---

## Revision Summary

This plan has been revised to address the following requirements:

1. **Configuration-driven plugins** - Enable/disable features via config (noise cancellation, VAD, STT, NER)
2. **Hybrid personalization** - Local storage with optional backend sync
3. **Custom model registry** - Default public models + organization-provided models
4. **Simplified API** - Reduce hooks, fields, and properties
5. **Internal state management** - Encapsulated context/state

---

## Architecture Overview

### Simplified Hook Structure

**Before (Plan 04):** 5 hooks with many fields
- `useArcaSessionManager` - 3 returns (consultation, status, actions)
- `useArcaAudio` - 3 returns (track, status, actions)
- `useArcaContext` - 3 returns (context, status, actions)
- `useArcaSummary` - 4 returns (summaries, dnaStyle, status, actions)
- `useArcaSettings` - 2 returns (settings, actions)

**After (Revised):** 3 core hooks with unified API

```typescript
// Single unified hook for most use cases
const { session, audio, context, summary, isReady, error } = useArca();

// Or individual hooks when needed
const { session, actions } = useArcaSession();
const { config, models, update, selectModel } = useArcaConfig();
```

### Configuration-Driven Plugin Architecture

All plugins are configured via the `AgenticConfig` object:

```typescript
interface AgenticConfig {
  api: ApiConfig;
  audio?: AudioPluginConfig;
  plugins?: PluginConfig;
  models?: ModelRegistryConfig;
  personalization?: PersonalizationConfig;
}
```

---

## Revised Package Structure

```
packages/agentic-sdk-v2/
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── tsup.config.ts
├── README.md
├── src/
│   ├── index.ts                    # Main entry - exports all public APIs
│   ├── types/
│   │   ├── index.ts                # Re-export all types
│   │   ├── config.ts               # AgenticConfig, PluginConfig, etc.
│   │   ├── consultation.ts         # Consultation types (simplified)
│   │   ├── context.ts              # Context types
│   │   ├── audio.ts                # Audio/STT types
│   │   ├── models.ts               # ModelRegistry, ModelDefinition
│   │   └── common.ts               # Shared types (status, errors)
│   ├── core/
│   │   ├── index.ts
│   │   ├── AgenticClient.ts        # Unified HTTP client
│   │   ├── PluginManager.ts        # Configuration-driven plugin loading
│   │   ├── ModelRegistry.ts        # Model fetching and selection
│   │   ├── PersonalizationManager.ts # Local + backend sync
│   │   └── constants.ts            # Default values, endpoints
│   ├── store/
│   │   ├── index.ts
│   │   └── agenticStore.ts         # Internal Zustand store (not exported)
│   ├── providers/
│   │   ├── index.ts
│   │   └── AgenticProvider.tsx     # Root provider component
│   ├── hooks/
│   │   ├── index.ts
│   │   ├── useArca.ts              # Unified hook (most common usage)
│   │   ├── useArcaSession.ts       # Session management only
│   │   └── useArcaConfig.ts        # Configuration and personalization
│   └── utils/
│       ├── index.ts
│       ├── dateUtils.ts            # Date formatting helpers
│       └── errorUtils.ts           # Error handling
└── examples/
    ├── basic-consultation.tsx       # Simplest usage
    ├── with-plugins.tsx             # Enable/disable plugins via config
    ├── personalization.tsx          # User settings sync
    ├── custom-models.tsx            # Organization model registry
    └── multi-doctor-workflow.tsx    # Full workflow example
```

---

## Type Definitions

### Configuration Types

**File**: `packages/agentic-sdk-v2/src/types/config.ts`

```typescript
/**
 * Main SDK Configuration
 */
export interface AgenticConfig {
  /** API connection settings */
  api: ApiConfig;
  /** Audio processing plugins configuration */
  audio?: AudioPluginConfig;
  /** Additional plugins (NER, TTS, etc.) */
  plugins?: PluginConfig;
  /** Model registry for STT, VAD, NER models */
  models?: ModelRegistryConfig;
  /** User personalization settings */
  personalization?: PersonalizationConfig;
  /** Debug mode */
  debug?: boolean;
}

/**
 * API Configuration
 */
export interface ApiConfig {
  /** Base URL for the API */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Tenant ID (optional, for multi-tenant setups) */
  tenantId?: string;
  /** Request timeout in milliseconds */
  timeout?: number;
}

/**
 * Audio Plugin Configuration
 * Each plugin can be enabled with a boolean or configured with options
 */
export interface AudioPluginConfig {
  /** Noise filter configuration */
  noiseFilter?: NoiseFilterPluginConfig | boolean;
  /** Voice Activity Detection configuration */
  vad?: VADPluginConfig | boolean;
  /** Speech-to-Text configuration */
  stt?: STTPluginConfig | boolean;
}

/**
 * Noise Filter Plugin Configuration
 */
export interface NoiseFilterPluginConfig {
  enabled: boolean;
  /** Noise cancellation level */
  level?: 'low' | 'medium' | 'high';
}

/**
 * VAD Plugin Configuration
 */
export interface VADPluginConfig {
  enabled: boolean;
  /** Speech detection sensitivity (0-1) */
  sensitivity?: number;
  /** Minimum speech duration in ms */
  minSpeechDuration?: number;
  /** Minimum silence duration in ms */
  minSilenceDuration?: number;
}

/**
 * STT Plugin Configuration
 */
export interface STTPluginConfig {
  enabled: boolean;
  /** Provider selection */
  provider?: 'local' | 'backend' | 'auto';
  /** Language code */
  language?: string;
  /** Model ID (from model registry) */
  modelId?: string;
}

/**
 * Additional Plugins Configuration
 */
export interface PluginConfig {
  /** Named Entity Recognition */
  ner?: NERPluginConfig;
  /** Text-to-Speech (future) */
  tts?: TTSPluginConfig;
}

/**
 * NER Plugin Configuration
 */
export interface NERPluginConfig {
  enabled: boolean;
  /** Automatically extract entities from transcriptions */
  autoExtract?: boolean;
  /** Entity types to extract */
  entityTypes?: string[];
}

/**
 * TTS Plugin Configuration (future)
 */
export interface TTSPluginConfig {
  enabled: boolean;
  /** Voice ID */
  voiceId?: string;
  /** Speech rate */
  rate?: number;
}

/**
 * Model Registry Configuration
 */
export interface ModelRegistryConfig {
  /** Custom organization models */
  custom?: ModelDefinition[];
  /** Pre-selected models by type */
  selected?: {
    stt?: string;
    vad?: string;
    ner?: string;
  };
}

/**
 * Model Definition
 */
export interface ModelDefinition {
  /** Unique model identifier */
  id: string;
  /** Display name */
  name: string;
  /** Model type */
  type: 'stt' | 'vad' | 'ner';
  /** Model source */
  source: 'huggingface' | 'custom' | 'backend';
  /** URL for remote fetching */
  url?: string;
  /** Model size hint */
  size?: 'tiny' | 'small' | 'medium' | 'large';
  /** Description */
  description?: string;
}

/**
 * Personalization Configuration
 */
export interface PersonalizationConfig {
  /** Storage mode for user preferences */
  storage: 'local' | 'backend' | 'hybrid';
  /** Sync interval in ms (for hybrid mode) */
  syncInterval?: number;
  /** Default user preferences */
  defaults?: UserPreferences;
}

/**
 * User Preferences (persisted per user/doctor)
 */
export interface UserPreferences {
  /** Preferred language code */
  language?: string;
  /** Selected STT model ID */
  sttModel?: string;
  /** Noise filter level preference */
  noiseFilterLevel?: 'low' | 'medium' | 'high';
  /** VAD sensitivity preference */
  vadSensitivity?: number;
  /** DNA writing style ID */
  dnaStyleId?: string;
  /** Custom preferences (extensible) */
  custom?: Record<string, unknown>;
}
```

### Consultation Types (Simplified)

**File**: `packages/agentic-sdk-v2/src/types/consultation.ts`

```typescript
/**
 * Consultation entity (simplified from Plan 04)
 */
export interface Consultation {
  id: string;
  patientId: string;
  appointmentDate: string;
  doctorId: string;
  doctorName?: string;
  parentConsultationId?: string;
  isNewVisit: boolean;
  isRevisit: boolean;
  status: string;
  department?: string;
  startedAt: string;
  endedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Input for creating a new consultation
 */
export interface CreateConsultationInput {
  patientId: string;
  appointmentDate: string;
  doctorId: string;
  doctorName?: string;
  department?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Input for starting a re-visit
 */
export interface StartRevisitInput {
  parentConsultationId: string;
  doctorId: string;
  doctorName?: string;
  department?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Session actions interface (simplified)
 */
export interface SessionActions {
  create: (input: CreateConsultationInput) => Promise<Consultation>;
  startRevisit: (input: StartRevisitInput) => Promise<Consultation>;
  load: (id: string) => Promise<Consultation>;
  end: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
}

/**
 * Session state interface
 */
export interface SessionState {
  consultation: Consultation | null;
  relatedConsultations: Consultation[];
  isLoading: boolean;
  error: Error | null;
}
```

### Audio Types (Simplified)

**File**: `packages/agentic-sdk-v2/src/types/audio.ts`

```typescript
/**
 * Audio state exposed by useArca hook
 */
export interface AudioState {
  /** Whether audio capture is active */
  isCapturing: boolean;
  /** Whether microphone is muted */
  isMuted: boolean;
  /** Current audio level (0-100) */
  level: number;
  /** Whether speech is detected (VAD) */
  isSpeaking: boolean;
  /** Current transcription text (interim) */
  currentTranscript: string;
  /** Plugin states */
  plugins: AudioPluginStates;
  /** Error if any */
  error: Error | null;
}

/**
 * Audio plugin states
 */
export interface AudioPluginStates {
  noiseFilter: { isActive: boolean; isSupported: boolean };
  vad: { isActive: boolean; isSupported: boolean };
  stt: { isActive: boolean; isSupported: boolean; isProcessing: boolean };
}

/**
 * Audio actions interface
 */
export interface AudioActions {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  mute: () => void;
  unmute: () => void;
  toggleNoiseFilter: (enabled?: boolean) => void;
}

/**
 * Transcription result
 */
export interface TranscriptionResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
  language?: string;
  segments?: TranscriptionSegment[];
}

/**
 * Transcription segment with timing
 */
export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}
```

### Context Types

**File**: `packages/agentic-sdk-v2/src/types/context.ts`

```typescript
/**
 * Context item from backend
 */
export interface ContextItem {
  id: string;
  consultationId: string;
  type: string;
  content: string;
  structuredData?: Record<string, unknown>;
  source: 'user' | 'system' | 'transcription' | 'ai';
  isSummary: boolean;
  isTranscription: boolean;
  isAiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Medical entity from NER
 */
export interface MedicalEntity {
  id: string;
  entityType: string;
  text: string;
  normalizedText?: string;
  codes?: {
    icd10?: string[];
    snomed?: string[];
    rxnorm?: string[];
  };
  confidence: number;
  startOffset: number;
  endOffset: number;
}

/**
 * Context state exposed by useArca hook
 */
export interface ContextState {
  /** All context items for current consultation */
  items: ContextItem[];
  /** Transcription items only */
  transcriptions: ContextItem[];
  /** Case note items only */
  caseNotes: ContextItem[];
  /** Summary items only */
  summaries: ContextItem[];
  /** Extracted medical entities */
  entities: MedicalEntity[];
  /** Shared context from consultation chain */
  sharedContext: ContextItem[];
  /** Loading state */
  isLoading: boolean;
  /** Error if any */
  error: Error | null;
}

/**
 * Context actions interface
 */
export interface ContextActions {
  addCaseNote: (content: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  addTranscription: (text: string, metadata?: Record<string, unknown>) => Promise<ContextItem>;
  updateItem: (id: string, content: string) => Promise<void>;
  loadSharedContext: () => Promise<ContextItem[]>;
  extractEntities: (contextItemId?: string) => Promise<MedicalEntity[]>;
}
```

### Summary Types

**File**: `packages/agentic-sdk-v2/src/types/summary.ts`

```typescript
/**
 * Summary state exposed by useArca hook
 */
export interface SummaryState {
  /** Latest pre-summary */
  preSummary: ContextItem | null;
  /** Latest final summary */
  summary: ContextItem | null;
  /** All summaries */
  all: ContextItem[];
  /** DNA writing style */
  dnaStyle: DNAStyle | null;
  /** Generation in progress */
  isGenerating: boolean;
  /** Error if any */
  error: Error | null;
}

/**
 * Summary actions interface
 */
export interface SummaryActions {
  generatePreSummary: (options?: { dnaStyleId?: string }) => Promise<ContextItem>;
  generateSummary: (options?: { dnaStyleId?: string; includeNER?: boolean }) => Promise<ContextItem>;
  updateSummary: (id: string, content: string) => Promise<void>;
  analyzeDNA: (texts: string[]) => Promise<DNAStyle>;
}

/**
 * DNA Writing Style
 */
export interface DNAStyle {
  id: string;
  name: string;
  description?: string;
  styleData: Record<string, unknown>;
}
```

---

## Core Components

### PluginManager

**File**: `packages/agentic-sdk-v2/src/core/PluginManager.ts`

```typescript
/**
 * Configuration-driven plugin management.
 *
 * Lazy-loads and initializes plugins based on AgenticConfig.
 * Handles processor lifecycle and provides unified state.
 */
export class PluginManager {
  private config: AudioPluginConfig;
  private processors: Map<string, BaseProcessor> = new Map();

  constructor(config: AudioPluginConfig) {
    this.config = config;
  }

  /**
   * Initialize all configured plugins
   */
  async initialize(track: MediaStreamTrack, audioContext: AudioContext): Promise<void> {
    // Initialize noise filter if configured
    if (this.isEnabled('noiseFilter')) {
      const { createNoiseFilter } = await import('@arcaai/noise-filter');
      const config = this.getConfig<NoiseFilterPluginConfig>('noiseFilter');
      const processor = createNoiseFilter({
        noiseCancellation: true,
        noiseCancellationLevel: config.level || 'medium',
      });
      this.processors.set('noiseFilter', processor);
    }

    // Initialize VAD if configured
    if (this.isEnabled('vad')) {
      const { createVAD } = await import('@arcaai/vad');
      const config = this.getConfig<VADPluginConfig>('vad');
      const processor = createVAD({
        threshold: config.sensitivity || 0.5,
        minSpeechDuration: config.minSpeechDuration || 250,
        minSilenceDuration: config.minSilenceDuration || 500,
      });
      this.processors.set('vad', processor);
    }

    // Initialize STT if configured
    if (this.isEnabled('stt')) {
      const { createSTT } = await import('@arcaai/stt');
      const config = this.getConfig<STTPluginConfig>('stt');
      const processor = createSTT({
        provider: config.provider || 'auto',
        language: config.language || 'en',
        model: config.modelId || 'tiny',
      });
      this.processors.set('stt', processor);
    }
  }

  /**
   * Check if a plugin is enabled
   */
  private isEnabled(name: keyof AudioPluginConfig): boolean {
    const config = this.config[name];
    if (typeof config === 'boolean') return config;
    return config?.enabled ?? false;
  }

  /**
   * Get plugin configuration
   */
  private getConfig<T>(name: keyof AudioPluginConfig): T {
    const config = this.config[name];
    if (typeof config === 'boolean') {
      return { enabled: config } as T;
    }
    return (config || { enabled: false }) as T;
  }

  /**
   * Get processor by name
   */
  getProcessor(name: string): BaseProcessor | undefined {
    return this.processors.get(name);
  }

  /**
   * Destroy all processors
   */
  async destroy(): Promise<void> {
    for (const processor of this.processors.values()) {
      await processor.destroy();
    }
    this.processors.clear();
  }
}
```

### PersonalizationManager

**File**: `packages/agentic-sdk-v2/src/core/PersonalizationManager.ts`

```typescript
/**
 * Manages user preferences with local/backend/hybrid storage.
 */
export class PersonalizationManager {
  private config: PersonalizationConfig;
  private apiClient: AgenticClient;
  private preferences: UserPreferences;
  private syncTimer?: NodeJS.Timeout;

  constructor(config: PersonalizationConfig, apiClient: AgenticClient) {
    this.config = config;
    this.apiClient = apiClient;
    this.preferences = this.loadLocal() || config.defaults || {};
  }

  /**
   * Get current preferences
   */
  getPreferences(): UserPreferences {
    return { ...this.preferences };
  }

  /**
   * Update preferences
   */
  async updatePreferences(updates: Partial<UserPreferences>): Promise<void> {
    this.preferences = { ...this.preferences, ...updates };

    // Always save locally
    this.saveLocal();

    // Sync to backend if hybrid mode
    if (this.config.storage === 'backend' || this.config.storage === 'hybrid') {
      await this.syncToBackend();
    }
  }

  /**
   * Load preferences from local storage
   */
  private loadLocal(): UserPreferences | null {
    if (typeof window === 'undefined') return null;
    const stored = localStorage.getItem('arcaai-preferences');
    return stored ? JSON.parse(stored) : null;
  }

  /**
   * Save preferences to local storage
   */
  private saveLocal(): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem('arcaai-preferences', JSON.stringify(this.preferences));
  }

  /**
   * Sync preferences to backend
   */
  private async syncToBackend(): Promise<void> {
    try {
      await this.apiClient.post('/users/me/preferences', this.preferences);
    } catch (error) {
      console.warn('Failed to sync preferences to backend:', error);
    }
  }

  /**
   * Load preferences from backend
   */
  async loadFromBackend(): Promise<void> {
    if (this.config.storage === 'local') return;

    try {
      const remote = await this.apiClient.get<UserPreferences>('/users/me/preferences');
      if (remote) {
        this.preferences = { ...this.preferences, ...remote };
        this.saveLocal();
      }
    } catch (error) {
      console.warn('Failed to load preferences from backend:', error);
    }
  }

  /**
   * Start periodic sync (for hybrid mode)
   */
  startSync(): void {
    if (this.config.storage !== 'hybrid' || !this.config.syncInterval) return;

    this.syncTimer = setInterval(() => {
      this.syncToBackend();
    }, this.config.syncInterval);
  }

  /**
   * Stop periodic sync
   */
  stopSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }
}
```

### ModelRegistry

**File**: `packages/agentic-sdk-v2/src/core/ModelRegistry.ts`

```typescript
/**
 * Default public models (HuggingFace)
 */
const DEFAULT_MODELS: ModelDefinition[] = [
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny',
    type: 'stt',
    source: 'huggingface',
    size: 'tiny',
    description: 'Fastest, suitable for real-time transcription',
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    type: 'stt',
    source: 'huggingface',
    size: 'small',
    description: 'Better accuracy, moderate speed',
  },
  {
    id: 'whisper-medium',
    name: 'Whisper Medium',
    type: 'stt',
    source: 'huggingface',
    size: 'medium',
    description: 'High accuracy, slower processing',
  },
  {
    id: 'silero-vad-v5',
    name: 'Silero VAD v5',
    type: 'vad',
    source: 'huggingface',
    description: 'Default VAD model',
  },
];

/**
 * Model registry for discovering and selecting ML models.
 */
export class ModelRegistry {
  private config: ModelRegistryConfig;
  private apiClient: AgenticClient;
  private models: ModelDefinition[] = [];
  private selected: Record<string, string> = {};

  constructor(config: ModelRegistryConfig, apiClient: AgenticClient) {
    this.config = config;
    this.apiClient = apiClient;
    this.models = [...DEFAULT_MODELS, ...(config.custom || [])];
    this.selected = config.selected || {};
  }

  /**
   * Get all available models
   */
  getAllModels(): ModelDefinition[] {
    return [...this.models];
  }

  /**
   * Get models by type
   */
  getModelsByType(type: 'stt' | 'vad' | 'ner'): ModelDefinition[] {
    return this.models.filter(m => m.type === type);
  }

  /**
   * Get selected model for a type
   */
  getSelectedModel(type: 'stt' | 'vad' | 'ner'): ModelDefinition | undefined {
    const id = this.selected[type];
    return this.models.find(m => m.id === id && m.type === type);
  }

  /**
   * Select a model
   */
  selectModel(type: 'stt' | 'vad' | 'ner', modelId: string): void {
    const model = this.models.find(m => m.id === modelId && m.type === type);
    if (!model) {
      throw new Error(`Model ${modelId} of type ${type} not found`);
    }
    this.selected[type] = modelId;
  }

  /**
   * Load custom models from backend
   */
  async loadCustomModels(): Promise<void> {
    try {
      const customModels = await this.apiClient.get<ModelDefinition[]>('/models');
      if (customModels) {
        // Merge custom models, avoiding duplicates
        for (const model of customModels) {
          if (!this.models.find(m => m.id === model.id)) {
            this.models.push(model);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to load custom models from backend:', error);
    }
  }

  /**
   * Get model URL for loading
   */
  getModelUrl(modelId: string): string | undefined {
    const model = this.models.find(m => m.id === modelId);
    if (!model) return undefined;

    if (model.source === 'huggingface') {
      // Return HuggingFace model path
      return `onnx-community/${modelId}`;
    }

    return model.url;
  }
}
```

---

## Unified Hook Implementation

### useArca Hook

**File**: `packages/agentic-sdk-v2/src/hooks/useArca.ts`

```typescript
/**
 * Unified hook for ARCAAI Agentic SDK.
 *
 * Provides simplified access to all SDK capabilities:
 * - Session management
 * - Audio capture and processing
 * - Context management
 * - Summary generation
 *
 * @example
 * ```tsx
 * function ConsultationPage() {
 *   const { session, audio, context, summary, isReady, error } = useArca();
 *
 *   const handleStart = async () => {
 *     await session.create({ patientId: '123', appointmentDate: '2026-01-12', doctorId: '456' });
 *     await audio.start();
 *   };
 *
 *   return (
 *     <div>
 *       <button onClick={handleStart}>Start</button>
 *       <div>Level: {audio.level}%</div>
 *     </div>
 *   );
 * }
 * ```
 */
export function useArca(): UseArcaReturn {
  const store = useAgenticStore();
  const config = useAgenticConfig();

  // Session management
  const session = useMemo(() => ({
    consultation: store.consultation,
    relatedConsultations: store.relatedConsultations,
    isLoading: store.sessionLoading,
    create: store.createConsultation,
    startRevisit: store.startRevisit,
    load: store.loadConsultation,
    end: store.endConsultation,
    pause: store.pauseConsultation,
    resume: store.resumeConsultation,
  }), [store]);

  // Audio state and actions
  const audio = useMemo(() => ({
    isCapturing: store.isCapturing,
    isMuted: store.isMuted,
    level: store.audioLevel,
    isSpeaking: store.isSpeaking,
    currentTranscript: store.currentTranscript,
    plugins: store.audioPlugins,
    error: store.audioError,
    start: store.startAudioCapture,
    stop: store.stopAudioCapture,
    mute: store.muteAudio,
    unmute: store.unmuteAudio,
    toggleNoiseFilter: store.toggleNoiseFilter,
  }), [store]);

  // Context state and actions
  const context = useMemo(() => ({
    items: store.contextItems,
    transcriptions: store.transcriptions,
    caseNotes: store.caseNotes,
    summaries: store.summaryItems,
    entities: store.entities,
    sharedContext: store.sharedContext,
    isLoading: store.contextLoading,
    error: store.contextError,
    addCaseNote: store.addCaseNote,
    addTranscription: store.addTranscription,
    updateItem: store.updateContextItem,
    loadSharedContext: store.loadSharedContext,
    extractEntities: store.extractEntities,
  }), [store]);

  // Summary state and actions
  const summary = useMemo(() => ({
    preSummary: store.preSummary,
    summary: store.latestSummary,
    all: store.summaryItems,
    dnaStyle: store.dnaStyle,
    isGenerating: store.summaryGenerating,
    error: store.summaryError,
    generatePreSummary: store.generatePreSummary,
    generateSummary: store.generateSummary,
    updateSummary: store.updateSummary,
    analyzeDNA: store.analyzeDNA,
  }), [store]);

  return {
    session,
    audio,
    context,
    summary,
    isReady: store.initialized,
    error: store.globalError,
  };
}

export interface UseArcaReturn {
  session: SessionState & SessionActions;
  audio: AudioState & AudioActions;
  context: ContextState & ContextActions;
  summary: SummaryState & SummaryActions;
  isReady: boolean;
  error: Error | null;
}
```

### useArcaConfig Hook

**File**: `packages/agentic-sdk-v2/src/hooks/useArcaConfig.ts`

```typescript
/**
 * Hook for accessing and updating SDK configuration and user preferences.
 *
 * @example
 * ```tsx
 * function SettingsPage() {
 *   const { preferences, models, update, selectModel } = useArcaConfig();
 *
 *   return (
 *     <select
 *       value={preferences.language}
 *       onChange={e => update({ language: e.target.value })}
 *     >
 *       <option value="en">English</option>
 *       <option value="th">Thai</option>
 *     </select>
 *   );
 * }
 * ```
 */
export function useArcaConfig(): UseArcaConfigReturn {
  const store = useAgenticStore();

  const preferences = store.preferences;

  const models = useMemo(() => ({
    stt: store.modelRegistry.getModelsByType('stt'),
    vad: store.modelRegistry.getModelsByType('vad'),
    ner: store.modelRegistry.getModelsByType('ner'),
    selected: {
      stt: store.modelRegistry.getSelectedModel('stt')?.id,
      vad: store.modelRegistry.getSelectedModel('vad')?.id,
      ner: store.modelRegistry.getSelectedModel('ner')?.id,
    },
  }), [store.modelRegistry]);

  const update = useCallback(async (updates: Partial<UserPreferences>) => {
    await store.updatePreferences(updates);
  }, [store]);

  const selectModel = useCallback((type: 'stt' | 'vad' | 'ner', modelId: string) => {
    store.selectModel(type, modelId);
  }, [store]);

  return {
    preferences,
    models,
    update,
    selectModel,
  };
}

export interface UseArcaConfigReturn {
  preferences: UserPreferences;
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
  update: (updates: Partial<UserPreferences>) => Promise<void>;
  selectModel: (type: 'stt' | 'vad' | 'ner', modelId: string) => void;
}
```

---

## Examples

### Example 1: Basic Consultation

**File**: `packages/agentic-sdk-v2/examples/basic-consultation.tsx`

```tsx
/**
 * Basic Consultation Example
 *
 * Demonstrates the simplest SDK usage:
 * - Single AgenticProvider wrapper
 * - Single useArca() hook for all functionality
 * - Start/end consultation flow
 */

import React from 'react';
import { AgenticProvider, useArca } from '@arcaai/vox';

// Minimal configuration - just API connection
const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ConsultationPage />
    </AgenticProvider>
  );
}

function ConsultationPage() {
  // Single unified hook - no need to manage multiple hooks
  const { session, audio, isReady, error } = useArca();

  const handleStart = async () => {
    // Create consultation and start audio in one flow
    await session.create({
      patientId: 'patient-123',
      appointmentDate: '2026-01-12',
      doctorId: 'doctor-456',
      doctorName: 'Dr. Smith',
    });
    await audio.start();
  };

  const handleEnd = async () => {
    await audio.stop();
    await session.end();
  };

  if (!isReady) {
    return <div>Initializing SDK...</div>;
  }

  if (error) {
    return <div>Error: {error.message}</div>;
  }

  return (
    <div>
      <h1>Medical Consultation</h1>

      {!session.consultation ? (
        <button onClick={handleStart}>Start Consultation</button>
      ) : (
        <div>
          <h2>Active Consultation</h2>
          <p>Patient: {session.consultation.patientId}</p>
          <p>Doctor: {session.consultation.doctorName}</p>
          <p>Type: {session.consultation.isNewVisit ? 'New Visit' : 'Re-visit'}</p>

          {/* Audio level indicator */}
          <div style={{ marginTop: '20px' }}>
            <p>Audio Level: {audio.level}%</p>
            <div style={{ width: '200px', height: '10px', background: '#ddd' }}>
              <div
                style={{
                  width: `${audio.level}%`,
                  height: '100%',
                  background: audio.isMuted ? '#999' : '#4CAF50',
                  transition: 'width 0.1s'
                }}
              />
            </div>
          </div>

          <div style={{ marginTop: '20px' }}>
            <button onClick={audio.isMuted ? audio.unmute : audio.mute}>
              {audio.isMuted ? 'Unmute' : 'Mute'}
            </button>
            <button onClick={handleEnd} style={{ marginLeft: '10px' }}>
              End Consultation
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
```

### Example 2: With Plugins

**File**: `packages/agentic-sdk-v2/examples/with-plugins.tsx`

```tsx
/**
 * Plugins Configuration Example
 *
 * Demonstrates configuration-driven plugin enabling:
 * - Noise filter with level setting
 * - VAD with sensitivity setting
 * - STT with language and provider settings
 * - NER for automatic entity extraction
 */

import React, { useEffect } from 'react';
import { AgenticProvider, useArca } from '@arcaai/vox';

// Full configuration with all plugins
const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  audio: {
    // Noise filter - enabled with high level
    noiseFilter: { enabled: true, level: 'high' },
    // VAD - enabled with custom sensitivity
    vad: { enabled: true, sensitivity: 0.5, minSpeechDuration: 300 },
    // STT - auto provider selection, English language
    stt: { enabled: true, provider: 'auto', language: 'en' },
  },
  plugins: {
    // NER - automatically extract entities from transcriptions
    ner: { enabled: true, autoExtract: true },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <PluginDemoPage />
    </AgenticProvider>
  );
}

function PluginDemoPage() {
  const { session, audio, context, isReady } = useArca();

  useEffect(() => {
    // Auto-create consultation for demo
    if (isReady && !session.consultation) {
      session.create({
        patientId: 'patient-demo',
        appointmentDate: '2026-01-12',
        doctorId: 'doctor-demo',
      });
    }
  }, [isReady, session]);

  if (!isReady || !session.consultation) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h1>Plugin Demo</h1>

      {/* Plugin Status */}
      <section>
        <h2>Plugin Status</h2>
        <table>
          <tbody>
            <tr>
              <td>Noise Filter:</td>
              <td>{audio.plugins.noiseFilter.isActive ? '✅ Active' : '❌ Inactive'}</td>
              <td>{audio.plugins.noiseFilter.isSupported ? 'Supported' : 'Not Supported'}</td>
            </tr>
            <tr>
              <td>VAD:</td>
              <td>{audio.plugins.vad.isActive ? '✅ Active' : '❌ Inactive'}</td>
              <td>{audio.isSpeaking ? '🎤 Speaking' : '🔇 Silent'}</td>
            </tr>
            <tr>
              <td>STT:</td>
              <td>{audio.plugins.stt.isActive ? '✅ Active' : '❌ Inactive'}</td>
              <td>{audio.plugins.stt.isProcessing ? 'Processing...' : 'Idle'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* Audio Controls */}
      <section>
        <h2>Audio Controls</h2>
        <button onClick={audio.isCapturing ? audio.stop : audio.start}>
          {audio.isCapturing ? 'Stop Recording' : 'Start Recording'}
        </button>
        <button onClick={() => audio.toggleNoiseFilter()} style={{ marginLeft: '10px' }}>
          Toggle Noise Filter
        </button>
      </section>

      {/* Live Transcription */}
      <section>
        <h2>Live Transcription</h2>
        {audio.currentTranscript && (
          <p style={{ fontStyle: 'italic', color: '#666' }}>
            {audio.currentTranscript}...
          </p>
        )}
        <h3>Final Transcriptions ({context.transcriptions.length})</h3>
        <ul>
          {context.transcriptions.slice(-5).map((t) => (
            <li key={t.id}>{t.content}</li>
          ))}
        </ul>
      </section>

      {/* NER Entities */}
      <section>
        <h2>Extracted Entities ({context.entities.length})</h2>
        {context.entities.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Text</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {context.entities.map((entity) => (
                <tr key={entity.id}>
                  <td>{entity.entityType}</td>
                  <td>{entity.text}</td>
                  <td>{(entity.confidence * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No entities extracted yet. Start recording to detect medical entities.</p>
        )}
      </section>
    </div>
  );
}

export default App;
```

### Example 3: Personalization

**File**: `packages/agentic-sdk-v2/examples/personalization.tsx`

```tsx
/**
 * Personalization Example
 *
 * Demonstrates hybrid user preferences:
 * - Local storage for immediate persistence
 * - Backend sync for cross-device consistency
 * - User-specific settings (language, models, etc.)
 */

import React from 'react';
import { AgenticProvider, useArca, useArcaConfig } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  audio: {
    noiseFilter: true,
    vad: true,
    stt: { enabled: true },
  },
  personalization: {
    storage: 'hybrid',           // Local + backend sync
    syncInterval: 60000,         // Sync every minute
    defaults: {
      language: 'en',
      noiseFilterLevel: 'medium',
      vadSensitivity: 0.5,
    },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <SettingsPage />
    </AgenticProvider>
  );
}

function SettingsPage() {
  const { preferences, update } = useArcaConfig();

  const handleLanguageChange = async (language: string) => {
    await update({ language });
  };

  const handleNoiseFilterLevelChange = async (level: 'low' | 'medium' | 'high') => {
    await update({ noiseFilterLevel: level });
  };

  const handleVADSensitivityChange = async (sensitivity: number) => {
    await update({ vadSensitivity: sensitivity });
  };

  return (
    <div>
      <h1>User Preferences</h1>
      <p>Changes are saved locally and synced to the server automatically.</p>

      {/* Language Selection */}
      <section>
        <h2>Language</h2>
        <select
          value={preferences.language || 'en'}
          onChange={e => handleLanguageChange(e.target.value)}
        >
          <option value="en">English</option>
          <option value="th">Thai</option>
          <option value="zh">Chinese</option>
          <option value="ja">Japanese</option>
        </select>
      </section>

      {/* Noise Filter Level */}
      <section>
        <h2>Noise Filter Level</h2>
        <div>
          {(['low', 'medium', 'high'] as const).map((level) => (
            <label key={level} style={{ marginRight: '20px' }}>
              <input
                type="radio"
                name="noiseLevel"
                value={level}
                checked={preferences.noiseFilterLevel === level}
                onChange={() => handleNoiseFilterLevelChange(level)}
              />
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </label>
          ))}
        </div>
      </section>

      {/* VAD Sensitivity */}
      <section>
        <h2>Voice Detection Sensitivity</h2>
        <input
          type="range"
          min="0"
          max="1"
          step="0.1"
          value={preferences.vadSensitivity || 0.5}
          onChange={e => handleVADSensitivityChange(parseFloat(e.target.value))}
        />
        <span style={{ marginLeft: '10px' }}>
          {((preferences.vadSensitivity || 0.5) * 100).toFixed(0)}%
        </span>
        <p style={{ color: '#666', fontSize: '12px' }}>
          Lower = less sensitive (fewer false positives)
          <br />
          Higher = more sensitive (catches quiet speech)
        </p>
      </section>

      {/* Current Preferences Debug */}
      <section>
        <h2>Current Preferences (Debug)</h2>
        <pre>{JSON.stringify(preferences, null, 2)}</pre>
      </section>
    </div>
  );
}

export default App;
```

### Example 4: Custom Model Registry

**File**: `packages/agentic-sdk-v2/examples/custom-models.tsx`

```tsx
/**
 * Custom Model Registry Example
 *
 * Demonstrates organization-provided models:
 * - Default public models from HuggingFace
 * - Custom organization models from backend
 * - Model selection per capability (STT, VAD, NER)
 */

import React, { useEffect, useState } from 'react';
import { AgenticProvider, useArcaConfig } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  models: {
    // Organization-provided custom models
    custom: [
      {
        id: 'hospital-stt-medical-v1',
        name: 'Hospital Medical STT',
        type: 'stt' as const,
        source: 'backend' as const,
        url: '/api/models/stt/medical-v1',
        size: 'medium' as const,
        description: 'Optimized for medical terminology',
      },
      {
        id: 'hospital-ner-icd10',
        name: 'ICD-10 Entity Extractor',
        type: 'ner' as const,
        source: 'backend' as const,
        url: '/api/models/ner/icd10',
        description: 'Extracts ICD-10 codes from text',
      },
    ],
    // Pre-select the custom medical STT model
    selected: {
      stt: 'hospital-stt-medical-v1',
    },
  },
  audio: {
    stt: { enabled: true },
  },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <ModelSelectionPage />
    </AgenticProvider>
  );
}

function ModelSelectionPage() {
  const { models, selectModel } = useArcaConfig();
  const [loadingModel, setLoadingModel] = useState<string | null>(null);

  const handleSelectModel = async (type: 'stt' | 'vad' | 'ner', modelId: string) => {
    setLoadingModel(modelId);
    try {
      selectModel(type, modelId);
      // Model will be loaded when audio starts
    } finally {
      setLoadingModel(null);
    }
  };

  const renderModelSection = (
    title: string,
    type: 'stt' | 'vad' | 'ner',
    modelList: typeof models.stt
  ) => (
    <section>
      <h2>{title}</h2>
      <div style={{ display: 'grid', gap: '10px' }}>
        {modelList.map((model) => {
          const isSelected = models.selected[type] === model.id;
          const isLoading = loadingModel === model.id;

          return (
            <div
              key={model.id}
              style={{
                padding: '15px',
                border: `2px solid ${isSelected ? '#4CAF50' : '#ddd'}`,
                borderRadius: '8px',
                background: isSelected ? '#f0fff0' : 'white',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{model.name}</strong>
                  {model.size && (
                    <span style={{ marginLeft: '10px', color: '#666', fontSize: '12px' }}>
                      ({model.size})
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: '10px',
                      padding: '2px 6px',
                      background: model.source === 'custom' || model.source === 'backend'
                        ? '#e3f2fd'
                        : '#fff3e0',
                      borderRadius: '4px',
                      fontSize: '11px',
                    }}
                  >
                    {model.source}
                  </span>
                </div>
                <button
                  onClick={() => handleSelectModel(type, model.id)}
                  disabled={isSelected || isLoading}
                  style={{
                    padding: '5px 15px',
                    background: isSelected ? '#4CAF50' : '#2196F3',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isSelected ? 'default' : 'pointer',
                  }}
                >
                  {isLoading ? 'Loading...' : isSelected ? 'Selected ✓' : 'Select'}
                </button>
              </div>
              {model.description && (
                <p style={{ margin: '10px 0 0', color: '#666', fontSize: '13px' }}>
                  {model.description}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );

  return (
    <div>
      <h1>Model Selection</h1>
      <p>Select models for each capability. Custom organization models are marked.</p>

      {renderModelSection('Speech-to-Text Models', 'stt', models.stt)}
      {renderModelSection('Voice Activity Detection Models', 'vad', models.vad)}
      {renderModelSection('Named Entity Recognition Models', 'ner', models.ner)}
    </div>
  );
}

export default App;
```

### Example 5: Multi-Doctor Workflow

**File**: `packages/agentic-sdk-v2/examples/multi-doctor-workflow.tsx`

```tsx
/**
 * Multi-Doctor Workflow Example
 *
 * Demonstrates a complete consultation workflow:
 * 1. Primary care creates new-visit
 * 2. Primary care adds notes and transcription
 * 3. Specialist starts re-visit
 * 4. Specialist views shared context
 * 5. Specialist generates summary
 */

import React, { useState } from 'react';
import { AgenticProvider, useArca } from '@arcaai/vox';

const config = {
  api: {
    baseUrl: 'https://api.arcaai.com',
    apiKey: 'your-api-key',
  },
  audio: {
    noiseFilter: { enabled: true, level: 'high' },
    vad: { enabled: true },
    stt: { enabled: true, language: 'en' },
  },
  plugins: {
    ner: { enabled: true, autoExtract: true },
  },
};

const doctors = {
  primary: { id: 'dr-001', name: 'Dr. Primary Care', department: 'General Medicine' },
  specialist: { id: 'dr-002', name: 'Dr. Cardiologist', department: 'Cardiology' },
};

function App() {
  return (
    <AgenticProvider config={config}>
      <MultiDoctorWorkflow />
    </AgenticProvider>
  );
}

function MultiDoctorWorkflow() {
  const { session, audio, context, summary, isReady } = useArca();
  const [step, setStep] = useState(1);
  const [newVisitId, setNewVisitId] = useState<string | null>(null);

  const patientId = 'patient-456';
  const appointmentDate = '2026-01-12';

  // Step 1: Primary care creates new-visit
  const handleStep1 = async () => {
    const consultation = await session.create({
      patientId,
      appointmentDate,
      doctorId: doctors.primary.id,
      doctorName: doctors.primary.name,
      department: doctors.primary.department,
    });
    setNewVisitId(consultation.id);
    await audio.start();
    setStep(2);
  };

  // Step 2: Primary care adds notes
  const handleStep2 = async () => {
    await context.addCaseNote(
      'Patient complains of chest pain. Referral to cardiology recommended.'
    );
    await context.addTranscription(
      'Doctor: Can you describe the chest pain? Patient: It feels like pressure, especially when I climb stairs.'
    );
    setStep(3);
  };

  // Step 3: Primary care ends, specialist starts
  const handleStep3 = async () => {
    await audio.stop();
    await session.end();

    // Specialist starts re-visit
    await session.startRevisit({
      parentConsultationId: newVisitId!,
      doctorId: doctors.specialist.id,
      doctorName: doctors.specialist.name,
      department: doctors.specialist.department,
      metadata: { reason: 'Cardiology referral' },
    });

    await audio.start();
    setStep(4);
  };

  // Step 4: Specialist views shared context
  const handleStep4 = async () => {
    await context.loadSharedContext();
    setStep(5);
  };

  // Step 5: Specialist generates summary
  const handleStep5 = async () => {
    await context.addCaseNote(
      'ECG shows normal sinus rhythm. Stress test scheduled for next week.'
    );
    await summary.generateSummary({ includeNER: true });
    await audio.stop();
    setStep(6);
  };

  if (!isReady) {
    return <div>Initializing...</div>;
  }

  return (
    <div>
      <h1>Multi-Doctor Consultation Workflow</h1>
      <p>Patient: {patientId} | Date: {appointmentDate}</p>

      {/* Progress indicator */}
      <div style={{ display: 'flex', gap: '10px', margin: '20px 0' }}>
        {[1, 2, 3, 4, 5, 6].map((s) => (
          <div
            key={s}
            style={{
              width: '40px',
              height: '40px',
              borderRadius: '50%',
              background: step >= s ? '#4CAF50' : '#ddd',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: step >= s ? 'white' : 'black',
              fontWeight: 'bold',
            }}
          >
            {s}
          </div>
        ))}
      </div>

      {/* Step actions */}
      <div style={{ padding: '20px', border: '1px solid #ddd', borderRadius: '8px' }}>
        {step === 1 && (
          <>
            <h3>Step 1: Primary Care Creates New-Visit</h3>
            <p>{doctors.primary.name} starts the consultation.</p>
            <button onClick={handleStep1}>Create New-Visit</button>
          </>
        )}

        {step === 2 && (
          <>
            <h3>Step 2: Primary Care Documents</h3>
            <p>{doctors.primary.name} adds notes and records conversation.</p>
            <p>Audio Level: {audio.level}%</p>
            <button onClick={handleStep2}>Add Case Notes</button>
          </>
        )}

        {step === 3 && (
          <>
            <h3>Step 3: Referral to Specialist</h3>
            <p>Primary care ends, specialist starts re-visit.</p>
            <button onClick={handleStep3}>Start Specialist Re-Visit</button>
          </>
        )}

        {step === 4 && (
          <>
            <h3>Step 4: Specialist Reviews Context</h3>
            <p>{doctors.specialist.name} accesses shared context.</p>
            <button onClick={handleStep4}>Load Shared Context</button>
          </>
        )}

        {step === 5 && (
          <>
            <h3>Step 5: Specialist Documents & Summarizes</h3>
            <p>Specialist adds findings and generates summary.</p>
            <button onClick={handleStep5}>Generate Summary</button>
          </>
        )}

        {step === 6 && (
          <>
            <h3>Step 6: Workflow Complete</h3>
            <p>Full consultation workflow completed!</p>
          </>
        )}
      </div>

      {/* Current consultation */}
      {session.consultation && (
        <div style={{ marginTop: '20px', padding: '15px', background: '#f5f5f5', borderRadius: '8px' }}>
          <h3>Current Consultation</h3>
          <p>Doctor: {session.consultation.doctorName}</p>
          <p>Type: {session.consultation.isNewVisit ? 'New Visit' : 'Re-visit'}</p>
          <p>Department: {session.consultation.department}</p>
        </div>
      )}

      {/* Consultation chain */}
      {session.relatedConsultations.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <h3>Consultation Chain</h3>
          <ul>
            {session.relatedConsultations.map((c) => (
              <li key={c.id}>
                {c.doctorName} ({c.department}) - {c.isNewVisit ? 'New Visit' : 'Re-visit'}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Shared context */}
      {context.sharedContext.length > 0 && (
        <div style={{ marginTop: '20px' }}>
          <h3>Shared Context ({context.sharedContext.length} items)</h3>
          <ul>
            {context.sharedContext.map((item) => (
              <li key={item.id}>
                <strong>{item.type}</strong>: {item.content.substring(0, 100)}...
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Summary */}
      {summary.summary && (
        <div style={{ marginTop: '20px', padding: '15px', background: '#e8f5e9', borderRadius: '8px' }}>
          <h3>Generated Summary</h3>
          <p>{summary.summary.content}</p>
        </div>
      )}
    </div>
  );
}

export default App;
```

---

## API Endpoints Reference

The SDK v2 examples use the following API endpoints (implemented in Plan 03):

### Consultation Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations` | Create new-visit consultation |
| POST | `/consultations/:id/revisit` | Start re-visit |
| GET | `/consultations?patientId=&date=` | Find by patient+date |
| GET | `/consultations/:id` | Get with context |
| GET | `/consultations/:id/chain` | Get chain for context sharing |
| PATCH | `/consultations/:id` | Update |
| POST | `/consultations/:id/end` | End |
| POST | `/consultations/:id/pause` | Pause |
| POST | `/consultations/:id/resume` | Resume |

### Context Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/context` | Add context item |
| GET | `/consultations/:id/context` | Get context items |
| GET | `/consultations/:id/context/shared` | Get shared context |
| GET | `/consultations/:id/context/transcriptions` | Get transcriptions |
| GET | `/consultations/:id/context/case-notes` | Get case notes |
| PATCH | `/consultations/:id/context/:itemId` | Update item |

### Summary Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/consultations/:id/summary/pre-summary` | Generate pre-summary |
| POST | `/consultations/:id/summary` | Generate summary |
| GET | `/consultations/:id/summary/latest` | Get latest summary |
| PATCH | `/consultations/:id/summary/:id` | Update summary |

### Personalization Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/users/me/preferences` | Get user preferences |
| POST | `/users/me/preferences` | Update preferences |

### Model Registry Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models` | List available models |
| GET | `/models/:id` | Get model details |

---

## Validation Checklist

- [x] All 5 examples created
- [x] Examples compile without TypeScript errors
- [x] Examples demonstrate realistic use cases
- [x] Code is well-commented and documented
- [x] Examples follow React best practices
- [x] Error handling demonstrated
- [x] Configuration-driven plugin system shown
- [x] Personalization with hybrid sync shown
- [x] Custom model registry shown
- [x] Multi-doctor workflow shown

---

## Comparison: Original vs Revised

| Aspect | Original Plan 04 | Revised Plan |
|--------|-----------------|--------------|
| **Hooks** | 5 separate hooks | 1 unified + 2 specialized |
| **Plugin System** | Manual processor wiring | Configuration-driven |
| **Personalization** | Basic settings hook | Hybrid local/backend sync |
| **Model Selection** | Hardcoded in STT options | Model registry with custom support |
| **State Exposure** | Public Zustand store | Internal (encapsulated) |
| **Example Count** | 6 detailed examples | 5 focused examples |

---

## Implementation Summary

### Completed on 2026-01-12

Two fully functional example web applications have been implemented:

### 1. Next.js 15 Example (`examples/nextjs-app/`)

- **Framework**: Next.js 15 with App Router
- **React**: React 19
- **Styling**: Tailwind CSS 4 + shadcn/ui (New York style)
- **Routing**: File-based App Router routing
- **Port**: localhost:8868/api/v1

### 2. Vite + React Example (`examples/vite-app/`)

- **Framework**: Vite 6
- **React**: React 19 with React Router
- **Styling**: Tailwind CSS 4 + shadcn/ui (New York style)
- **Routing**: React Router client-side routing
- **Port**: localhost:5173

### Files Created

#### Next.js App
```
examples/nextjs-app/
├── package.json
├── tsconfig.json
├── next.config.ts
├── postcss.config.mjs
├── components.json
├── env.example
├── README.md
└── src/
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx
    │   ├── page.tsx
    │   ├── basic-consultation/page.tsx
    │   ├── with-plugins/page.tsx
    │   ├── personalization/page.tsx
    │   ├── custom-models/page.tsx
    │   └── multi-doctor-workflow/page.tsx
    ├── components/
    │   ├── navigation.tsx
    │   ├── providers.tsx
    │   └── ui/ (button, card, badge, progress, select, slider, switch, tabs, label, radio-group)
    └── lib/
        ├── config.ts
        └── utils.ts
```

#### Vite App
```
examples/vite-app/
├── package.json
├── tsconfig.json
├── tsconfig.app.json
├── tsconfig.node.json
├── vite.config.ts
├── components.json
├── env.example
├── index.html
├── README.md
└── src/
    ├── index.css
    ├── main.tsx
    ├── App.tsx
    ├── vite-env.d.ts
    ├── pages/
    │   ├── home.tsx
    │   ├── basic-consultation.tsx
    │   ├── with-plugins.tsx
    │   ├── personalization.tsx
    │   ├── custom-models.tsx
    │   └── multi-doctor-workflow.tsx
    ├── components/
    │   ├── navigation.tsx
    │   └── ui/ (same as Next.js)
    └── lib/
        ├── config.ts
        └── utils.ts
```

### Environment Configuration

Both apps are configured to use staging environment via environment variables:

- **Next.js**: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_API_KEY`, etc.
- **Vite**: `VITE_API_BASE_URL`, `VITE_API_KEY`, etc.

### Running the Examples

```bash
# Next.js app
cd packages/agentic-sdk-v2/examples/nextjs-app
pnpm install
cp env.example .env.local
pnpm dev

# Vite app
cd packages/agentic-sdk-v2/examples/vite-app
pnpm install
cp env.example .env
pnpm dev
```

---

## Next Phase

After completing this phase, proceed to **Plan 06: Documentation Updates** to update the main README and create migration guides.
