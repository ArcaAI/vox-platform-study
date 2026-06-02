/**
 * @arcaai/vox - Model Registry Types
 *
 * Types for the model registry system that manages ML models
 * for STT, VAD, and NER capabilities.
 */

import type { ModelDefinition } from './config';

// =============================================================================
// Model Registry
// =============================================================================

/**
 * Model registry state
 */
export interface ModelRegistryState {
  /** All available models */
  models: ModelDefinition[];
  /** Selected models by type */
  selected: SelectedModels;
  /** Model loading states */
  loading: ModelLoadingStates;
  /** Loading errors by model ID */
  errors: Record<string, Error>;
}

/**
 * Whisper inference task for local STT.
 *
 * - `'transcribe'` — output text in the source language (default).
 * - `'translate'` — translate the source audio to English (multilingual
 *   checkpoints only; English-only `.en` models reject this upstream).
 *
 * @see TASK-329 P3
 */
export type SttTask = 'transcribe' | 'translate';

/**
 * Selected models by type.
 *
 * TASK-329 P3 — `sttTask` persists the user's chosen Whisper task alongside the
 * selected STT model in the SAME tenant/user-namespaced row, so a user's local
 * transcribe/translate choice survives reload.
 */
export interface SelectedModels {
  stt?: string;
  vad?: string;
  ner?: string;
  sttTask?: SttTask;
}

/**
 * Model loading states
 */
export interface ModelLoadingStates {
  /** Currently loading model IDs */
  loadingModels: string[];
  /** Model load progress by ID (0-100) */
  progress: Record<string, number>;
}

// =============================================================================
// Model Loading
// =============================================================================

/**
 * Model load progress event
 */
export interface ModelLoadProgress {
  /** Model ID */
  modelId: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Current status */
  status: ModelLoadStatus;
  /** Bytes loaded */
  loadedBytes?: number;
  /** Total bytes */
  totalBytes?: number;
  /** Current file being loaded (for multi-file models) */
  currentFile?: string;
}

/**
 * Model load status
 */
export type ModelLoadStatus = 'pending' | 'downloading' | 'loading' | 'ready' | 'error';

/**
 * Model load options
 */
export interface ModelLoadOptions {
  /** Force reload even if cached */
  forceReload?: boolean;
  /** Progress callback */
  onProgress?: (progress: ModelLoadProgress) => void;
}

// =============================================================================
// Default Models
// =============================================================================

/**
 * Default public STT models (HuggingFace)
 */
export const DEFAULT_STT_MODELS: ModelDefinition[] = [
  {
    id: 'whisper-tiny',
    name: 'Whisper Tiny',
    type: 'stt',
    source: 'huggingface',
    size: 'tiny',
    description: 'Fastest, suitable for real-time transcription (~39M params)',
  },
  {
    id: 'whisper-base',
    name: 'Whisper Base',
    type: 'stt',
    source: 'huggingface',
    size: 'small',
    description: 'Good balance of speed and accuracy (~74M params)',
  },
  {
    id: 'whisper-small',
    name: 'Whisper Small',
    type: 'stt',
    source: 'huggingface',
    size: 'medium',
    description: 'Better accuracy, moderate speed (~244M params)',
  },
];

/**
 * TASK-329 P3 — display metadata for the browser-viable STT models. Co-located
 * with `DEFAULT_STT_MODELS` so the presented list and the loadable list share
 * one source of truth (the previous drift advertised `whisper-medium` in the
 * registry while the config default only ever offered tiny/base/small).
 */
const STT_MODEL_SIZE_LABELS: Record<string, string> = {
  'whisper-tiny': '~75 MB',
  'whisper-base': '~150 MB',
  'whisper-small': '~500 MB',
};

/**
 * A locally-selectable STT model as presented in the UI (id + display name +
 * optional human-readable download size).
 */
export interface AvailableSttModel {
  id: string;
  name: string;
  size?: string;
}

/**
 * The default presented STT model list, DERIVED from `DEFAULT_STT_MODELS`.
 *
 * `ConfigSchema.SttConfigSchema.availableModels` defaults to this so the
 * "presented" set can never drift from the registry-"selectable/loadable" set
 * again (TASK-329 P3 single-source-of-truth fix).
 */
export const DEFAULT_AVAILABLE_STT_MODELS: AvailableSttModel[] = DEFAULT_STT_MODELS.map((model) => ({
  id: model.id,
  name: model.name,
  ...(STT_MODEL_SIZE_LABELS[model.id] ? { size: STT_MODEL_SIZE_LABELS[model.id] } : {}),
}));

/**
 * Default VAD models
 */
export const DEFAULT_VAD_MODELS: ModelDefinition[] = [
  {
    id: 'silero-vad-v5',
    name: 'Silero VAD v5',
    type: 'vad',
    source: 'huggingface',
    description: 'Latest Silero VAD with improved accuracy',
  },
  {
    id: 'silero-vad-v4',
    name: 'Silero VAD v4',
    type: 'vad',
    source: 'huggingface',
    description: 'Legacy Silero VAD for compatibility',
  },
];

/**
 * All default models
 */
export const DEFAULT_MODELS: ModelDefinition[] = [...DEFAULT_STT_MODELS, ...DEFAULT_VAD_MODELS];

// =============================================================================
// Model Registry Actions
// =============================================================================

/**
 * Model registry actions interface
 */
export interface ModelRegistryActions {
  /** Get all available models */
  getModels: () => ModelDefinition[];
  /** Get models by type */
  getModelsByType: (type: 'stt' | 'vad' | 'ner') => ModelDefinition[];
  /** Get selected model for a type */
  getSelectedModel: (type: 'stt' | 'vad' | 'ner') => ModelDefinition | undefined;
  /** Select a model for a type */
  selectModel: (type: 'stt' | 'vad' | 'ner', modelId: string) => void;
  /** Load a model */
  loadModel: (modelId: string, options?: ModelLoadOptions) => Promise<void>;
  /** Add custom models */
  addCustomModels: (models: ModelDefinition[]) => void;
  /** Load custom models from backend */
  loadCustomModelsFromBackend: () => Promise<void>;
  /** Get model URL for loading */
  getModelUrl: (modelId: string) => string | undefined;
  /** Check if model is loaded */
  isModelLoaded: (modelId: string) => boolean;
  /** Get model load progress */
  getLoadProgress: (modelId: string) => number;
}
