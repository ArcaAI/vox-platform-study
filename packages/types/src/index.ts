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

// TASK-879 — the gateway-resolved TTS runtime contract (gateway → apps/tts), replacing the TenantTtsConfig fold.
export * from './tts-spec.js';
