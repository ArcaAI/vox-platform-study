/**
 * Model Registry
 *
 * Central registry of all available ONNX models for Arcaai
 *
 * Models can be served from:
 * 1. Remote CDN (Hugging Face, GitHub, Silero) - Default
 * 2. Local static files (/models/{category}/{filename})
 * 3. Custom user-provided URLs
 */

import type { ModelMetadata } from '@arcaai/types';
import { ModelCategory, ModelPriority } from '@arcaai/types';

/**
 * Model source configuration
 */
export interface ModelSource {
  remote: string; // Remote CDN URL
  local?: string; // Local static file path (relative to /public)
}

/**
 * Extended model metadata with multiple sources
 */
export interface ModelRegistryEntry extends ModelMetadata {
  sources: ModelSource;
  fileSize?: number; // Actual file size in bytes (if known)
  format: 'onnx' | 'bin' | 'safetensors';
  quantization?: 'fp32' | 'fp16' | 'int8' | 'int4' | 'bnb4';
  managedBy?: 'transformers.js' | 'manual'; // Indicates if model is auto-managed by a library
}

/**
 * Voice Activity Detection Models
 */
export const VAD_MODELS: ModelRegistryEntry[] = [
  {
    id: 'silero-vad-v5',
    name: 'silero-vad-v5',
    displayName: 'Silero VAD',
    description: 'Voice Activity Detection model for detecting speech in audio (standard)',
    category: ModelCategory.VAD,
    priority: ModelPriority.ESSENTIAL,
    version: '5.0',
    size: 1800000, // ~1.8MB
    url: 'https://github.com/snakers4/silero-vad/raw/refs/heads/master/src/silero_vad/data/silero_vad.onnx',
    sources: {
      remote: 'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx',
      local: '/models/vad/silero_vad_v5.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Fast inference, < 50ms latency',
    },
  },
  {
    id: 'silero-vad-16k-op15',
    name: 'silero-vad-16k-op15',
    displayName: 'Silero VAD 16kHz (Opset 15)',
    description: 'Voice Activity Detection optimized for 16kHz audio with ONNX Opset 15',
    category: ModelCategory.VAD,
    priority: ModelPriority.RECOMMENDED,
    version: '4.0',
    size: 1800000, // ~1.8MB
    url: 'https://github.com/snakers4/silero-vad/raw/refs/heads/master/src/silero_vad/data/silero_vad_16k_op15.onnx',
    sources: {
      remote: 'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad_16k_op15.onnx',
      local: '/models/vad/silero_vad_16k_op15.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Optimized for 16kHz audio, ONNX Opset 15',
    },
  },
  {
    id: 'silero-vad-half',
    name: 'silero-vad-half',
    displayName: 'Silero VAD Half Precision',
    description: 'Voice Activity Detection with FP16 precision (smaller, faster)',
    category: ModelCategory.VAD,
    priority: ModelPriority.OPTIONAL,
    version: '4.0',
    size: 900000, // ~900KB
    url: 'https://github.com/snakers4/silero-vad/raw/refs/heads/master/src/silero_vad/data/silero_vad_half.onnx',
    sources: {
      remote: 'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad_half.onnx',
      local: '/models/vad/silero_vad_half.onnx',
    },
    format: 'onnx',
    quantization: 'fp16',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Half precision, 50% smaller, faster inference',
    },
  },
];

/**
 * Speech-to-Text / Transcription Models
 */
export const TRANSCRIPTION_MODELS: ModelRegistryEntry[] = [
  // Whisper Models (via Transformers.js)
  // Note: These models are automatically managed by @huggingface/transformers
  // No manual download needed - they are cached in browser IndexedDB automatically
  {
    id: 'whisper-tiny-en',
    name: 'whisper-tiny-en',
    displayName: 'Whisper Tiny (English)',
    description: 'Fast English-only transcription. 4-5x real-time speed. Best for quick results.',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.RECOMMENDED,
    version: '1.0',
    size: 40000000, // ~40MB
    url: 'https://huggingface.co/onnx-community/whisper-tiny',
    sources: {
      remote: 'https://huggingface.co/onnx-community/whisper-tiny',
      local: '/models/transcription/whisper-tiny',
    },
    format: 'onnx',
    quantization: 'fp32',
    managedBy: 'transformers.js', // Auto-managed by Transformers.js
    compatibility: {
      features: ['WebAssembly', 'WebWorkers', 'Transformers.js'],
      performanceNotes: 'Fast inference, 4-5x real-time, English only. Auto-downloaded on first use.',
    },
  },
  {
    id: 'whisper-base',
    name: 'whisper-base',
    displayName: 'Whisper Base (Multilingual)',
    description: 'Balanced speed and accuracy. Supports 99+ languages. 2-3x real-time speed.',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.ESSENTIAL,
    version: '1.0',
    size: 140000000, // ~140MB
    url: 'https://huggingface.co/onnx-community/whisper-base',
    sources: {
      remote: 'https://huggingface.co/onnx-community/whisper-base',
      local: '/models/transcription/whisper-base',
    },
    format: 'onnx',
    quantization: 'fp32',
    managedBy: 'transformers.js', // Auto-managed by Transformers.js
    compatibility: {
      features: ['WebAssembly', 'WebWorkers', 'Transformers.js'],
      performanceNotes: 'Balanced performance, multilingual, 99+ languages. Auto-downloaded on first use.',
    },
  },
  {
    id: 'whisper-small',
    name: 'whisper-small',
    displayName: 'Whisper Small (Multilingual)',
    description: 'Highest accuracy. Slower processing. For critical transcriptions. 1-1.5x real-time.',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.OPTIONAL,
    version: '1.0',
    size: 460000000, // ~460MB
    url: 'https://huggingface.co/onnx-community/whisper-small',
    sources: {
      remote: 'https://huggingface.co/onnx-community/whisper-small',
      local: '/models/transcription/whisper-small',
    },
    format: 'onnx',
    quantization: 'fp32',
    managedBy: 'transformers.js', // Auto-managed by Transformers.js
    compatibility: {
      features: ['WebAssembly', 'WebWorkers', 'Transformers.js'],
      performanceNotes: 'Best accuracy, multilingual, slower inference. Auto-downloaded on first use.',
    },
  },
  // Silero STT Models (ONNX Runtime)
  {
    id: 'silero-stt-en-v6',
    name: 'silero-stt-en-v6',
    displayName: 'Silero STT EN v6',
    description: 'English speech-to-text model v6 (latest)',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.RECOMMENDED,
    version: '6.0',
    size: 50000000, // ~50MB (estimate)
    url: 'https://models.silero.ai/models/en/en_v6.onnx',
    sources: {
      remote: 'https://models.silero.ai/models/en/en_v6.onnx',
      local: '/models/transcription/en_v6.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Latest version, improved accuracy',
    },
  },
  {
    id: 'silero-stt-en-v6-xlarge',
    name: 'silero-stt-en-v6-xlarge',
    displayName: 'Silero STT EN v6 XLarge',
    description: 'English speech-to-text model v6 XLarge (highest accuracy)',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.OPTIONAL,
    version: '6.0',
    size: 150000000, // ~150MB (estimate)
    url: 'https://models.silero.ai/models/en/en_v6_xlarge.onnx',
    sources: {
      remote: 'https://models.silero.ai/models/en/en_v6_xlarge.onnx',
      local: '/models/transcription/en_v6_xlarge.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Largest model, best accuracy, slower inference',
    },
  },
  {
    id: 'silero-stt-en-v5',
    name: 'silero-stt-en-v5',
    displayName: 'Silero STT EN v5',
    description: 'English speech-to-text model v5 (stable)',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.ESSENTIAL,
    version: '5.0',
    size: 45000000, // ~45MB (estimate)
    url: 'https://models.silero.ai/models/en/en_v5.onnx',
    sources: {
      remote: 'https://models.silero.ai/models/en/en_v5.onnx',
      local: '/models/transcription/en_v5.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Stable version, good balance of speed and accuracy',
    },
  },
  {
    id: 'silero-stt-en-v5-q',
    name: 'silero-stt-en-v5-q',
    displayName: 'Silero STT EN v5 Quantized',
    description: 'English speech-to-text model v5 quantized (smaller, faster)',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.RECOMMENDED,
    version: '5.0',
    size: 12000000, // ~12MB (estimate)
    url: 'https://models.silero.ai/models/en/en_v5_q.onnx',
    sources: {
      remote: 'https://models.silero.ai/models/en/en_v5_q.onnx',
      local: '/models/transcription/en_v5_q.onnx',
    },
    format: 'onnx',
    quantization: 'int8',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Quantized to INT8, 70% smaller, faster inference',
    },
  },
  {
    id: 'silero-stt-en-v5-xlarge',
    name: 'silero-stt-en-v5-xlarge',
    displayName: 'Silero STT EN v5 XLarge',
    description: 'English speech-to-text model v5 XLarge (high accuracy)',
    category: ModelCategory.TRANSCRIPTION,
    priority: ModelPriority.OPTIONAL,
    version: '5.0',
    size: 140000000, // ~140MB (estimate)
    url: 'https://models.silero.ai/models/en/en_v5_xlarge.onnx',
    sources: {
      remote: 'https://models.silero.ai/models/en/en_v5_xlarge.onnx',
      local: '/models/transcription/en_v5_xlarge.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Large model, high accuracy, slower inference',
    },
  },
];

/**
 * Speaker Diarization Models
 */
export const DIARIZATION_MODELS: ModelRegistryEntry[] = [
  {
    id: 'pyannote-segmentation-3.0',
    name: 'pyannote-segmentation-3.0',
    displayName: 'Pyannote Segmentation 3.0',
    description: 'Speaker diarization model for separating speakers (standard)',
    category: ModelCategory.DIARIZATION,
    priority: ModelPriority.ESSENTIAL,
    version: '3.0',
    size: 17000000, // ~17MB
    url: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model.onnx',
    sources: {
      remote: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model.onnx',
      local: '/models/diarization/pyannote_segmentation_3.0.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Standard precision, best accuracy',
    },
  },
  {
    id: 'pyannote-segmentation-3.0-fp16',
    name: 'pyannote-segmentation-3.0-fp16',
    displayName: 'Pyannote Segmentation 3.0 FP16',
    description: 'Speaker diarization model with half precision (smaller, faster)',
    category: ModelCategory.DIARIZATION,
    priority: ModelPriority.RECOMMENDED,
    version: '3.0',
    size: 8500000, // ~8.5MB
    url: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model_fp16.onnx',
    sources: {
      remote: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model_fp16.onnx',
      local: '/models/diarization/pyannote_segmentation_3.0_fp16.onnx',
    },
    format: 'onnx',
    quantization: 'fp16',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Half precision, 50% smaller, faster inference',
    },
  },
  {
    id: 'pyannote-segmentation-3.0-bnb4',
    name: 'pyannote-segmentation-3.0-bnb4',
    displayName: 'Pyannote Segmentation 3.0 BNB4',
    description: 'Speaker diarization model with 4-bit quantization (smallest)',
    category: ModelCategory.DIARIZATION,
    priority: ModelPriority.OPTIONAL,
    version: '3.0',
    size: 4500000, // ~4.5MB
    url: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model_bnb4.onnx',
    sources: {
      remote: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model_bnb4.onnx',
      local: '/models/diarization/pyannote_segmentation_3.0_bnb4.onnx',
    },
    format: 'onnx',
    quantization: 'bnb4',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: '4-bit quantization, 75% smaller, fastest inference',
    },
  },
];

/**
 * Speaker Recognition Models
 */
export const SPEAKER_RECOGNITION_MODELS: ModelRegistryEntry[] = [
  {
    id: 'pyannote-embedding',
    name: 'pyannote-embedding',
    displayName: 'Pyannote Embedding',
    description: 'Speaker embedding model for voice recognition (recommended, works with raw audio)',
    category: ModelCategory.SPEAKER_RECOGNITION,
    priority: ModelPriority.ESSENTIAL,
    version: '1.0',
    size: 17000000, // ~17MB (estimated)
    url: 'https://huggingface.co/deepghs/pyannote-embedding-onnx/resolve/main/model.onnx',
    sources: {
      remote: 'https://huggingface.co/deepghs/pyannote-embedding-onnx/resolve/main/model.onnx',
      local: '/models/speaker-recognition/pyannote_embedding.onnx',
    },
    format: 'onnx',
    quantization: 'fp32',
    compatibility: {
      features: ['WebAssembly', 'WebWorkers'],
      performanceNotes: 'Works with raw audio, 512D embeddings, proven for speaker verification',
    },
  }
];

/**
 * All models registry
 */
export const ALL_MODELS: ModelRegistryEntry[] = [
  ...VAD_MODELS,
  ...TRANSCRIPTION_MODELS,
  ...DIARIZATION_MODELS,
  ...SPEAKER_RECOGNITION_MODELS,
];

/**
 * Get model by ID
 */
export function getModelById(id: string): ModelRegistryEntry | undefined {
  return ALL_MODELS.find((model) => model.id === id);
}

/**
 * Get models by category
 */
export function getModelsByCategory(category: ModelCategory): ModelRegistryEntry[] {
  return ALL_MODELS.filter((model) => model.category === category);
}

/**
 * Get models by priority
 */
export function getModelsByPriority(priority: ModelPriority): ModelRegistryEntry[] {
  return ALL_MODELS.filter((model) => model.priority === priority);
}

/**
 * Get essential models from registry (should be downloaded on first launch)
 */
export function getEssentialModelsFromRegistry(): ModelRegistryEntry[] {
  return getModelsByPriority(ModelPriority.ESSENTIAL);
}

/**
 * Get model URL (prefers local if available, falls back to remote)
 */
export function getModelUrl(model: ModelRegistryEntry, preferLocal: boolean = false): string {
  if (preferLocal && model.sources.local) {
    return model.sources.local;
  }
  return model.sources.remote;
}

/**
 * Check if model is available locally
 */
export async function isModelAvailableLocally(model: ModelRegistryEntry): Promise<boolean> {
  if (!model.sources.local) return false;

  try {
    // Use global fetch (available in browser and modern Node.js)
    const response = await globalThis.fetch(model.sources.local, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

