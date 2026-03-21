/**
 * @arcaai/vad - Worklet Loader
 *
 * Utilities for loading and registering the VAD AudioWorklet processor.
 * Uses @arcaai/room's createWorkletLoader for the blob URL + registration pattern.
 */

import { createWorkletLoader } from '@arcaai/room';
import { VADError, VADErrorCode } from '../types/index.js';

/**
 * Default name for the worklet processor.
 */
export const WORKLET_PROCESSOR_NAME = 'vad-worklet-processor';

/**
 * Generate the worklet source code as a string.
 */
function generateWorkletSource(): string {
  return `
/**
 * Inline VAD AudioWorklet Processor
 * Passthrough audio with frame accumulation for VAD processing.
 */

class VADWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.initialized = false;
    this.enabled = true;
    this.config = null;
    this.frameBuffer = new Float32Array(512);
    this.frameBufferIndex = 0;
    this.framesProcessed = 0;
    this.speechFrames = 0;
    this.isSpeaking = false;
    this.lastProbability = 0;
    this.speechStartTime = 0;
    this.averageProbabilitySum = 0;
    this.averageProbabilityCount = 0;
    this.misfireCount = 0;
    this.speechSegmentsDetected = 0;

    this.port.onmessage = (event) => this.handleMessage(event.data);
  }

  handleMessage(message) {
    switch (message.type) {
      case 'init':
        this.initProcessor(message.config);
        break;
      case 'setEnabled':
        this.enabled = message.enabled;
        break;
      case 'updateThreshold':
        if (this.config) {
          this.config.positiveSpeechThreshold = message.positiveSpeechThreshold;
          this.config.negativeSpeechThreshold = message.negativeSpeechThreshold;
        }
        break;
      case 'getStats':
        this.sendStats();
        break;
      case 'destroy':
        this.cleanup();
        break;
    }
  }

  initProcessor(config) {
    this.config = config;
    this.frameBuffer = new Float32Array(config.frameSamples);
    this.frameBufferIndex = 0;
    this.framesProcessed = 0;
    this.speechFrames = 0;
    this.isSpeaking = false;
    this.lastProbability = 0;
    this.initialized = true;
    this.port.postMessage({ type: 'ready' });
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) return true;

    // Passthrough audio
    output.set(input);

    if (!this.initialized || !this.enabled || !this.config) return true;

    // Accumulate samples
    for (let i = 0; i < input.length; i++) {
      this.frameBuffer[this.frameBufferIndex++] = input[i];

      if (this.frameBufferIndex >= this.config.frameSamples) {
        const frameData = new Float32Array(this.frameBuffer);
        this.port.postMessage({
          type: 'frame',
          isSpeech: this.isSpeaking,
          probability: this.lastProbability,
          timestamp: currentTime * 1000,
          frameData,
        }, [frameData.buffer]);

        this.frameBufferIndex = 0;
        this.framesProcessed++;
      }
    }

    return true;
  }

  sendStats() {
    const currentSpeechDuration = this.isSpeaking
      ? currentTime * 1000 - this.speechStartTime
      : 0;

    const averageProbability = this.averageProbabilityCount > 0
      ? this.averageProbabilitySum / this.averageProbabilityCount
      : 0;

    this.port.postMessage({
      type: 'stats',
      stats: {
        isActive: this.enabled && this.initialized,
        isSpeaking: this.isSpeaking,
        speechProbability: this.lastProbability,
        currentSpeechDuration,
        framesProcessed: this.framesProcessed,
        speechSegmentsDetected: this.speechSegmentsDetected,
        misfireCount: this.misfireCount,
        averageSpeechProbability: averageProbability,
        timestamp: Date.now(),
      },
    });
  }

  cleanup() {
    this.initialized = false;
    this.config = null;
    this.frameBufferIndex = 0;
    this.framesProcessed = 0;
    this.port.postMessage({ type: 'destroyed' });
  }
}

registerProcessor('vad-worklet-processor', VADWorkletProcessor);
`;
}

const loader = createWorkletLoader({
  generateSource: generateWorkletSource,
  label: 'VAD',
});

/**
 * Register the VAD AudioWorklet with an AudioContext.
 *
 * @param audioContext - The AudioContext to register with
 * @param workletUrl - Optional URL to the worklet file (uses blob URL if not provided)
 */
export async function registerVADWorklet(
  audioContext: AudioContext,
  workletUrl?: string
): Promise<void> {
  try {
    await loader.register(audioContext, workletUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    if (message.includes('AudioWorklet is not supported')) {
      throw new VADError(VADErrorCode.NOT_SUPPORTED, message);
    }

    throw new VADError(
      VADErrorCode.WORKLET_REGISTRATION_FAILED,
      `Failed to register AudioWorklet: ${message}`,
      error instanceof Error ? error : undefined
    );
  }
}

/**
 * Check if the worklet is registered for an AudioContext.
 *
 * @param audioContext - The AudioContext to check
 */
export function isVADWorkletRegistered(audioContext: AudioContext): boolean {
  return loader.isRegistered(audioContext);
}

/**
 * Create a VAD AudioWorkletNode.
 *
 * @param audioContext - The AudioContext
 * @returns AudioWorkletNode for VAD processing
 */
export function createVADWorkletNode(
  audioContext: AudioContext
): AudioWorkletNode {
  if (!loader.isRegistered(audioContext)) {
    throw new VADError(
      VADErrorCode.WORKLET_REGISTRATION_FAILED,
      'Worklet not registered. Call registerVADWorklet first.'
    );
  }

  return new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {},
  });
}

/**
 * Clean up the worklet blob URL.
 * Call this when shutting down to free resources.
 */
export function cleanupVADWorkletResources(): void {
  loader.cleanup();
}
