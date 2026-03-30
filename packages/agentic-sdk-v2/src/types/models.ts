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
 * Selected models by type
 */
export interface SelectedModels {
  stt?: string;
  vad?: string;
  ner?: string;
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
  {
    id: 'whisper-medium',
    name: 'Whisper Medium',
    type: 'stt',
    source: 'huggingface',
    size: 'large',
    description: 'High accuracy, slower processing (~769M params)',
  },
];

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
