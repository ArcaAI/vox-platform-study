/**
 * @arcaai/stt - RemoteSTTProvider
 *
 * Remote STT provider using WebSocket connection to server.
 * Streams audio to the backend for processing with Whisper or Azure.
 */

import type { TranscriptionResult, STTStats, RemoteProviderConfig } from '../types/index.js';
import { BaseSTTProvider } from './BaseSTTProvider.js';
import { WebSocketClient, type ConnectionState } from '../websocket/WebSocketClient.js';
import { MessageHandler } from '../websocket/MessageHandler.js';
import { isWebSocketSupported } from '../utils/browserSupport.js';
import { prepareFloat32ForWhisper, WHISPER_SAMPLE_RATE } from '../utils/audioResampler.js';

/**
 * Remote STT provider using WebSocket.
 *
 * @deprecated TASK-298 D-4 — Prefer {@link StreamingBackendSTTProvider},
 * which speaks the pipeline-aware STT-V2 protocol (`?ticket=`-authenticated
 * gateway, `{type:'audio', seq, data}` envelope, `lastSeq` resumability).
 * This legacy provider remains for backward compatibility with callers that
 * pass an `sttSocket` URL only; it will be removed in a future cleanup ticket.
 *
 * Features:
 * - Real-time audio streaming to backend
 * - Automatic reconnection
 * - Keep-alive handling
 * - Support for speaker diarization
 *
 * @example
 * ```typescript
 * const provider = new RemoteSTTProvider();
 *
 * await provider.init({
 *   sttSocket: 'wss://api.example.com/ws/stt',
 *   sessionId: 'abc123',
 *   language: 'en-US',
 *   diarization: true,
 *   numSpeakers: 2,
 * });
 *
 * provider.onTranscription((result) => {
 *   console.log('Transcription:', result.text);
 *   console.log('Speaker:', result.speakerId);
 * });
 *
 * await provider.start();
 *
 * // Stream audio
 * provider.processAudio(audioSamples, sampleRate);
 *
 * await provider.stop();
 * await provider.destroy();
 * ```
 */
export class RemoteSTTProvider extends BaseSTTProvider {
  readonly name = 'remote-websocket';
  readonly type = 'remote' as const;

  private wsClient: WebSocketClient | null = null;
  private messageHandler: MessageHandler | null = null;
  private connectionStatus: ConnectionState = 'disconnected';
  private audioQueue: Float32Array[] = [];
  private sendInterval: ReturnType<typeof setInterval> | null = null;

  // Throttle audio sending to prevent overwhelming the server
  private readonly SEND_INTERVAL_MS = 100;
  private readonly MIN_SAMPLES_TO_SEND = 1600; // ~100ms at 16kHz

  isSupported(): boolean {
    return isWebSocketSupported();
  }

  async init(config: RemoteProviderConfig): Promise<void> {
    if (this.initialized) {
      await this.destroy();
    }

    this.config = config;

    // Initialize message handler
    this.messageHandler = new MessageHandler();
    this.messageHandler.setCallbacks({
      onConnected: (sessionId, audioConfig) => {
        this.connectionStatus = 'connected';
        console.log(`[RemoteSTTProvider] Connected to session ${sessionId}`, audioConfig);
      },
      onTranscription: (result) => {
        this.transcriptionCount++;
        this.emitTranscription(result);
      },
      onKeepAlive: () => {
        // Connection is alive
      },
      onStopped: () => {
        this.processing = false;
      },
      onError: (message) => {
        this.emitError(new Error(`Remote STT error: ${message}`));
      },
    });

    // Initialize WebSocket client
    this.wsClient = new WebSocketClient({
      sttSocket: config.sttSocket,
      sessionId: config.sessionId,
    });

    this.wsClient.setCallbacks({
      onStateChange: (state) => {
        this.connectionStatus = state;
      },
      onMessage: (message) => {
        this.messageHandler?.handleMessage(message);
      },
      onError: (error) => {
        this.emitError(error);
      },
      onClose: (code, reason) => {
        if (code !== 1000) {
          console.warn(`[RemoteSTTProvider] Connection closed: ${code} ${reason}`);
        }
      },
    });

    this.initialized = true;
  }

  async start(): Promise<void> {
    if (!this.initialized || !this.wsClient) {
      throw new Error('Provider not initialized. Call init() first.');
    }

    // Connect to WebSocket
    await this.wsClient.connect();

    this.processing = true;

    // Start audio send loop
    this.sendInterval = setInterval(() => {
      this.flushAudioQueue();
    }, this.SEND_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.processing = false;

    // Stop send loop
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }

    // Flush remaining audio
    this.flushAudioQueue();

    // Disconnect WebSocket
    if (this.wsClient?.isConnected()) {
      this.wsClient.disconnect();
    }

    // Clear audio queue
    this.audioQueue = [];
  }

  async processAudio(audio: Float32Array, sampleRate: number): Promise<void> {
    if (!this.processing) {
      return;
    }

    // Resample to 16kHz if needed
    const resampled = prepareFloat32ForWhisper(audio, sampleRate);

    // Add to queue
    this.audioQueue.push(resampled);
    this.totalAudioProcessed += resampled.length / WHISPER_SAMPLE_RATE;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async transcribeSegment(_audio: Float32Array): Promise<TranscriptionResult> {
    // Remote doesn't support direct segment transcription via WebSocket
    // For file transcription, use the REST API instead
    throw new Error(
      'RemoteSTTProvider does not support direct segment transcription. ' +
        'Use processAudio() for streaming or the REST API for file transcription.',
    );
  }

  async destroy(): Promise<void> {
    await this.stop();

    if (this.wsClient) {
      this.wsClient = null;
    }

    if (this.messageHandler) {
      this.messageHandler = null;
    }

    this.config = null;
    this.initialized = false;
    this.audioQueue = [];
  }

  getStats(): STTStats {
    const baseStats = super.getStats();

    return {
      ...baseStats,
      bufferSizeS: this.getQueuedAudioDuration(),
      connectionStatus: this.connectionStatus,
    };
  }

  /**
   * Get the WebSocket client for direct access.
   */
  getWebSocketClient(): WebSocketClient | null {
    return this.wsClient;
  }

  /**
   * Get current connection status.
   */
  getConnectionStatus(): ConnectionState {
    return this.connectionStatus;
  }

  /**
   * Check if connected to the backend.
   */
  isConnected(): boolean {
    return this.wsClient?.isConnected() ?? false;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Flush accumulated audio to the WebSocket.
   */
  private flushAudioQueue(): void {
    if (this.audioQueue.length === 0 || !this.wsClient?.isConnected()) {
      return;
    }

    // Calculate total samples
    const totalSamples = this.audioQueue.reduce((sum, chunk) => sum + chunk.length, 0);

    // Don't send if too few samples
    if (totalSamples < this.MIN_SAMPLES_TO_SEND) {
      return;
    }

    // Combine all queued audio
    const combined = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.audioQueue) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Clear queue
    this.audioQueue = [];

    // Send audio
    this.wsClient.sendAudio(combined);
  }

  /**
   * Get duration of audio currently queued.
   */
  private getQueuedAudioDuration(): number {
    const totalSamples = this.audioQueue.reduce((sum, chunk) => sum + chunk.length, 0);
    return totalSamples / WHISPER_SAMPLE_RATE;
  }
}
