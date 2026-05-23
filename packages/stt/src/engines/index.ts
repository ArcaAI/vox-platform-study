/**
 * @arcaai/stt - Engines
 *
 * STT engine implementations.
 */

// Types
export type { EngineConfig, TranscribeOptions, EngineStats, STTEngine } from './types.js';

// Errors
export { STTWorkerCrashError } from './errors.js';

// Base
export { BaseEngine } from './BaseEngine.js';

// Implementations
export { WhisperEngine } from './WhisperEngine.js';

/**
 * WhisperWorkerEngine - Runs Whisper in a Web Worker for non-blocking transcription.
 *
 * Recommended for production use as it keeps the UI responsive during
 * long transcription operations.
 */
export { WhisperWorkerEngine } from './WhisperWorkerEngine.js';
