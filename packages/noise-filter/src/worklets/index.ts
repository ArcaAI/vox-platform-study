/**
 * @arcaai/noise-filter - Worklets Module
 *
 * AudioWorklet utilities for RNNoise processing.
 */

export {
  WORKLET_PROCESSOR_NAME,
  registerRNNoiseWorklet,
  isWorkletRegistered,
  createRNNoiseWorkletNode,
  cleanupWorkletResources,
} from './worklet-loader.js';
