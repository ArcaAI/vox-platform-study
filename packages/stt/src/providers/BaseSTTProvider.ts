/**
 * @arcaai/stt - BaseSTTProvider
 *
 * Abstract base class for STT provider implementations.
 */

import type {
  TranscriptionResult,
  STTStats,
  STTProviderType,
  ProviderConfig,
} from '../types/index.js';
import type { STTProvider, TranscriptionCallback, ErrorCallback } from './types.js';

/**
 * Abstract base class for STT providers.
 * Provides common functionality for all provider implementations.
 */
export abstract class BaseSTTProvider implements STTProvider {
  abstract readonly name: string;
  abstract readonly type: 'local' | 'remote';

  protected config: ProviderConfig | null = null;
  protected initialized = false;
  protected processing = false;
  protected transcriptionCallback: TranscriptionCallback | null = null;
  protected errorCallback: ErrorCallback | null = null;

  // Stats
  protected totalAudioProcessed = 0;
  protected transcriptionCount = 0;
  protected totalLatencyMs = 0;

  abstract isSupported(): boolean;
  abstract init(config: ProviderConfig): Promise<void>;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract processAudio(audio: Float32Array, sampleRate: number): Promise<void>;
  abstract transcribeSegment(audio: Float32Array): Promise<TranscriptionResult>;
  abstract destroy(): Promise<void>;

  isReady(): boolean {
    return this.initialized;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  onTranscription(callback: TranscriptionCallback): void {
    this.transcriptionCallback = callback;
  }

  onError(callback: ErrorCallback): void {
    this.errorCallback = callback;
  }

  getStats(): STTStats {
    return {
      isActive: this.initialized,
      isProcessing: this.processing,
      totalAudioProcessed: this.totalAudioProcessed,
      transcriptionCount: this.transcriptionCount,
      averageLatencyMs:
        this.transcriptionCount > 0
          ? this.totalLatencyMs / this.transcriptionCount
          : 0,
      bufferSizeS: 0, // Override in subclass
      providerType: this.type as STTProviderType,
      sessionId: this.config?.sessionId,
      language: this.config?.language,
      timestamp: Date.now(),
    };
  }

  /**
   * Emit a transcription result.
   */
  protected emitTranscription(result: TranscriptionResult): void {
    this.transcriptionCallback?.(result);
  }

  /**
   * Emit an error.
   */
  protected emitError(error: Error): void {
    this.errorCallback?.(error);
  }

  /**
   * Record a transcription with its latency.
   */
  protected recordTranscription(latencyMs: number, audioSeconds: number): void {
    this.transcriptionCount++;
    this.totalLatencyMs += latencyMs;
    this.totalAudioProcessed += audioSeconds;
  }
}
