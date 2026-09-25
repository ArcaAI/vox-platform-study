/**
 * @arcaai/vox - Pipeline Types
 *
 * Types for the transcription and knowledge processing pipelines.
 */

import type { TranscriptionResult, VADEvent } from './audio';
import type { MedicalEntity } from './context';

// =============================================================================
// Pipeline Status Types
// =============================================================================

/**
 * Status of a processing pipeline.
 */
export type PipelineStatus = 'IDLE' | 'RUNNING' | 'PAUSED' | 'ERROR' | 'COMPLETED';

/**
 * State of a pipeline.
 */
export interface PipelineStateInfo {
  /** Current status */
  status: PipelineStatus;
  /** Currently executing stage (if running) */
  currentStage?: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Error if status is ERROR */
  error?: Error;
  /** Whether the pipeline is ready to process */
  isReady: boolean;
}

// =============================================================================
// Transcription Pipeline Types
// =============================================================================

/**
 * Input to the transcription pipeline.
 */
export interface TranscriptionPipelineInput {
  /** Media stream track to process */
  track: MediaStreamTrack;
  /** Audio context for processing */
  audioContext: AudioContext;
}

/**
 * Output from the transcription pipeline.
 */
export interface TranscriptionPipelineOutput {
  /** The transcription result */
  transcription: TranscriptionResult;
  /** Associated VAD event (if speech segment) */
  vadEvent?: VADEvent;
  /** Processing timestamp */
  timestamp: number;
}

/**
 * Configuration for the transcription pipeline.
 *
 * TASK-1006 (following TASK-865): the `noiseFilter` and `vad` client stages,
 * the `clientInference` gate, and the local STT provider (`modelId`, Whisper
 * `task`) were removed — the browser never runs a model. The pipeline now
 * hosts a single stage: backend/remote STT over the streaming transport.
 */
export interface TranscriptionPipelineConfig {
  /** Enable debug mode for verbose console logging of configuration and transcripts */
  debugMode?: boolean;
  /**
   * Whether the pipeline owns the AudioContext passed to start().
   * - 'borrowed': pipeline does NOT close the context on stop (default, safe for shared contexts)
   * - 'owned': pipeline closes the context on stop
   */
  contextOwnership?: 'owned' | 'borrowed';
  /** STT configuration */
  stt: {
    /** Whether to enable STT */
    enabled: boolean;
    /** Processing location */
    location: 'backend' | 'auto' | 'skip';
    /** Provider type */
    provider?: 'backend' | 'auto';
    /**
     * Server-resolved EFFECTIVE transcription mode, forwarded verbatim from
     * `STTPluginConfig.transcriptionMode` (a wire-compatible type — the
     * backend/`UserPreferences` contract is unchanged by this SDK). No longer
     * read by this pipeline: with the local stage removed there is nothing
     * left to branch on.
     */
    transcriptionMode?: 'LOCAL' | 'BACKEND';
    /** Language */
    language?: string;
    /** End-user language mode id; forwarded to the backend STT session.*/
    languageMode?: string;
    /** Pre-start STT engine selection; forwarded to the backend STT session.*/
    startOn?: 'primary' | 'fallback';
    /** WebSocket URL for remote processing */
    sttSocket?: string;
    /** Slug of the published ASR Agent that should transcribe this session (TASK-865). */
    agentSlug?: string;
    /** Enable speaker diarization in STT output */
    diarization?: boolean;
    /** Expected number of speakers when diarization is enabled */
    numSpeakers?: number;
    /** Timestamp granularity for STT output */
    returnTimestamps?: boolean | 'word';
    /** Let model auto-detect language for multilingual/code-switching audio */
    codeSwitching?: boolean;
    /**
     * Pipeline-aware streaming transport injected by the SDK
     * (PluginManager builds it when a remote `agentSlug` is set, then passes
     * it through to the STT stage factory). The transport is `unknown` here
     * to keep this file free of a hard dependency on `@arcaai/stt` types;
     * `TranscriptionPipeline` narrows it to `STTStreamingTransport` at use.
     */
    streamingTransport?: unknown;
  };
}

/**
 * Default transcription pipeline configuration.
 */
export const DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG: TranscriptionPipelineConfig = {
  contextOwnership: 'borrowed',
  stt: {
    enabled: true,
    location: 'auto',
    provider: 'auto',
    language: 'en-US',
    diarization: false,
    numSpeakers: 2,
    returnTimestamps: 'word',
    codeSwitching: false,
  },
};

// =============================================================================
// Knowledge Pipeline Types
// =============================================================================

/**
 * Input to the knowledge pipeline.
 */
export interface KnowledgePipelineInput {
  /** Text to process (typically from transcription) */
  text: string;
  /** Source transcription result */
  transcription?: TranscriptionResult;
  /** Context ID (consultation ID) */
  contextId?: string;
}

/**
 * Output from the knowledge pipeline.
 */
export interface KnowledgePipelineOutput {
  /** Extracted medical entities */
  entities?: MedicalEntity[];
  /** Spell-checked text */
  correctedText?: string;
  /** Summary (if generated) */
  summary?: string;
  /** Processing timestamp */
  timestamp: number;
}

/**
 * Configuration for the knowledge pipeline.
 */
export interface KnowledgePipelineConfig {
  /** NER configuration */
  ner: {
    /** Whether to enable NER */
    enabled: boolean;
    /** Processing location */
    location: 'browser' | 'backend' | 'auto' | 'disabled';
    /** Trigger mode */
    triggerMode: 'auto' | 'manual';
    /** Model ID */
    model?: string;
    /** Confidence threshold */
    threshold?: number;
    /** Entity types to extract */
    entityTypes?: string[];
  };
  /** Spell check configuration */
  spellCheck: {
    /** Whether to enable spell check */
    enabled: boolean;
    /** Processing location */
    location: 'browser' | 'backend' | 'disabled';
    /** Trigger mode */
    triggerMode: 'auto' | 'manual';
  };
  /** Summarization configuration */
  summarization: {
    /** Whether to enable summarization */
    enabled: boolean;
    /** Processing location (always backend) */
    location: 'backend' | 'disabled';
    /** Trigger mode (always manual) */
    triggerMode: 'manual';
    /** DNA style ID for personalization */
    dnaStyleId?: string;
  };
}

/**
 * Default knowledge pipeline configuration.
 */
export const DEFAULT_KNOWLEDGE_PIPELINE_CONFIG: KnowledgePipelineConfig = {
  // TASK-1006 (following TASK-865): the browser never runs a model.
  // `@arcaai/med-ner` (in-browser NER) was deleted, so `location: 'browser'`
  // now throws if a host opts back in — disabled is the only working default.
  ner: {
    enabled: false,
    location: 'disabled',
    triggerMode: 'auto',
    threshold: 0.6,
  },
  spellCheck: {
    enabled: false,
    location: 'disabled',
    triggerMode: 'manual',
  },
  summarization: {
    enabled: true,
    location: 'backend',
    triggerMode: 'manual',
  },
};

// =============================================================================
// Pipeline Events
// =============================================================================

/**
 * Events emitted by the transcription pipeline.
 */
export interface TranscriptionPipelineEvents {
  /** Transcription result available */
  transcription: TranscriptionResult;
  /** Partial transcription (interim) */
  partialTranscription: TranscriptionResult;
  /** VAD event */
  vadEvent: VADEvent;
  /** Audio level update */
  audioLevel: number;
  /**
   * An outbound audio frame was dropped at the streaming STT client's
   * backpressure watermark (payload: the running per-session dropped-frame
   * count). Sourced from the STT processor's push channel; consumers surface it
   * as a degraded-connection signal (the dropped PCM never reached the transcript).
   */
  audioDrop: number;
  /** Error occurred */
  error: { error: Error; stage: string };
  /** Pipeline state changed */
  stateChange: PipelineStateInfo;
}

/**
 * Events emitted by the knowledge pipeline.
 */
export interface KnowledgePipelineEvents {
  /** NER extraction complete */
  nerComplete: { entities: MedicalEntity[]; processingTime: number };
  /** Spell check complete */
  spellCheckComplete: { original: string; corrected: string };
  /** Summary generated */
  summaryComplete: { summary: string };
  /** Error occurred */
  error: { error: Error; stage: string };
  /** Pipeline state changed */
  stateChange: PipelineStateInfo;
}

// =============================================================================
// Pipeline Actions
// =============================================================================

/**
 * Actions for controlling the transcription pipeline.
 */
export interface TranscriptionPipelineActions {
  /** Start the pipeline */
  start: (input: TranscriptionPipelineInput) => Promise<void>;
  /** Stop the pipeline */
  stop: () => Promise<void>;
  /** Pause the pipeline */
  pause: () => void;
  /** Resume the pipeline */
  resume: () => void;
  /** Update configuration */
  updateConfig: (config: Partial<TranscriptionPipelineConfig>) => void;
  /** Toggle a specific stage */
  toggleStage: (stage: 'stt', enabled: boolean) => Promise<void>;
}

/**
 * Actions for controlling the knowledge pipeline.
 */
export interface KnowledgePipelineActions {
  /** Process text through the pipeline */
  process: (input: KnowledgePipelineInput) => Promise<KnowledgePipelineOutput>;
  /** Trigger NER extraction manually */
  triggerNER: (text: string) => Promise<MedicalEntity[]>;
  /** Trigger spell check manually */
  triggerSpellCheck: (text: string) => Promise<string>;
  /** Trigger summarization manually */
  triggerSummarization: (contextId: string) => Promise<string>;
  /** Update configuration */
  updateConfig: (config: Partial<KnowledgePipelineConfig>) => void;
}
