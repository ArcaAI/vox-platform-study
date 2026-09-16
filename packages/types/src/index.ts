/**
 * @arcaai/types
 * Shared TypeScript type definitions for ArcaAI / HOPE application
 */

export * from './meeting.js';
export * from './audio.js';
export * from './transcription.js';
export * from './diarization.js';
export * from './llm.js';
export * from './common.js';
export * from './storage.js';
export * from './cloud-storage.js';
export * from './voice-recognition.js';
export * from './speaker-mapping.js';
export * from './vad.js';
export * from './model-management.js';
export * from './stepper.js';

// TASK-863 — the resolved-agent contract (gateway ↔ harness ↔ SDK).
export * from './agent.js';

// TASK-861 — the gateway-resolved ASR runtime contract (gateway → apps/stt), replacing AsrPipeline.configYaml.
export * from './asr-spec.js';

// TASK-934 — the per-model ASR decode profile (`AiModel._metadata.asr`) the spec builder folds in.
export * from './asr-model-profile.js';

// TASK-879 — the gateway-resolved TTS runtime contract (gateway → apps/tts), replacing the TenantTtsConfig fold.
export * from './tts-spec.js';

// The consultation-context contract: open refusal codes and the governing-run summary shape,
// shared by the gateway, both SDKs, and codegen.
export * from './consultation-context.js';

// API-key scope presets — the console's "Purpose" radio cards and the seed's day-1 scope set.
export * from './api-key-presets.js';
