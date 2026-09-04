/**
 * @arcaai/vox - PluginManager
 *
 * Configuration-driven plugin management with comprehensive logging.
 * Delegates to TranscriptionPipeline and KnowledgePipeline for processing.
 */

import type { BaseProcessor } from '@arcaai/room';
import type {
  AudioPluginConfig,
  AudioPluginStageName,
  NoiseFilterPluginConfig,
  VADPluginConfig,
  STTPluginConfig,
  NERPluginConfig,
  AudioPluginStates,
  TranscriptionResult,
  VADEvent,
  TranscriptionPipelineConfig,
  KnowledgePipelineConfig,
  UserPreferences,
} from '../types';
import type { SttConnectionState, ProviderSwitchInfo } from '../types/audio';
import { DEFAULT_NOISE_FILTER_CONFIG, DEFAULT_VAD_CONFIG, DEFAULT_STT_CONFIG, DEFAULT_NER_CONFIG } from './constants';
import type { ISDKLogger } from './logger';
import { TranscriptionPipeline, createTranscriptionPipeline } from './TranscriptionPipeline';
import { KnowledgePipeline, createKnowledgePipeline } from './KnowledgePipeline';
import type { AgenticClient } from './AgenticClient';
import { StreamingSessionManager } from './StreamingSessionManager';
import { SttWebSocketClient } from './SttWebSocketClient';

/**
 * Runtime audio start options forwarded by `useArcaAudio.startAudio(...)`.
 *
 * The SDK consumer chooses `pipelineId` (and the active
 * consultation) per-capture rather than statically in `AudioPluginConfig`.
 * `PluginManager.setRuntimeOptions` stores these so the next call to
 * `initialize(track, audioContext)` can build the streaming transport for
 * the STT stage.
 */
export interface PluginManagerRuntimeOptions {
  /**
   * Backend ASR pipeline UUID or slug. Triggers the streaming-aware path.
   * @deprecated TASK-865 — removed in R4. Use `agentSlug`; ignored when `agentSlug` is set.
   */
  pipelineId?: string;
  /** Slug of the published ASR Agent to transcribe with (TASK-865). Wins over `pipelineId`. */
  agentSlug?: string;
  /** Optional consultation id to associate with the streaming session. */
  consultationId?: string;
  /** Optional language override (forwarded to createSession). */
  language?: string;
  /**
   * Optional end-user language mode id, e.g. `'en'`, `'ml'`
   * `'ml-en'`, `'auto'`. Forwarded to the STT session; takes precedence over
   * `language` on the backend path.
   */
  languageMode?: string;
  /**
   * Optional pre-start STT engine selection, `'primary'` (default)
   * or `'fallback'`. Start-time only — forwarded to the STT session so it opens
   * on the tenant-admin default provider when `'fallback'`.
   */
  startOn?: 'primary' | 'fallback';
  /**
   * Optional ceiling (ms) on the streaming-STT stop-drain
   * follow-up #4). Rides on the streaming TRANSPORT rather than the pipeline
   * STT config because it is a property of the socket teardown, not of what is
   * being transcribed — see `buildStreamingTransport`. Omitted / non-positive ⇒
   * the ws client's own default.
   */
  drainTimeoutMs?: number;
  /**
   * Optional quiet window (ms) that ends the streaming-STT stop-drain early
   * once the backend reports `finalizing`. Rides the streaming
   * TRANSPORT for the same reason `drainTimeoutMs` does. `0` DISABLES the early
   * resolve and is preserved; omitted / negative ⇒ the ws client's own default.
   */
  quietWindowMs?: number;
  /**
   * Number of distinct microphone SOURCES mixed into this session.
   * A usage-repricing signal, not a PCM channel count (the mix is mono).
   * Defaults to 1 at the provider when omitted/≤1.
   */
  channelCount?: number;
  /** Optional microphone identifier surfaced in transcripts. */
  microphoneId?: string;
}

/**
 * NER extraction result for callbacks
 */
export interface NERExtractionResult {
  text: string;
  entities: Array<{
    text: string;
    type: string;
    start: number;
    end: number;
    score: number;
  }>;
  processingTime: number;
  timestamp: number;
}

/**
 * Plugin event callbacks
 */
export interface PluginEventCallbacks {
  onTranscription?: (result: TranscriptionResult) => void;
  onVADEvent?: (event: VADEvent) => void;
  onAudioLevel?: (level: number) => void;
  onNERExtraction?: (result: NERExtractionResult) => void;
  onError?: (error: Error, plugin: string) => void;
  /**
   * Fired once per outbound audio frame dropped at the streaming STT
   * client's backpressure watermark (payload: the running per-session count).
   * The vox hook latches the loss + increments the store count so the UI can
   * render a degraded-connection signal.
   */
  onAudioDrop?: (droppedFrameCount: number) => void;
  /**
   * Streaming STT connection-health transition, driven
   * the streaming client's reconnect callbacks. The vox hook maps it onto the
   * store so the UI can render a reconnecting/error/degraded banner.
   */
  onSttConnectionState?: (state: SttConnectionState) => void;
  /**
   * The backend swapped the session's ASR engine to the tenant fallback
   * (auto on outage OR user-triggered). Carried from the `provider_switched`
   * status frame so the hook can mark the active pipeline as the fallback.
   */
  onProviderSwitched?: (info: ProviderSwitchInfo) => void;
  /**
   * The backend streaming session was created and reported the pipeline it
   * RESOLVED plus the engine it actually opened on. Fires once per
   * session, before any audio flows. Not fired by a gateway that predates the
   * echo — the consumer then keeps its request-derived value.
   */
  onStreamingSessionCreated?: (info: { pipelineId: string; isFallback: boolean }) => void;
}

/**
 * NER processor interface — replaces inline `unknown` casts.
 */
export interface INERProcessor {
  init(): Promise<void>;
  extract(text: string): Promise<{
    text: string;
    entities: Array<{
      text: string;
      type: string;
      start: number;
      end: number;
      score: number;
    }>;
    processingTime: number;
    timestamp: number;
  }>;
  destroy?(): Promise<void>;
}

/**
 * Plugin manager state
 */
export interface PluginManagerState {
  initialized: boolean;
  states: AudioPluginStates;
}

/**
 * Configuration-driven plugin management.
 *
 * Delegates to TranscriptionPipeline and KnowledgePipeline for processing.
 * Handles processor lifecycle and provides unified state.
 *
 * The browser never runs a model (TASK-865): `noiseFilter` / `vad` are
 * deprecated client stages, ignored unless `clientInference: { allow: true }`.
 *
 * @example
 * ```typescript
 * const manager = new PluginManager({
 *   stt: { enabled: true, provider: 'backend' },
 * });
 *
 * await manager.initialize(track, audioContext);
 * ```
 */
export class PluginManager {
  private config: AudioPluginConfig;
  private processors: Map<string, BaseProcessor> = new Map();
  private callbacks: PluginEventCallbacks = {};
  private _initialized = false;
  private logger?: ISDKLogger;
  private _debugMode: boolean;

  // Pipeline instances
  private transcriptionPipeline: TranscriptionPipeline | null = null;
  private knowledgePipeline: KnowledgePipeline | null = null;
  private apiClient?: AgenticClient;

  // Per-capture runtime options (set via setRuntimeOptions).
  private runtimeOptions: PluginManagerRuntimeOptions = {};

  // Latest UserPreferences snapshot
  // injected from `PersonalizationManager`. Read at `getTranscriptionPipelineConfig`
  // time to override the static `AudioPluginConfig` (so local-workflow settings
  // persist end-to-end) and, when the pipeline is already running, to propagate
  // live deltas via `propagateUserPreferenceDelta`.
  private userPreferences?: UserPreferences;

  constructor(config: AudioPluginConfig = {}, logger?: ISDKLogger, apiClient?: AgenticClient, debugMode?: boolean) {
    this.config = config;
    this.logger = logger;
    this.apiClient = apiClient;
    this._debugMode = debugMode ?? false;

    this.logger?.debug('PluginManager created', {
      operation: 'constructor',
      component: 'PluginManager',
      attributes: {
        noiseFilterEnabled: this.isEnabled('noiseFilter'),
        vadEnabled: this.isEnabled('vad'),
        sttEnabled: this.isEnabled('stt'),
      },
    });
  }

  /**
   * Get the transcription pipeline instance.
   */
  getTranscriptionPipeline(): TranscriptionPipeline | null {
    return this.transcriptionPipeline;
  }

  /**
   * Record the per-capture runtime options. Must be called
   * BEFORE `initialize(track, audioContext)` for the streaming transport
   * to be built. Subsequent calls overwrite previous options.
   */
  setRuntimeOptions(opts: PluginManagerRuntimeOptions): void {
    this.runtimeOptions = { ...opts };
  }

  /**
   * Clear any per-capture runtime options. Called automatically on destroy.
   */
  clearRuntimeOptions(): void {
    this.runtimeOptions = {};
  }

  /** Visible for diagnostics / testing. */
  getRuntimeOptions(): Readonly<PluginManagerRuntimeOptions> {
    return this.runtimeOptions;
  }

  /**
   * Inject the latest `UserPreferences` snapshot.
   *
   * Called by `AgenticProvider` whenever `PersonalizationManager.onChange` fires,
   * and once after `loadFromBackend()` resolves. The next call to
   * `getTranscriptionPipelineConfig()` will fold the preferences into the
   * resolved pipeline config, and (if an audio pipeline is already running)
   * the relevant deltas are pushed to the live processors via
   * `propagateUserPreferenceDelta`.
   *
   * Pass `undefined` to clear the override and revert to the static config.
   */
  setUserPreferences(prefs: UserPreferences | undefined): void {
    const previous = this.userPreferences;
    this.userPreferences = prefs ? { ...prefs } : undefined;
    this.logger?.debug('PluginManager user preferences updated', {
      operation: 'setUserPreferences',
      component: 'PluginManager',
      attributes: {
        hasPreferences: !!prefs,
        hasLocalConfig: !!prefs?.localConfig,
        hasActiveVoiceProfile: !!prefs?.activeVoiceProfile,
      },
    });

    // Push live deltas only if a pipeline is already running; otherwise the
    // next `initialize()` call picks them up via `getTranscriptionPipelineConfig`.
    if (this.transcriptionPipeline) {
      void this.propagateUserPreferenceDelta(previous, this.userPreferences);
    }
  }

  /** Visible for diagnostics / testing. */
  getUserPreferences(): Readonly<UserPreferences> | undefined {
    return this.userPreferences;
  }

  /**
   * Get the knowledge pipeline instance.
   */
  getKnowledgePipeline(): KnowledgePipeline | null {
    return this.knowledgePipeline;
  }

  private nerProcessor: INERProcessor | null = null;
  private nerConfig: NERPluginConfig | null = null;
  private sttIsProcessing = false;

  /**
   * Set NER plugin configuration
   */
  setNERConfig(config: NERPluginConfig | undefined): void {
    this.nerConfig = config && config.enabled ? config : null;
    this.logger?.debug('NER config updated', {
      operation: 'setNERConfig',
      component: 'PluginManager',
      attributes: {
        enabled: this.nerConfig?.enabled ?? false,
        autoExtract: this.nerConfig?.autoExtract ?? false,
        model: this.nerConfig?.model,
      },
    });
  }

  /**
   * Initialize NER processor (separate from audio plugins)
   */
  async initializeNER(): Promise<void> {
    if (!this.nerConfig?.enabled) {
      return;
    }

    const pluginTimer = this.logger?.startOperation('initNER', {
      component: 'PluginManager',
    });

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @arcaai/med-ner is an OPTIONAL peer dependency (08-vox-sdk.md); casting avoids a hard type dependency on a package that may not be installed in every consumer
      const { createMedNER } = (await import('@arcaai/med-ner')) as any;

      const processor = createMedNER({
        model: this.nerConfig.model ?? DEFAULT_NER_CONFIG.model,
        threshold: this.nerConfig.threshold ?? DEFAULT_NER_CONFIG.threshold,
        entityTypes: this.nerConfig.entityTypes as unknown[],
        dtype: this.nerConfig.dtype ?? DEFAULT_NER_CONFIG.dtype,
        onEntitiesExtracted: (result: {
          entities: Array<{ text: string; type: string; start: number; end: number; score: number }>;
          text: string;
          processingTime: number;
          timestamp: number;
        }) => {
          this.logger?.debug('NER extraction complete', {
            operation: 'nerExtraction',
            component: 'PluginManager',
            attributes: {
              entityCount: result.entities.length,
              processingTime: result.processingTime,
            },
          });
          this.callbacks.onNERExtraction?.({
            text: result.text,
            entities: result.entities.map((e: { text: string; type: string; start: number; end: number; score: number }) => ({
              text: e.text,
              type: e.type,
              start: e.start,
              end: e.end,
              score: e.score,
            })),
            processingTime: result.processingTime,
            timestamp: result.timestamp,
          });
        },
        onError: (error: Error) => {
          this.logger?.error('NER processing error', {
            operation: 'nerExtraction',
            component: 'PluginManager',
            error: error as Error,
          });
          this.callbacks.onError?.(error as Error, 'ner');
        },
      });

      await processor.init();
      this.nerProcessor = processor as INERProcessor;

      pluginTimer?.end(true, {
        attributes: {
          model: this.nerConfig.model ?? 'default',
          threshold: this.nerConfig.threshold ?? DEFAULT_NER_CONFIG.threshold,
        },
      });

      this.logger?.info('NER processor initialized', {
        operation: 'initNER',
        component: 'PluginManager',
        success: true,
      });
    } catch (error) {
      pluginTimer?.error(error as Error);
      this.logger?.error('Failed to initialize NER plugin', {
        operation: 'initNER',
        component: 'PluginManager',
        error: error as Error,
      });
      this.callbacks.onError?.(error as Error, 'ner');
    }
  }

  /**
   * Extract entities from text using NER processor
   */
  async extractEntities(text: string): Promise<NERExtractionResult | null> {
    if (!this.nerProcessor) {
      this.logger?.warn('NER processor not initialized', {
        operation: 'extractEntities',
        component: 'PluginManager',
      });
      return null;
    }

    try {
      const result = await this.nerProcessor.extract(text);
      return {
        text: result.text,
        entities: result.entities.map((e) => ({
          text: e.text,
          type: e.type,
          start: e.start,
          end: e.end,
          score: e.score,
        })),
        processingTime: result.processingTime,
        timestamp: result.timestamp,
      };
    } catch (error) {
      this.logger?.error('Entity extraction failed', {
        operation: 'extractEntities',
        component: 'PluginManager',
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Check if NER is available
   */
  isNERAvailable(): boolean {
    return this.nerProcessor !== null;
  }

  /**
   * Set event callbacks
   */
  setCallbacks(callbacks: PluginEventCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Check if manager is initialized
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Initialize all configured plugins using the transcription pipeline.
   */
  async initialize(track: MediaStreamTrack, audioContext: AudioContext): Promise<void> {
    if (this._initialized) {
      this.logger?.debug('PluginManager already initialized, skipping', {
        operation: 'initialize',
        component: 'PluginManager',
      });
      return;
    }

    const initTimer = this.logger?.startOperation('initializePlugins', {
      component: 'PluginManager',
    });

    try {
      // Build transcription pipeline config from audio plugin config
      const transcriptionConfig = this.getTranscriptionPipelineConfig();

      // Create and initialize the transcription pipeline
      this.transcriptionPipeline = createTranscriptionPipeline(transcriptionConfig, this.logger);

      // Set up pipeline event handlers
      this.setupPipelineEventHandlers();

      // Start the pipeline
      await this.transcriptionPipeline.start({ track, audioContext });

      // Store processor references for backward compatibility
      const noiseFilterProcessor = this.transcriptionPipeline.getProcessor('noiseFilter');
      if (noiseFilterProcessor) {
        this.processors.set('noiseFilter', noiseFilterProcessor);
      }

      const vadProcessor = this.transcriptionPipeline.getProcessor('vad');
      if (vadProcessor) {
        this.processors.set('vad', vadProcessor);
      }

      const sttProcessor = this.transcriptionPipeline.getProcessor('stt');
      if (sttProcessor) {
        this.processors.set('stt', sttProcessor);
      }

      this._initialized = true;

      initTimer?.end(true, {
        attributes: {
          initializedPlugins: Array.from(this.processors.keys()),
          totalPlugins: this.processors.size,
          usePipeline: true,
        },
      });

      this.logger?.info('PluginManager initialization complete (using pipeline)', {
        operation: 'initialize',
        component: 'PluginManager',
        success: true,
        attributes: {
          plugins: Array.from(this.processors.keys()),
        },
      });
    } catch (error) {
      initTimer?.error(error as Error);
      this.logger?.error('Failed to initialize PluginManager', {
        operation: 'initialize',
        component: 'PluginManager',
        error: error as Error,
      });
      throw error;
    }
  }

  /**
   * Initialize the knowledge pipeline.
   */
  async initializeKnowledgePipeline(config?: Partial<KnowledgePipelineConfig>): Promise<void> {
    if (this.knowledgePipeline) {
      this.logger?.debug('KnowledgePipeline already initialized', {
        operation: 'initializeKnowledgePipeline',
        component: 'PluginManager',
      });
      return;
    }

    const knowledgeConfig = this.buildKnowledgePipelineConfig(config);
    this.knowledgePipeline = createKnowledgePipeline(knowledgeConfig, this.apiClient, this.logger);

    // Set up knowledge pipeline event handlers
    this.knowledgePipeline.on('nerComplete', ({ entities, processingTime }) => {
      this.logger?.debug('NER extraction complete', {
        operation: 'nerComplete',
        component: 'PluginManager',
        attributes: { entityCount: entities.length, processingTime },
      });
      this.callbacks.onNERExtraction?.({
        text: '',
        entities: entities.map((e) => ({
          text: e.text,
          type: e.entityType,
          start: e.startOffset ?? 0,
          end: e.endOffset ?? 0,
          score: e.confidence ?? 0,
        })),
        processingTime,
        timestamp: Date.now(),
      });
    });

    this.knowledgePipeline.on('error', ({ error, stage }) => {
      this.callbacks.onError?.(error, stage);
    });

    await this.knowledgePipeline.init();

    this.logger?.info('KnowledgePipeline initialized', {
      operation: 'initializeKnowledgePipeline',
      component: 'PluginManager',
      success: true,
    });
  }

  /**
   * Build transcription pipeline config from audio plugin config.
   * Public to allow inspection (e.g., for testing or advanced configuration).
   *
   * When `setUserPreferences()` has been called, the user's
   * persisted `UserPreferences.localConfig` and `activeVoiceProfile` override
   * the static `AudioPluginConfig`. Precedence (highest → lowest):
   *
   *   runtimeOptions > userPreferences > AudioPluginConfig > package defaults
   *
   * Runtime options stay highest because they reflect per-capture choices
   * (`startAudio({pipelineId, language})`); user preferences sit one tier
   * below because they reflect the doctor's persisted settings.
   */
  getTranscriptionPipelineConfig(): TranscriptionPipelineConfig {
    const noiseFilterConfig = this.getConfig<NoiseFilterPluginConfig>('noiseFilter');
    const vadConfig = this.getConfig<VADPluginConfig>('vad');
    const sttConfig = this.getConfig<STTPluginConfig>('stt');

    // Selection of WHAT transcribes (TASK-865): the runtime option wins over
    // the static plugin config, and an ASR Agent slug wins over the deprecated
    // pipeline id — the two are never carried together.
    const effectiveAgentSlug = this.runtimeOptions.agentSlug ?? sttConfig.agentSlug;
    const effectivePipelineId = effectiveAgentSlug ? undefined : (this.runtimeOptions.pipelineId ?? sttConfig.pipelineId);
    const streamingTransport = this.buildStreamingTransport(sttConfig, effectivePipelineId, effectiveAgentSlug);

    // Pull user-persisted overrides.
    const prefs = this.userPreferences;
    const localConfig = prefs?.localConfig;
    const activeVoiceProfile = prefs?.activeVoiceProfile;
    const voiceProfilePrefs = localConfig?.voiceProfile;

    // Compose the STT `voiceProfile` payload. Each field is independently
    // optional so we can carry partial state — e.g. threshold tweak before
    // the doctor has enrolled, or activated profile without custom threshold.
    //
    // Resolve the reserved-speaker id from the profile's
    // user-supplied label when present (e.g. "Dr. Alice") and fall back to a
    // display-friendly "Doctor" instead of the lowercase magic constant — the
    // value flows through `LocalSpeakerDiarizer` straight to the transcript UI
    // badge, so a humane string matters.
    const hasVoiceProfileData = !!activeVoiceProfile?.id || typeof voiceProfilePrefs?.similarityThreshold === 'number';
    const resolvedReservedSpeakerId = PluginManager.resolveReservedSpeakerId(activeVoiceProfile?.label);
    const voiceProfile = hasVoiceProfileData
      ? {
          ...(activeVoiceProfile?.id ? { id: activeVoiceProfile.id, reservedSpeakerId: resolvedReservedSpeakerId } : {}),
          ...(typeof voiceProfilePrefs?.similarityThreshold === 'number' ? { similarityThreshold: voiceProfilePrefs.similarityThreshold } : {}),
        }
      : undefined;

    return {
      debugMode: this._debugMode,
      // TASK-865: the client-inference gate travels with the config. Absent ⇒
      // the pipeline refuses to construct the two client stages whatever their
      // `enabled` flags say. Spread only when stated, so the pipeline's own
      // "no opinion" stays `undefined`.
      ...(this.config.clientInference ? { clientInference: { allow: this.config.clientInference.allow === true } } : {}),
      noiseFilter: {
        enabled: noiseFilterConfig.enabled ?? false,
        location: noiseFilterConfig.enabled ? 'browser' : 'skip',
        level: localConfig?.noiseCancellation?.level ?? noiseFilterConfig.level ?? DEFAULT_NOISE_FILTER_CONFIG.level,
      },
      vad: {
        enabled: vadConfig.enabled ?? false,
        location: 'browser',
        sensitivity: localConfig?.vad?.sensitivity ?? vadConfig.sensitivity ?? DEFAULT_VAD_CONFIG.sensitivity,
        minSpeechDuration: vadConfig.minSpeechDuration ?? DEFAULT_VAD_CONFIG.minSpeechDuration,
        minSilenceDuration: vadConfig.minSilenceDuration ?? DEFAULT_VAD_CONFIG.minSilenceDuration,
      },
      stt: {
        enabled: sttConfig.enabled ?? false,
        location: sttConfig.provider === 'local' ? 'browser' : sttConfig.provider === 'backend' ? 'backend' : 'auto',
        provider: sttConfig.provider ?? DEFAULT_STT_CONFIG.provider,
        language: this.runtimeOptions.language ?? prefs?.language ?? sttConfig.language ?? DEFAULT_STT_CONFIG.language,
        // End-user language mode. Runtime option wins, else the
        // AudioPluginConfig value. When neither pins a mode we default to
        // 'auto' so an un-selected session AUTO-DETECTS the language (the
        // backend resolves 'auto' to no language override) rather than relying
        // on a hardcoded default — pipelines no longer pin a language
        // A dev/end-user pick (ml/en/ml-en/vi/…) still wins.
        languageMode: this.runtimeOptions.languageMode ?? sttConfig.languageMode ?? 'auto',
        // Pre-start engine selection. Start-time only — there is no
        // static sttConfig.startOn — so it comes solely from the runtime option.
        ...(this.runtimeOptions.startOn ? { startOn: this.runtimeOptions.startOn } : {}),
        modelId: localConfig?.stt?.modelId ?? sttConfig.modelId,
        sttSocket: sttConfig.sttSocket,
        pipelineId: effectivePipelineId,
        ...(effectiveAgentSlug ? { agentSlug: effectiveAgentSlug } : {}),
        diarization: localConfig?.diarization?.enabled ?? sttConfig.diarization ?? false,
        numSpeakers: sttConfig.numSpeakers ?? 2,
        returnTimestamps: sttConfig.returnTimestamps ?? 'word',
        codeSwitching: sttConfig.codeSwitching ?? false,
        // Carry the server-resolved EFFECTIVE transcription
        // mode through to the pipeline so resolveSTTRuntimeProvider() honors it.
        // Omitted when absent to preserve today's provider/location behavior.
        ...(sttConfig.transcriptionMode ? { transcriptionMode: sttConfig.transcriptionMode } : {}),
        ...(streamingTransport ? { streamingTransport } : {}),
        ...(voiceProfile ? { voiceProfile } : {}),
      },
    };
  }

  /**
   * Propagate user-preference deltas to the live
   * pipeline. Only fields whose runtime processor supports a live `updateOptions`
   * / `setLanguage` / `setReservedSpeakerId` hop are dispatched; fields that
   * require a full re-init (e.g. STT modelId, diarization toggle) are left to
   * the next `initialize()` call so we do not surprise the caller mid-capture.
   *
   * The implementation is defensive — every processor lookup is guarded and
   * every dispatch is wrapped, because the pipeline can be in any of its
   * transient states (initializing, running, stopping) when a preference
   * change lands.
   */
  private async propagateUserPreferenceDelta(previous: UserPreferences | undefined, next: UserPreferences | undefined): Promise<void> {
    const pipeline = this.transcriptionPipeline;
    if (!pipeline) return;

    const prevLocal = previous?.localConfig;
    const nextLocal = next?.localConfig;

    // Noise cancellation level → NoiseFilterProcessor.updateOptions
    const nextLevel = nextLocal?.noiseCancellation?.level;
    const prevLevel = prevLocal?.noiseCancellation?.level;
    if (nextLevel && nextLevel !== prevLevel) {
      const proc = pipeline.getProcessor('noiseFilter') as {
        updateOptions?: (opts: { noiseCancellationLevel: 'low' | 'medium' | 'high' }) => Promise<void> | void;
      } | null;
      try {
        await proc?.updateOptions?.({ noiseCancellationLevel: nextLevel });
      } catch (error) {
        this.logger?.warn('Failed to propagate noise level delta', {
          operation: 'propagateUserPreferenceDelta',
          component: 'PluginManager',
          error: error as Error,
        });
      }
    }

    // VAD sensitivity → VADProcessor.updateThresholds
    const nextSensitivity = nextLocal?.vad?.sensitivity;
    const prevSensitivity = prevLocal?.vad?.sensitivity;
    if (typeof nextSensitivity === 'number' && nextSensitivity !== prevSensitivity) {
      const proc = pipeline.getProcessor('vad') as {
        updateThresholds?: (opts: { positiveSpeechThreshold: number; negativeSpeechThreshold: number }) => void | Promise<void>;
      } | null;
      try {
        // Mirror TranscriptionPipeline.getVADNegativeThreshold: 0.7× the positive threshold.
        const negative = Math.max(0, nextSensitivity * 0.7);
        await proc?.updateThresholds?.({ positiveSpeechThreshold: nextSensitivity, negativeSpeechThreshold: negative });
      } catch (error) {
        this.logger?.warn('Failed to propagate VAD sensitivity delta', {
          operation: 'propagateUserPreferenceDelta',
          component: 'PluginManager',
          error: error as Error,
        });
      }
    }

    // Top-level language → STTProcessor.setLanguage
    const nextLanguage = next?.language;
    const prevLanguage = previous?.language;
    if (nextLanguage && nextLanguage !== prevLanguage) {
      const proc = pipeline.getProcessor('stt') as { setLanguage?: (lang: string) => Promise<void> | void } | null;
      try {
        await proc?.setLanguage?.(nextLanguage);
      } catch (error) {
        this.logger?.warn('Failed to propagate language delta', {
          operation: 'propagateUserPreferenceDelta',
          component: 'PluginManager',
          error: error as Error,
        });
      }
    }

    // Active voice profile → STT LocalSpeakerDiarizer.setReservedSpeakerId (best
    // effort: the diarizer only honours this before the first segment, but the
    // call is still safe to fire on every change).
    // route via the same label-resolution helper used by the static config path
    // so the live delta and the next pipeline build agree on the speaker label.
    const nextProfileId = next?.activeVoiceProfile?.id;
    const prevProfileId = previous?.activeVoiceProfile?.id;
    if (nextProfileId && nextProfileId !== prevProfileId) {
      const proc = pipeline.getProcessor('stt') as { setReservedSpeakerId?: (id: string | undefined) => void } | null;
      try {
        proc?.setReservedSpeakerId?.(PluginManager.resolveReservedSpeakerId(next?.activeVoiceProfile?.label));
      } catch (error) {
        this.logger?.warn('Failed to propagate voice profile delta', {
          operation: 'propagateUserPreferenceDelta',
          component: 'PluginManager',
          error: error as Error,
        });
      }
    }
  }

  /**
   * Resolve the speaker label that the local diarizer
   * pins to its first slot. The user-supplied `UserVoiceProfile.label` wins
   * when non-empty (e.g. "Dr. Alice"); otherwise we fall back to a
   * display-friendly "Doctor" so the transcript UI badge reads naturally.
   *
   * Kept as a static helper to keep the resolution rule in one place — both
   * the pipeline-config path (`getTranscriptionPipelineConfig`) and the live
   * delta path (`propagateUserPreferenceDelta`) call through here.
   */
  private static resolveReservedSpeakerId(label: string | undefined): string {
    const trimmed = typeof label === 'string' ? label.trim() : '';
    return trimmed.length > 0 ? trimmed : 'Doctor';
  }

  /**
   * Build the streaming transport (StreamingSessionManager
   * + SttWebSocketClient) for the backend STT path.
   *
   * Built when the capture names an ASR Agent (`agentSlug`) or a deprecated
   * `pipelineId`, or when the provider is explicitly `'backend'` with neither
   * (TASK-865: the gateway then resolves the tenant's default agent). A
   * legacy `sttSocket` consumer that names nothing keeps its `RemoteSTTProvider`.
   *
   * The transport is `unknown` in `TranscriptionPipelineConfig.stt` to keep
   * `@arcaai/vox/types/pipeline.ts` free of an `@arcaai/stt` dependency;
   * `TranscriptionPipeline` narrows it to `STTStreamingTransport` at use.
   *
   * Visible (public, not private) so the surrounding hook tests can assert
   * the wiring without dipping into private state.
   */
  buildStreamingTransport(sttConfig: STTPluginConfig, pipelineId: string | undefined, agentSlug?: string): unknown {
    const provider = sttConfig.provider ?? DEFAULT_STT_CONFIG.provider;
    if (provider === 'local') {
      return undefined;
    }
    const named = Boolean(pipelineId || agentSlug);
    // Nothing named: only an EXPLICIT backend provider opens a session on the
    // tenant default. 'auto' keeps its pre-865 resolution, and a legacy
    // `sttSocket` keeps the RemoteSTTProvider path.
    if (!named && (provider !== 'backend' || sttConfig.sttSocket)) return undefined;
    if (!this.apiClient) {
      if (named) {
        this.logger?.warn('Cannot build streaming transport without an apiClient', {
          operation: 'buildStreamingTransport',
          component: 'PluginManager',
        });
      }
      return undefined;
    }

    const sessionManager = new StreamingSessionManager(this.apiClient, this.logger);
    const wsClient = new SttWebSocketClient(
      this.logger,
      {
        enabled: true,
        refreshTicket: async () => sessionManager.refreshTicket(),
        // v1-compatibility
        requireTenantClaim: sttConfig.requireTenantClaim,
      },
      this._debugMode,
    );

    // Wire the streaming client's connection-lifecycle callbacks — previously
    // implemented but dangling — into the plugin callback bus so the hook/store
    // can surface a live connection-health signal. The
    // arrows read `this.callbacks` at fire time, so ordering vs. setCallbacks()
    // is irrelevant.
    wsClient.onDisconnect(() => this.callbacks.onSttConnectionState?.('reconnecting'));
    wsClient.onReconnect(() => this.callbacks.onSttConnectionState?.('reconnecting'));
    wsClient.onReconnected(() => this.callbacks.onSttConnectionState?.('connected'));
    wsClient.onReconnectFailed(() => this.callbacks.onSttConnectionState?.('error'));
    // The gateway echoes the RESOLVED pipeline + the engine actually opened on
    // Route it out so the store's `activePipeline` is server-derived
    // rather than an echo of what the client asked for — the request is silent
    // about a caller that sent no pipelineId, a session opened on the fallback
    // by choice, and one opened there because the primary ASR failed to load.
    sessionManager.onSessionCreated((response) => {
      if (!response.pipelineId) return; // older gateway — consumer keeps its request-derived value
      this.callbacks.onStreamingSessionCreated?.({
        pipelineId: response.pipelineId,
        isFallback: response.activeEngine === 'fallback',
      });
    });
    // The backend publishes an ASR engine swap as a `status`/`provider_switched`
    // result (zero WS protocol change); route it to the provider-switch callback.
    wsClient.onStatus((status) => {
      if (status.status === 'provider_switched') {
        this.callbacks.onProviderSwitched?.({
          fromPipeline: status.from_pipeline ?? '',
          toPipeline: status.to_pipeline ?? '',
          reason: status.reason ?? 'auto',
          // Forward the bidirectional-toggle direction so a switch BACK
          // to primary un-latches the durable fallback flag (useArcaAudio reads
          // these). Absent on a pre-586 backend ⇒ consumers infer fallback.
          ...(status.active != null ? { active: status.active } : {}),
          ...(status.is_fallback != null ? { isFallback: status.is_fallback } : {}),
          ...(status.utterance_index != null && status.utterance_index !== '' ? { utteranceIndex: Number(status.utterance_index) } : {}),
        });
      }
    });

    return {
      sessionManager,
      wsClient,
      // At most one of the two selectors rides the transport (see
      // `getTranscriptionPipelineConfig`); the provider POSTs whichever is set.
      ...(agentSlug ? { agentSlug } : {}),
      ...(pipelineId ? { pipelineId } : {}),
      consultationId: this.runtimeOptions.consultationId,
      // Per-capture stop-drain ceiling. Spread only
      // when positive so the provider keeps seeing `undefined` — and therefore
      // its own default — for every caller that does not set it.
      ...(typeof this.runtimeOptions.drainTimeoutMs === 'number' && this.runtimeOptions.drainTimeoutMs > 0
        ? { drainTimeoutMs: this.runtimeOptions.drainTimeoutMs }
        : {}),
      // Per-capture stop-drain quiet window. `>= 0`, not truthiness
      // `0` means "disable the early resolve" and MUST survive this hop.
      ...(typeof this.runtimeOptions.quietWindowMs === 'number' && this.runtimeOptions.quietWindowMs >= 0
        ? { quietWindowMs: this.runtimeOptions.quietWindowMs }
        : {}),
      // Dual-/multi-mic source count for usage repricing. Spread
      // only when > 1 so a single-mic session keeps the provider's default of 1.
      ...(typeof this.runtimeOptions.channelCount === 'number' && this.runtimeOptions.channelCount > 1
        ? { channelCount: this.runtimeOptions.channelCount }
        : {}),
    };
  }

  /**
   * Build knowledge pipeline config.
   */
  private buildKnowledgePipelineConfig(config?: Partial<KnowledgePipelineConfig>): KnowledgePipelineConfig {
    const nerConfig = this.nerConfig;

    return {
      ner: {
        enabled: nerConfig?.enabled ?? config?.ner?.enabled ?? false,
        location: config?.ner?.location ?? 'browser',
        triggerMode: nerConfig?.autoExtract ? 'auto' : (config?.ner?.triggerMode ?? 'auto'),
        model: nerConfig?.model ?? config?.ner?.model ?? DEFAULT_NER_CONFIG.model,
        threshold: nerConfig?.threshold ?? config?.ner?.threshold ?? DEFAULT_NER_CONFIG.threshold,
        entityTypes: nerConfig?.entityTypes ?? (config?.ner?.entityTypes as string[] | undefined),
      },
      spellCheck: config?.spellCheck ?? {
        enabled: false,
        location: 'disabled',
        triggerMode: 'manual',
      },
      summarization: config?.summarization ?? {
        enabled: true,
        location: 'backend',
        triggerMode: 'manual',
      },
    };
  }

  /**
   * Set up event handlers for the transcription pipeline.
   */
  private setupPipelineEventHandlers(): void {
    if (!this.transcriptionPipeline) return;

    this.transcriptionPipeline.on('transcription', (result) => {
      this.callbacks.onTranscription?.(result);
    });

    this.transcriptionPipeline.on('partialTranscription', (result) => {
      // Also forward partial transcriptions
      this.callbacks.onTranscription?.(result);
    });

    this.transcriptionPipeline.on('vadEvent', (event) => {
      this.callbacks.onVADEvent?.(event);
    });

    // Forward outbound-audio backpressure drops so the hook/store can
    // surface a degraded-connection signal to the clinician.
    this.transcriptionPipeline.on('audioDrop', (droppedFrameCount) => {
      this.callbacks.onAudioDrop?.(droppedFrameCount);
    });

    this.transcriptionPipeline.on('error', ({ error, stage }) => {
      this.callbacks.onError?.(error, stage);
    });
  }

  /**
   * Check if a plugin is enabled in configuration
   */
  isEnabled(name: AudioPluginStageName): boolean {
    const config = this.config[name];
    if (typeof config === 'boolean') return config;
    return config?.enabled ?? false;
  }

  /**
   * Get plugin configuration
   */
  private getConfig<T extends object>(name: AudioPluginStageName): T {
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
   * Get all processors
   */
  getAllProcessors(): BaseProcessor[] {
    return Array.from(this.processors.values());
  }

  /**
   * Get current plugin states
   */
  getStates(): AudioPluginStates {
    const noiseFilter = this.processors.get('noiseFilter');
    const vad = this.processors.get('vad');
    const stt = this.processors.get('stt');

    return {
      noiseFilter: {
        isActive: noiseFilter?.isEnabled() ?? false,
        isSupported: this.isEnabled('noiseFilter'),
      },
      vad: {
        isActive: vad?.isEnabled() ?? false,
        isSupported: this.isEnabled('vad'),
      },
      stt: {
        isActive: stt?.isEnabled() ?? false,
        isSupported: this.isEnabled('stt'),
        isProcessing: this.sttIsProcessing,
      },
    };
  }

  /**
   * Update the STT processing state flag.
   * Call with `true` when the STT processor begins processing audio,
   * and `false` when it finishes.
   */
  setSttProcessing(isProcessing: boolean): void {
    this.sttIsProcessing = isProcessing;
  }

  /**
   * Enable/disable a processor
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    this.logger?.debug(`${enabled ? 'Enabling' : 'Disabling'} processor: ${name}`, {
      operation: 'setEnabled',
      component: 'PluginManager',
      attributes: { processorName: name, enabled },
    });

    if (this.transcriptionPipeline && this.isPipelineStageName(name)) {
      await this.transcriptionPipeline.toggleStage(name, enabled);
      const stageProcessor = this.transcriptionPipeline.getProcessor(name);
      if (stageProcessor) {
        this.processors.set(name, stageProcessor);
      } else {
        this.processors.delete(name);
      }
      return;
    }

    const processor = this.processors.get(name);
    if (!processor) {
      this.logger?.warn('Cannot set enabled state - processor not found', {
        operation: 'setEnabled',
        component: 'PluginManager',
        attributes: { processorName: name, enabled },
      });
      return;
    }

    if (enabled) {
      await processor.enable();
    } else {
      await processor.disable();
    }
  }

  /**
   * Toggle a processor
   */
  async toggle(name: string): Promise<boolean> {
    if (this.transcriptionPipeline && this.isPipelineStageName(name)) {
      const currentStates = this.getStates();
      const newState = !currentStates[name].isActive;
      this.logger?.debug(`Toggling processor: ${name} -> ${newState}`, {
        operation: 'toggle',
        component: 'PluginManager',
        attributes: { processorName: name, newState },
      });
      await this.setEnabled(name, newState);
      return newState;
    }

    const processor = this.processors.get(name);
    if (!processor) {
      this.logger?.warn('Cannot toggle - processor not found', {
        operation: 'toggle',
        component: 'PluginManager',
        attributes: { processorName: name },
      });
      return false;
    }

    const newState = !processor.isEnabled();
    this.logger?.debug(`Toggling processor: ${name} -> ${newState}`, {
      operation: 'toggle',
      component: 'PluginManager',
      attributes: { processorName: name, newState },
    });

    await this.setEnabled(name, newState);
    return newState;
  }

  private isPipelineStageName(name: string): name is 'noiseFilter' | 'vad' | 'stt' {
    return name === 'noiseFilter' || name === 'vad' || name === 'stt';
  }

  /**
   * Restart all processors with new track
   */
  async restart(track: MediaStreamTrack, audioContext: AudioContext): Promise<void> {
    const timer = this.logger?.startOperation('restartPlugins', {
      component: 'PluginManager',
    });

    try {
      for (const [name, processor] of this.processors.entries()) {
        this.logger?.debug(`Restarting processor: ${name}`, {
          operation: 'restart',
          component: 'PluginManager',
          attributes: { processorName: name },
        });
        await processor.restart({ kind: 'audio', track, audioContext });
      }
      timer?.end(true, { attributes: { processorCount: this.processors.size } });
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }

  /**
   * The in-flight `destroy()` promise, or `null`.
   *
   * SINGLE-FLIGHT (the "Finalizing… for drainTimeoutMs"
   * hang). The compat layer stops ONE audio graph through TWO hooks, and each
   * `useArcaAudio` instance has its own per-instance stop guard — so both stop
   * paths reach THIS shared manager and, without this, run `destroy()`
   * concurrently. The second pass raced the first through the SAME
   * `SttWebSocketClient`, whose pending-drain resolver is a single slot: one
   * caller's drain lost its resolver and sat out the FULL `drainTimeoutMs`
   * ceiling (measured: 60.9 s with a 60 s ceiling) while the UI stayed in
   * "stopping". Handing every concurrent caller the SAME promise makes the
   * duplicate free and the teardown single.
   */
  private destroyInFlight: Promise<void> | null = null;

  /**
   * Destroy all processors and release resources.
   *
   * Concurrent calls join the in-flight teardown (see {@link destroyInFlight}).
   */
  destroy(): Promise<void> {
    if (this.destroyInFlight) return this.destroyInFlight;
    const run = this.destroyOnce().finally(() => {
      if (this.destroyInFlight === run) this.destroyInFlight = null;
    });
    this.destroyInFlight = run;
    return run;
  }

  private async destroyOnce(): Promise<void> {
    const timer = this.logger?.startOperation('destroyPlugins', {
      component: 'PluginManager',
    });

    try {
      // Destroy transcription pipeline
      if (this.transcriptionPipeline) {
        await this.transcriptionPipeline.destroy();
        this.transcriptionPipeline = null;
      }

      // Destroy knowledge pipeline
      if (this.knowledgePipeline) {
        await this.knowledgePipeline.destroy();
        this.knowledgePipeline = null;
      }

      // Clear processor references
      const processorNames = Array.from(this.processors.keys());
      this.processors.clear();
      this._initialized = false;

      if (this.nerProcessor) {
        await this.nerProcessor.destroy?.();
        this.nerProcessor = null;
      }

      this.callbacks = {};

      timer?.end(true, { attributes: { destroyedPlugins: processorNames } });
      this.logger?.info('PluginManager destroyed', {
        operation: 'destroy',
        component: 'PluginManager',
        success: true,
      });
    } catch (error) {
      timer?.error(error as Error);
      throw error;
    }
  }

  /**
   * Update configuration (requires reinitialize for changes to take effect)
   */
  updateConfig(config: Partial<AudioPluginConfig>): void {
    this.logger?.debug('Updating PluginManager configuration', {
      operation: 'updateConfig',
      component: 'PluginManager',
      attributes: {
        noiseFilterChanged: 'noiseFilter' in config,
        vadChanged: 'vad' in config,
        sttChanged: 'stt' in config,
      },
    });
    this.config = { ...this.config, ...config };
  }
}
