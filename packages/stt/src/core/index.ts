/**
 * @arcaai/stt - Core
 *
 * Core STT processor and utilities.
 */

export { STTProcessor, createSTT, type STTStreamingTransport } from './STTProcessor.js';

export { AudioBufferManager, type AudioBufferManagerOptions, type AudioBufferStats, DEFAULT_BUFFER_OPTIONS } from './AudioBufferManager.js';

// AudioWorklet capture utility (ScriptProcessor fallback internal). Exposed
// so consuming apps stop rolling their own capture loops.
export {
  createAudioCapture,
  isAudioWorkletUsable,
  type AudioCaptureHandle,
  type AudioCaptureOptions,
  type AudioFrameCallback,
} from './audioCapture.js';
