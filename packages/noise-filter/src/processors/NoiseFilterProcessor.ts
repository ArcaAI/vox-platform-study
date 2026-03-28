/**
 * @arcaai/noise-filter - NoiseFilterProcessor
 *
 * Main noise filter processor that extends BaseProcessor from @arcaai/room.
 * Provides AI-powered noise cancellation using RNNoise WASM.
 */

import { BaseProcessor, type AudioProcessorOptions, ProcessorEvent, debugLogConfig } from '@arcaai/room';

import {
  type NoiseFilterOptions,
  type NoiseCancellationLevel,
  type NoiseFilterStats,
  type WorkletOutboundMessage,
  DEFAULT_NOISE_FILTER_OPTIONS,
  NoiseFilterError,
  NoiseFilterErrorCode,
} from '../types/index.js';

import { RNNoiseProcessor } from './RNNoiseProcessor.js';

import { registerRNNoiseWorklet, createRNNoiseWorkletNode, isWorkletRegistered } from '../worklets/worklet-loader.js';

import { getNoiseFilterBrowserSupport, isRNNoiseSupported } from '../utils/browserSupport.js';

/**
 * NoiseFilterProcessor provides AI-powered noise cancellation for audio tracks.
 *
 * Features:
 * - RNNoise-based noise cancellation (WebAssembly)
 * - AudioWorklet for low-latency processing
 * - Configurable noise cancellation levels
 * - Fallback to WebRTC native when unsupported
 * - Statistics emission for monitoring
 *
 * @example
 * ```typescript
 * import { NoiseFilterProcessor } from '@arcaai/noise-filter';
 *
 * const noiseFilter = new NoiseFilterProcessor({
 *   noiseCancellation: true,
 *   noiseCancellationLevel: 'high',
 *   echoCancellation: true,
 * });
 *
 * // Attach to an AudioTrack
 * await audioTrack.setProcessor(noiseFilter);
 *
 * // Listen for stats
 * noiseFilter.on('data', (payload) => {
 *   if (payload.type === 'noise-stats') {
 *     console.log('Noise reduction:', payload.data.noiseReductionDb, 'dB');
 *   }
 * });
 *
 * // Adjust level dynamically
 * await noiseFilter.setNoiseLevel('high');
 *
 * // Cleanup
 * await noiseFilter.destroy();
 * ```
 */
export class NoiseFilterProcessor extends BaseProcessor {
  private options: Required<Omit<NoiseFilterOptions, 'wasmPath' | 'debugMode'>> & {
    wasmPath?: string;
  };

  // Processing components
  private workletNode: AudioWorkletNode | null = null;
  private rnnoiseProcessor: RNNoiseProcessor | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  // Fallback mode (no AudioWorklet support)
  private usingFallback = false;
  private fallbackScriptNode: ScriptProcessorNode | null = null;

  // Stats interval
  private statsInterval: ReturnType<typeof setInterval> | null = null;

  constructor(options: NoiseFilterOptions = {}) {
    super('noise-filter-processor', options.debugMode);

    this.options = {
      ...DEFAULT_NOISE_FILTER_OPTIONS,
      ...options,
    };
  }

  /**
   * Check if this processor is supported in the current browser.
   */
  isSupported(): boolean {
    const support = getNoiseFilterBrowserSupport();
    return support.rnnoiseSupported || support.nativeFallbackAvailable;
  }

  /**
   * Initialize the noise filter processor.
   */
  protected async onInit(opts: AudioProcessorOptions): Promise<void> {
    const { audioContext, track } = opts;

    if (this.debugMode) {
      debugLogConfig('NoiseFilter', {
        noiseCancellation: this.options.noiseCancellation,
        noiseCancellationLevel: this.options.noiseCancellationLevel,
        echoCancellation: this.options.echoCancellation,
        autoGainControl: this.options.autoGainControl,
        processingMode: this.options.processingMode,
        sampleRate: this.options.sampleRate,
      });
    }

    // Check browser support
    const support = getNoiseFilterBrowserSupport();

    if (!support.rnnoiseSupported && !support.nativeFallbackAvailable) {
      throw new NoiseFilterError(NoiseFilterErrorCode.NOT_SUPPORTED, support.unsupportedReason ?? 'Noise filter not supported');
    }

    // Create source node from input track
    const stream = new MediaStream([track]);
    this.sourceNode = audioContext.createMediaStreamSource(stream);

    // Create destination for processed output
    this.destinationNode = audioContext.createMediaStreamDestination();

    if (isRNNoiseSupported() && this.options.noiseCancellation) {
      // Use AudioWorklet for RNNoise processing
      await this.initWorkletProcessing(audioContext);
    } else {
      // Fallback to native processing only
      this.initNativeFallback();
    }

    // Set the processed track
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0];

    // Start stats emission if enabled
    if (this.options.enableStats) {
      this.startStatsEmission();
    }
  }

  /**
   * Initialize AudioWorklet-based RNNoise processing.
   */
  private async initWorkletProcessing(audioContext: AudioContext): Promise<void> {
    try {
      // Register worklet if not already registered
      if (!isWorkletRegistered(audioContext)) {
        await registerRNNoiseWorklet(audioContext);
      }

      // Create worklet node
      this.workletNode = createRNNoiseWorkletNode(audioContext);

      // Handle messages from worklet
      this.workletNode.port.onmessage = (event: MessageEvent<WorkletOutboundMessage>) => {
        this.handleWorkletMessage(event.data);
      };

      // Initialize RNNoise in worklet
      await this.initWorkletRNNoise();

      // Connect audio graph
      this.sourceNode!.connect(this.workletNode);
      this.workletNode.connect(this.destinationNode!);

      this.usingFallback = false;
    } catch (error) {
      console.warn('Failed to initialize AudioWorklet, falling back to ScriptProcessor:', error);
      this.initScriptProcessorFallback();
    }
  }

  /**
   * Initialize RNNoise in the worklet by sending WASM binary.
   */
  private async initWorkletRNNoise(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.workletNode) {
        reject(new Error('Worklet node not created'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Worklet initialization timeout'));
      }, 10000);

      const messageHandler = (event: MessageEvent<WorkletOutboundMessage>) => {
        if (event.data.type === 'ready') {
          clearTimeout(timeout);
          this.workletNode!.port.removeEventListener('message', messageHandler);
          resolve();
        } else if (event.data.type === 'error') {
          clearTimeout(timeout);
          this.workletNode!.port.removeEventListener('message', messageHandler);
          reject(new Error(event.data.message));
        }
      };

      this.workletNode.port.addEventListener('message', messageHandler);

      // Load and send WASM binary
      this.loadWasmBinary()
        .then((wasmBinary) => {
          this.workletNode!.port.postMessage({ type: 'init', wasmBinary }, [wasmBinary]);
        })
        .catch(reject);
    });
  }

  /**
   * Load the RNNoise WASM binary.
   */
  private async loadWasmBinary(): Promise<ArrayBuffer> {
    // Try to load from custom path or use bundled
    const wasmPath = this.options.wasmPath ?? 'https://cdn.jsdelivr.net/npm/@jitsi/rnnoise-wasm/dist/rnnoise.wasm';

    const response = await fetch(wasmPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch WASM: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  /**
   * Initialize ScriptProcessor fallback for browsers without AudioWorklet.
   */
  private initScriptProcessorFallback(): void {
    if (!this.audioContext || !this.sourceNode || !this.destinationNode) {
      return;
    }

    // Create RNNoise processor for main thread processing
    this.rnnoiseProcessor = new RNNoiseProcessor();

    // Initialize RNNoise
    this.rnnoiseProcessor
      .init()
      .then(() => {
        // Set initial options
        this.rnnoiseProcessor!.setLevel(this.options.noiseCancellationLevel);
        this.rnnoiseProcessor!.setEnabled(this.options.noiseCancellation);
      })
      .catch((error) => {
        console.error('Failed to initialize RNNoise:', error);
      });

    // Create ScriptProcessorNode (deprecated but works everywhere)
    // Buffer size of 4096 for reasonable latency
    this.fallbackScriptNode = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.fallbackScriptNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const output = event.outputBuffer.getChannelData(0);

      if (this.rnnoiseProcessor && this._enabled) {
        this.rnnoiseProcessor.process(input, output);
      } else {
        output.set(input);
      }
    };

    // Connect audio graph
    this.sourceNode.connect(this.fallbackScriptNode);
    this.fallbackScriptNode.connect(this.destinationNode);

    this.usingFallback = true;
  }

  /**
   * Initialize native-only fallback (no RNNoise).
   */
  private initNativeFallback(): void {
    // Just pass through - WebRTC native constraints handle the processing
    this.sourceNode!.connect(this.destinationNode!);
    this.usingFallback = true;
  }

  /**
   * Handle messages from the AudioWorklet.
   */
  private handleWorkletMessage(message: WorkletOutboundMessage): void {
    switch (message.type) {
      case 'stats':
        this.emitData('noise-stats', message.stats);
        break;
      case 'error':
        this.emit(ProcessorEvent.Error, {
          error: new Error(message.message),
          recoverable: true,
        });
        break;
      case 'destroyed':
        // Worklet cleaned up
        break;
    }
  }

  /**
   * Start periodic stats emission.
   */
  private startStatsEmission(): void {
    this.statsInterval = setInterval(() => {
      if (this.workletNode) {
        this.workletNode.port.postMessage({ type: 'getStats' });
      } else if (this.rnnoiseProcessor) {
        const stats = this.rnnoiseProcessor.getStats();
        this.emitData('noise-stats', stats);
      }
    }, this.options.statsInterval);
  }

  /**
   * Stop stats emission.
   */
  private stopStatsEmission(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }

  /**
   * Destroy the processor and release resources.
   */
  protected async onDestroy(): Promise<void> {
    this.stopStatsEmission();

    // Clean up worklet
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'destroy' });
      this.workletNode.disconnect();
      this.workletNode = null;
    }

    // Clean up RNNoise processor
    if (this.rnnoiseProcessor) {
      this.rnnoiseProcessor.destroy();
      this.rnnoiseProcessor = null;
    }

    // Clean up script processor
    if (this.fallbackScriptNode) {
      this.fallbackScriptNode.disconnect();
      this.fallbackScriptNode = null;
    }

    // Clean up audio nodes
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.destinationNode) {
      this.destinationNode = null;
    }
  }

  /**
   * Enable the processor.
   */
  protected async onEnable(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'setEnabled', enabled: true });
    }
    if (this.rnnoiseProcessor) {
      this.rnnoiseProcessor.setEnabled(true);
    }
  }

  /**
   * Disable the processor.
   */
  protected async onDisable(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'setEnabled', enabled: false });
    }
    if (this.rnnoiseProcessor) {
      this.rnnoiseProcessor.setEnabled(false);
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Set the noise cancellation level.
   *
   * @param level - The noise cancellation intensity
   */
  async setNoiseLevel(level: NoiseCancellationLevel): Promise<void> {
    this.options.noiseCancellationLevel = level;

    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'setLevel', level });
    }
    if (this.rnnoiseProcessor) {
      this.rnnoiseProcessor.setLevel(level);
    }
  }

  /**
   * Get the current noise cancellation level.
   */
  getNoiseLevel(): NoiseCancellationLevel {
    return this.options.noiseCancellationLevel;
  }

  /**
   * Get current processing statistics.
   */
  getStats(): NoiseFilterStats | null {
    if (this.rnnoiseProcessor) {
      return this.rnnoiseProcessor.getStats();
    }
    return null;
  }

  /**
   * Check if using fallback mode.
   */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  /**
   * Get the current options.
   */
  getOptions(): NoiseFilterOptions {
    return { ...this.options };
  }

  /**
   * Update options dynamically.
   *
   * @param options - New options to merge
   */
  async updateOptions(options: Partial<NoiseFilterOptions>): Promise<void> {
    if (options.noiseCancellationLevel !== undefined) {
      await this.setNoiseLevel(options.noiseCancellationLevel);
    }

    if (options.enableStats !== undefined) {
      this.options.enableStats = options.enableStats;
      if (options.enableStats) {
        this.startStatsEmission();
      } else {
        this.stopStatsEmission();
      }
    }

    if (options.statsInterval !== undefined) {
      this.options.statsInterval = options.statsInterval;
      if (this.options.enableStats) {
        this.stopStatsEmission();
        this.startStatsEmission();
      }
    }
  }
}

/**
 * Factory function to create a NoiseFilterProcessor.
 *
 * @param options - Processor options
 * @returns NoiseFilterProcessor instance
 */
export function createNoiseFilter(options?: NoiseFilterOptions): NoiseFilterProcessor {
  return new NoiseFilterProcessor(options);
}
