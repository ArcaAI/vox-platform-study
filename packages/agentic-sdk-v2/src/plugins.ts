/**
 * @arcaai/vox/plugins
 *
 * Plugin exports including audio processing features (STT, VAD, noise filter).
 * This entry point provides access to ML-powered features.
 *
 * Use this when:
 * - You need to lazy-load audio processing features
 * - You want to code-split plugin functionality
 * - You're building a modular application
 *
 * @example
 * ```tsx
 * // Lazy load plugins
 * const plugins = await import('@arcaai/vox/plugins');
 * const { useVAD, useSTT, useNoiseFilter } = plugins;
 *
 * // Or import directly
 * import { useVAD, useSTT, useNoiseFilter } from '@arcaai/vox/plugins';
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Plugin Hooks (Re-exported from individual packages)
// =============================================================================

/**
 * Re-exported plugin hooks for convenience.
 *
 * These hooks can also be imported directly from their respective packages:
 * - `useVAD` from `@arcaai/vad`
 * - `useSTT` from `@arcaai/stt`
 * - `useNoiseFilter` from `@arcaai/noise-filter`
 * - `useMedNER` from `@arcaai/med-ner` (optional peer dependency)
 */

export { useVAD } from '@arcaai/vad';
export type { UseVADOptions, UseVADReturn } from '@arcaai/vad';

export { useSTT } from '@arcaai/stt';
export type { UseSTTOptions, UseSTTReturn } from '@arcaai/stt';

export { useNoiseFilter } from '@arcaai/noise-filter';
export type { UseNoiseFilterOptions, UseNoiseFilterReturn } from '@arcaai/noise-filter';

// =============================================================================
// Plugin Manager
// =============================================================================

/**
 * PluginManager orchestrates audio processing plugins.
 * It manages the TranscriptionPipeline and KnowledgePipeline.
 */
export { PluginManager, type PluginEventCallbacks, type PluginManagerState } from './core/PluginManager';

// =============================================================================
// Pipelines
// =============================================================================

/**
 * TranscriptionPipeline handles the audio processing flow:
 * Audio Input → NoiseFilter → VAD → STT → Transcription Output
 */
export { TranscriptionPipeline, createTranscriptionPipeline } from './core/TranscriptionPipeline';

/**
 * createProcessedAudioTap exposes the GENUINE post-noise-filter audio as a
 * recordable MediaStream (the same RNNoise NoiseFilterProcessor the pipeline
 * uses), for consumers that need the real processed PCM without driving the
 * full pipeline (e.g. dual capture on a backend-STT path). Opt-in; throws when
 * RNNoise is unavailable so callers can fall back.
 */
export { createProcessedAudioTap } from './core/ProcessedAudioTap';
export type { ProcessedAudioTap, ProcessedAudioTapOptions } from './core/ProcessedAudioTap';

/**
 * KnowledgePipeline handles text processing:
 * Transcription → NER → SpellCheck → Summary
 */
export { KnowledgePipeline, createKnowledgePipeline, type TriggerMode } from './core/KnowledgePipeline';

// =============================================================================
// Medical NER — Separate Entry Point
// =============================================================================
//
// HOOK-04 MIGRATION: `useMedNER` has been moved to `@arcaai/vox/plugins/med-ner`
// to prevent the entire plugins module from failing when @arcaai/med-ner (~300MB)
// is not installed. Import it from the dedicated entry point:
//
//   import { useMedNER } from '@arcaai/vox/plugins/med-ner';
//
// Or directly from the package:
//
//   import { useMedNER } from '@arcaai/med-ner';
//
