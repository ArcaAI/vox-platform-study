/**
 * @arcaai/vad - Worklets
 *
 * AudioWorklet utilities for VAD processing.
 */

export {
  WORKLET_PROCESSOR_NAME,
  registerVADWorklet,
  isVADWorkletRegistered,
  createVADWorkletNode,
  cleanupVADWorkletResources,
} from './worklet-loader.js';
