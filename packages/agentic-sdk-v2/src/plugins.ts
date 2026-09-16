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

/**
 * @deprecated TASK-865 — removed in R4. `useVAD`, `useSTT` and `useNoiseFilter` exist only to run
 * a model in the browser; the browser never runs a model. Capture with `useArcaAudio` and let the
 * tenant's ASR Agent decide VAD/denoise/ASR server-side (`audio.start({ agentSlug })`).
 *
 * These are the GATED wrappers (TASK-977 D-6), not the raw package hooks: they are inert unless
 * the host sets `audio.clientInference: { allow: true }`, the same switch `TranscriptionPipeline`
 * reads. `useSTT` is gated narrowly — only `provider: 'local'` (in-browser Whisper); the default
 * `'remote'` capture/transport path passes straight through. See `hooks/useGatedClientStages.ts`.
 */
export { useVAD, useSTT, useNoiseFilter } from './hooks/useGatedClientStages';
export type { UseVADOptions, UseVADReturn } from '@arcaai/vad';
export type { UseSTTOptions, UseSTTReturn } from '@arcaai/stt';
export type { UseNoiseFilterOptions, UseNoiseFilterReturn } from '@arcaai/noise-filter';

// =============================================================================
// SDK Audio Hook
// =============================================================================
//
// `useArcaAudio` is the SDK's first-party audio facade (capture / mute / plugin
// control). Its `UseArcaAudio` *type* ships from `@arcaai/vox/core`, but the
// runtime hook is surfaced here so it flows through the full `@arcaai/vox`
// barrel WITHOUT adding audio code to the `core` public API (core stays
// audio-free; core consumers use `useArca().audio`).
export { useArcaAudio } from './hooks/useArcaAudio';

// Native 2-way STT provider toggle (pipeline ↔ default) — a thin adapter over
// `useArcaAudio`, so it ships alongside it here.
// @deprecated TASK-865 — removed in R4 (see the hook's own JSDoc).
export { useSttProviderToggle, type UseSttProviderToggleReturn } from './hooks/useSttProviderToggle';

// `useTtsPlayback` — streamed TTS audio playback (summary read-aloud).
// Lives in the plugins entry so Web Audio / room code stays out of `core`.
export { useTtsPlayback } from './hooks/useTtsPlayback';
export type { UseTtsPlayback, SpeakOptions } from './hooks/useTtsPlayback';
export { useTtsStream } from './hooks/useTtsStream';
export type { UseTtsStream, TtsStreamOptions } from './hooks/useTtsStream';

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
