/**
 * @arcaai/vad - VAD AudioWorklet Processor
 *
 * AudioWorklet processor for real-time Voice Activity Detection.
 * This worklet handles audio frame accumulation and communicates with
 * the main thread for VAD processing via @ricky0123/vad-web.
 *
 * Note: The actual Silero VAD inference is done via the vad-web library
 * on the main thread or its internal worklet. This worklet is primarily
 * for audio level monitoring and passthrough when used as a processor.
 */

import type {
  VADWorkletInboundMessage,
  VADWorkletOutboundMessage,
  VADWorkletConfig,
  VADStats,
} from '../types/index.js';

/**
 * AudioWorklet render quantum size (128 samples per process call).
 */
const RENDER_QUANTUM = 128;

/**
 * VAD AudioWorklet Processor
 *
 * Processes audio in real-time, monitoring levels and passing through audio.
 * Works in conjunction with the VADProcessor which uses vad-web for
 * actual voice activity detection.
 */
class VADWorkletProcessor extends AudioWorkletProcessor {
  // Processing state
  private initialized = false;
  private enabled = true;
  private config: VADWorkletConfig | null = null;

  // Frame buffering for VAD
  private frameBuffer: Float32Array;
  private frameBufferIndex = 0;

  // Statistics
  private framesProcessed = 0;
  private speechFrames = 0;
  private isSpeaking = false;
  private lastProbability = 0;
  private speechStartTime = 0;
  private averageProbabilitySum = 0;
  private averageProbabilityCount = 0;
  private misfireCount = 0;
  private speechSegmentsDetected = 0;

  constructor() {
    super();

    // Default to v5 frame size (512 samples)
    this.frameBuffer = new Float32Array(512);

    // Handle messages from main thread
    this.port.onmessage = (event: MessageEvent<VADWorkletInboundMessage>) => {
      this.handleMessage(event.data);
    };
  }

  /**
   * Handle messages from the main thread.
   */
  private handleMessage(message: VADWorkletInboundMessage): void {
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

  /**
   * Initialize the processor with configuration.
   */
  private initProcessor(config: VADWorkletConfig): void {
    this.config = config;
    this.frameBuffer = new Float32Array(config.frameSamples);
    this.frameBufferIndex = 0;
    this.framesProcessed = 0;
    this.speechFrames = 0;
    this.isSpeaking = false;
    this.lastProbability = 0;
    this.initialized = true;

    this.sendMessage({ type: 'ready' });
  }

  /**
   * Process audio data (called by AudioWorklet runtime).
   * This is a passthrough processor - audio passes through unchanged.
   * The main VAD processing is done by vad-web on the main thread.
   */
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];

    if (!input || !output) {
      return true;
    }

    // Always pass through audio unchanged
    output.set(input);

    // If not initialized or disabled, skip VAD processing
    if (!this.initialized || !this.enabled || !this.config) {
      return true;
    }

    // Accumulate samples into frame buffer
    for (let i = 0; i < input.length; i++) {
      this.frameBuffer[this.frameBufferIndex] = input[i]!;
      this.frameBufferIndex++;

      // When we have a full frame, send it to main thread
      if (this.frameBufferIndex >= this.config.frameSamples) {
        // Copy frame data to send
        const frameData = new Float32Array(this.frameBuffer);

        // Send frame to main thread for VAD processing
        this.port.postMessage(
          {
            type: 'frame' as const,
            isSpeech: this.isSpeaking,
            probability: this.lastProbability,
            timestamp: currentTime * 1000,
            frameData,
          },
          [frameData.buffer]
        );

        this.frameBufferIndex = 0;
        this.framesProcessed++;
      }
    }

    return true;
  }

  /**
   * Update VAD state from main thread.
   * Called when vad-web processes a frame and determines speech state.
   */
  updateVADState(isSpeech: boolean, probability: number): void {
    const wasSpeaking = this.isSpeaking;
    this.isSpeaking = isSpeech;
    this.lastProbability = probability;

    // Update statistics
    this.averageProbabilitySum += probability;
    this.averageProbabilityCount++;

    if (isSpeech) {
      this.speechFrames++;
      if (!wasSpeaking) {
        // Speech just started
        this.speechStartTime = currentTime * 1000;
      }
    } else if (wasSpeaking) {
      // Speech just ended
      this.speechSegmentsDetected++;
    }
  }

  /**
   * Send processing statistics to main thread.
   */
  private sendStats(): void {
    const currentSpeechDuration = this.isSpeaking
      ? currentTime * 1000 - this.speechStartTime
      : 0;

    const averageProbability =
      this.averageProbabilityCount > 0
        ? this.averageProbabilitySum / this.averageProbabilityCount
        : 0;

    const stats: VADStats = {
      isActive: this.enabled && this.initialized,
      isSpeaking: this.isSpeaking,
      speechProbability: this.lastProbability,
      currentSpeechDuration,
      framesProcessed: this.framesProcessed,
      speechSegmentsDetected: this.speechSegmentsDetected,
      misfireCount: this.misfireCount,
      averageSpeechProbability: averageProbability,
      timestamp: Date.now(),
    };

    this.sendMessage({ type: 'stats', stats });
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    this.initialized = false;
    this.config = null;
    this.frameBufferIndex = 0;
    this.framesProcessed = 0;

    this.sendMessage({ type: 'destroyed' });
  }

  /**
   * Send a message to the main thread.
   */
  private sendMessage(message: VADWorkletOutboundMessage): void {
    this.port.postMessage(message);
  }
}

// Register the worklet processor
registerProcessor('vad-worklet-processor', VADWorkletProcessor);
