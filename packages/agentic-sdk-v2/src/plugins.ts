/**
 * @arcaai/vox/plugins
 *
 * Plugin exports: the SDK audio facade, TTS playback, and the plugin/pipeline
 * managers that drive backend STT.
 *
 * TASK-1006 (following TASK-865): the browser never runs a model. The gated
 * `useVAD` / `useSTT` / `useNoiseFilter` re-exports, `useSttProviderToggle`,
 * and `createProcessedAudioTap` (RNNoise) were removed along with the client
 * stages they existed to run.
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
 * const { useArcaAudio } = plugins;
 * ```
 *
 * @packageDocumentation
 */

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
 * TranscriptionPipeline hosts the backend STT stage over the streaming
 * transport (the browser never runs a model — TASK-865/TASK-1006).
 */
export { TranscriptionPipeline, createTranscriptionPipeline } from './core/TranscriptionPipeline';

/**
 * KnowledgePipeline handles text processing: NER, SpellCheck, Summary.
 * Client-side NER (`@arcaai/med-ner`) was removed (TASK-1006) — entity
 * extraction is a server-side agent task (`useAgentInvocation`).
 */
export { KnowledgePipeline, createKnowledgePipeline, type TriggerMode } from './core/KnowledgePipeline';
