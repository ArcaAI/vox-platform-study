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
  /** Noise filter configuration */
  noiseFilter: {
    /** Whether to enable noise filtering */
    enabled: boolean;
    /** Processing location */
    location: 'browser' | 'skip';
    /** Noise cancellation level */
    level?: 'low' | 'medium' | 'high';
  };
  /** VAD configuration */
  vad: {
    /** Whether to enable VAD */
    enabled: boolean;
    /** Processing location (always browser) */
    location: 'browser';
    /** Speech detection sensitivity */
    sensitivity?: number;
    /** Minimum speech duration in ms */
    minSpeechDuration?: number;
    /** Minimum silence duration in ms */
    minSilenceDuration?: number;
  };
  /** STT configuration */
  stt: {
    /** Whether to enable STT */
    enabled: boolean;
    /** Processing location */
    location: 'browser' | 'backend' | 'auto' | 'skip';
    /** Provider type */
    provider?: 'local' | 'backend' | 'auto';
    /** Language */
    language?: string;
    /** Model ID for local processing */
    modelId?: string;
    /** WebSocket URL for remote processing */
    sttSocket?: string;
    /** Backend ASR pipeline ID/slug (for backend mode orchestration) */
    pipelineId?: string;
    /** Enable speaker diarization in STT output */
    diarization?: boolean;
    /** Expected number of speakers when diarization is enabled */
    numSpeakers?: number;
    /** Timestamp granularity for STT output */
    returnTimestamps?: boolean | 'word';
    /** Let model auto-detect language for multilingual/code-switching audio */
    codeSwitching?: boolean;
    /**
     * TASK-298 D-4 — Pipeline-aware streaming transport injected by the SDK
     * (PluginManager builds it when a remote `pipelineId` is set, then passes
     * it through to the STT stage factory). The transport is `unknown` here
     * to keep this file free of a hard dependency on `@arcaai/stt` types;
     * `TranscriptionPipeline` narrows it to `STTStreamingTransport` at use.
     */
    streamingTransport?: unknown;
    /**
     * TASK-304 Wave 2 W2-SDK-1 / W2-SDK-2 — voice-profile context resolved from
     * `UserPreferences.activeVoiceProfile` + `UserPreferences.localConfig.voiceProfile`.
     *
     * `id` is the server-side `UserVoiceProfile.id`; `reservedSpeakerId` is the
     * stable label pinned to the diarizer's first slot. `similarityThreshold`
     * tunes the MFCC centroid matcher (range `[0, 1]`, lower = more permissive).
     *
     * The fields are individually optional so the SDK can express partial state
     * (e.g. doctor tuned the threshold but has not enrolled yet).
     */
    voiceProfile?: {
      id?: string;
      reservedSpeakerId?: string;
      similarityThreshold?: number;
    };
    /**
     * TASK-304 Wave 2 W2-SDK-6 — Whisper task selector for the local engine
     * (`'transcribe' | 'translate'`). The local STT processor includes this
     * in its provider cache key.
     */
    task?: 'transcribe' | 'translate';
  };
}

/**
 * Default transcription pipeline configuration.
 */
export const DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG: TranscriptionPipelineConfig = {
  contextOwnership: 'borrowed',
  noiseFilter: {
    enabled: true,
    location: 'browser',
    level: 'high',
  },
  vad: {
    enabled: true,
    location: 'browser',
    sensitivity: 0.5,
    minSpeechDuration: 250,
    minSilenceDuration: 300,
  },
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
  ner: {
    enabled: true,
    location: 'browser',
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
  toggleStage: (stage: 'noiseFilter' | 'vad' | 'stt', enabled: boolean) => Promise<void>;
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
