/**
 * @arcaai/room - Processors Module
 *
 * Audio processor types, base classes, and built-in processors.
 */

// Types
export {
  type TrackProcessor,
  type EventEmittingProcessor,
  type ProcessorOptions,
  type AudioProcessorOptions,
  type ProcessorFactory,
  type ProcessorConfig,
  ProcessorStatus,
  type ProcessorInfo,
  // Shared stats interfaces
  type BaseProcessorStats,
  type AudioProcessorStats,
  type TextProcessorStats,
} from './types.js';

// Base Processor (Audio)
export { BaseProcessor } from './BaseProcessor.js';

// Base Processor (Text)
export { BaseTextProcessor, type TextProcessorOptions } from './BaseTextProcessor.js';

// Native Processor
export { NativeProcessor, createNativeProcessor, type NativeProcessorOptions } from './NativeProcessor.js';
