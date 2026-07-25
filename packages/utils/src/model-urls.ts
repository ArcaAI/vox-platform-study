/**
 * Model URLs Configuration
 *
 * Centralized configuration for all ONNX model URLs
 * Models are downloaded from CDN or official sources
 */

import type { ModelConfig } from './ModelDownloader';

/**
 * Silero VAD Model
 * Voice Activity Detection
 *
 * @see https://github.com/snakers4/silero-vad
 */
export const SILERO_VAD_MODEL: ModelConfig = {
  name: 'silero-vad-v5',
  url: 'https://cdn.jsdelivr.net/gh/snakers4/silero-vad@master/src/silero_vad/data/silero_vad.onnx',
  version: '5.0',
  size: 1800000, // ~1.8MB
};

/**
 * Speaker Embedding Model (ECAPA-TDNN)
 * For voice enrollment and speaker recognition
 *
 * Note: Using a lightweight alternative until ECAPA-TDNN is available
 *
 * Options:
 * 1. Hugging Face ONNX Community models
 * 2. Custom converted ECAPA-TDNN
 * 3. Lightweight ResNet-based model
 */
export const SPEAKER_EMBEDDING_MODEL: ModelConfig = {
  name: 'speaker-embedding',
  // Using a publicly available speaker embedding model
  // This is a placeholder - you may need to host your own converted model
  url: 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34/resolve/main/model.onnx',
  version: '1.0',
  size: 15000000, // ~15MB
};

/**
 * Alternative: Lightweight speaker embedding model
 * Smaller and faster, but slightly lower accuracy
 */
export const SPEAKER_EMBEDDING_MODEL_LITE: ModelConfig = {
  name: 'speaker-embedding-lite',
  url: 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/model.onnx',
  version: '1.0',
  size: 8000000, // ~8MB
};

/**
 * Pyannote Speaker Diarization Embedding Model
 * For speaker diarization (clustering)
 *
 * @see https://github.com/pyannote/pyannote-audio
 */
export const DIARIZATION_EMBEDDING_MODEL: ModelConfig = {
  name: 'diarization-embedding',
  // Using pyannote embedding model (if available in ONNX format)
  // This may need custom conversion
  url: 'https://huggingface.co/pyannote/embedding/resolve/main/pytorch_model.bin',
  version: '3.1',
  size: 17000000, // ~17MB
};

/**
 * Model registry
 * Maps model names to their configurations
 */
export const MODEL_REGISTRY: Record<string, ModelConfig> = {
  'silero-vad-v5': SILERO_VAD_MODEL,
  'speaker-embedding': SPEAKER_EMBEDDING_MODEL,
  'speaker-embedding-lite': SPEAKER_EMBEDDING_MODEL_LITE,
  'diarization-embedding': DIARIZATION_EMBEDDING_MODEL,
};

/**
 * Get model configuration by name
 *
 * @param name - Model name
 * @returns Model configuration
 */
export function getModelConfig(name: string): ModelConfig {
  const config = MODEL_REGISTRY[name];
  if (!config) {
    throw new Error(`Model configuration not found: ${name}`);
  }
  return config;
}

/**
 * Model download priorities
 * Higher priority models are downloaded first
 */
export const MODEL_PRIORITIES = {
  'silero-vad-v5': 1, // Essential for VAD
  'speaker-embedding': 2, // Essential for voice enrollment
  'diarization-embedding': 3, // Essential for diarization
};

/**
 * Get all essential models
 * These models should be downloaded on app initialization
 */
export function getEssentialModels(): ModelConfig[] {
  return [SILERO_VAD_MODEL, SPEAKER_EMBEDDING_MODEL];
}

/**
 * Get optional models
 * These can be downloaded on-demand
 */
export function getOptionalModels(): ModelConfig[] {
  return [SPEAKER_EMBEDDING_MODEL_LITE, DIARIZATION_EMBEDDING_MODEL];
}
