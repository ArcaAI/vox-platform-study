/**
 * Type declarations for @jitsi/rnnoise-wasm
 *
 * This module provides RNNoise audio denoising via WebAssembly.
 */

declare module '@jitsi/rnnoise-wasm' {
  export interface DenoiseState {
    /**
     * Process a frame of audio samples.
     * @param input - Float32Array of audio samples (typically 480 samples at 48kHz)
     * @returns Denoised audio samples as Float32Array
     */
    processFrame(input: Float32Array): Float32Array;

    /**
     * Get the VAD (Voice Activity Detection) probability from the last processed frame.
     * @returns A number between 0 and 1 indicating speech probability
     */
    getVadProb(): number;

    /**
     * Destroy the denoise state and free resources.
     */
    destroy(): void;
  }

  export interface RnnoiseInstance {
    /**
     * Create a new denoise state for processing audio.
     * @returns A new DenoiseState instance
     */
    createDenoiseState(): DenoiseState;

    /**
     * Get the frame size expected by RNNoise (typically 480 samples).
     */
    getFrameSize(): number;

    /**
     * Get the sample rate expected by RNNoise (typically 48000 Hz).
     */
    getSampleRate(): number;
  }

  export class Rnnoise {
    /**
     * Load and initialize the RNNoise WASM module.
     * @returns Promise that resolves to an RnnoiseInstance
     */
    static load(): Promise<RnnoiseInstance>;
  }
}
