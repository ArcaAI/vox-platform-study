/**
 * @arcaai/room - NativeProcessor
 *
 * A pass-through processor that applies WebRTC native constraints.
 * Useful for ensuring specific audio processing features are enabled.
 */

import { BaseProcessor } from './BaseProcessor.js';
import type { AudioProcessorOptions } from './types.js';
import { AudioFeature } from '../types/index.js';
import { applyFeatureConstraint } from '../utils/constraints.js';

/**
 * Native processor options.
 */
export interface NativeProcessorOptions {
  /** Enable echo cancellation */
  echoCancellation?: boolean;
  /** Enable noise suppression */
  noiseSuppression?: boolean;
  /** Enable auto gain control */
  autoGainControl?: boolean;
  /** Enable voice isolation (experimental) */
  voiceIsolation?: boolean;
}

/**
 * NativeProcessor applies WebRTC native audio processing constraints.
 *
 * This is a pass-through processor that doesn't modify the audio stream
 * directly but ensures specific browser-native features are enabled.
 *
 * @example
 * ```typescript
 * const nativeProcessor = new NativeProcessor({
 *   echoCancellation: true,
 *   noiseSuppression: true,
 *   autoGainControl: true,
 * });
 *
 * await audioTrack.setProcessor(nativeProcessor);
 * ```
 */
export class NativeProcessor extends BaseProcessor {
  private options: NativeProcessorOptions;

  constructor(options: NativeProcessorOptions = {}) {
    super('native-processor');
    this.options = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: false,
      ...options,
    };
  }

  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    // Apply constraints to the source track
    if (opts.track) {
      await this.applyConstraints(opts.track);
    }

    // Pass through the original track
    this.processedTrack = opts.track;
  }

  protected async onDestroy(): Promise<void> {
    // No cleanup needed - we don't own the track
    this.processedTrack = undefined;
  }

  /**
   * Apply the configured constraints to a track.
   */
  private async applyConstraints(track: MediaStreamTrack): Promise<void> {
    if (this.options.echoCancellation !== undefined) {
      await applyFeatureConstraint(track, AudioFeature.ECHO_CANCELLATION, this.options.echoCancellation);
    }

    if (this.options.noiseSuppression !== undefined) {
      await applyFeatureConstraint(track, AudioFeature.NOISE_SUPPRESSION, this.options.noiseSuppression);
    }

    if (this.options.autoGainControl !== undefined) {
      await applyFeatureConstraint(track, AudioFeature.AUTO_GAIN_CONTROL, this.options.autoGainControl);
    }

    if (this.options.voiceIsolation !== undefined) {
      try {
        await applyFeatureConstraint(track, AudioFeature.VOICE_ISOLATION, this.options.voiceIsolation);
      } catch {
        // Voice isolation may not be supported
        console.warn('Voice isolation not supported');
      }
    }
  }

  /**
   * Update the processor options and reapply constraints.
   */
  async updateOptions(options: Partial<NativeProcessorOptions>): Promise<void> {
    this.options = { ...this.options, ...options };

    if (this.processedTrack) {
      await this.applyConstraints(this.processedTrack);
    }
  }

  /**
   * Get the current options.
   */
  getOptions(): NativeProcessorOptions {
    return { ...this.options };
  }
}

/**
 * Create a native processor instance.
 *
 * @param options - Processor options
 * @returns NativeProcessor instance
 */
export function createNativeProcessor(options?: NativeProcessorOptions): NativeProcessor {
  return new NativeProcessor(options);
}
