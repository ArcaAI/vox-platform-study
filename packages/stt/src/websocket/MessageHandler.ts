/**
 * @arcaai/stt - MessageHandler
 *
 * Handles parsing and routing of WebSocket messages from the STT service.
 */

import type {
  WSInboundMessage,
  TranscriptionResult,
} from '../types/index.js';

/**
 * Message handler callbacks.
 */
export interface MessageHandlerCallbacks {
  /**
   * Called when connection is confirmed.
   */
  onConnected?: (sessionId: string, audioConfig: Record<string, unknown>) => void;

  /**
   * Called when a transcription is received.
   */
  onTranscription?: (result: TranscriptionResult) => void;

  /**
   * Called when a keep-alive is received.
   */
  onKeepAlive?: () => void;

  /**
   * Called when the session is stopped.
   */
  onStopped?: () => void;

  /**
   * Called when an error is received.
   */
  onError?: (message: string) => void;
}

/**
 * Handles WebSocket messages from the STT service.
 *
 * Parses incoming messages and routes them to appropriate callbacks.
 *
 * @example
 * ```typescript
 * const handler = new MessageHandler();
 *
 * handler.setCallbacks({
 *   onTranscription: (result) => {
 *     console.log('Text:', result.text);
 *   },
 * });
 *
 * // In WebSocket onmessage:
 * handler.handleMessage(message);
 * ```
 */
export class MessageHandler {
  private callbacks: MessageHandlerCallbacks = {};

  /**
   * Set callback handlers.
   */
  setCallbacks(callbacks: MessageHandlerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Handle an incoming WebSocket message.
   */
  handleMessage(message: WSInboundMessage): void {
    switch (message.type) {
      case 'connected':
        this.handleConnected(message);
        break;

      case 'transcription':
        this.handleTranscription(message);
        break;

      case 'keepalive':
      case 'pong':
        this.handleKeepAlive();
        break;

      case 'stopped':
        this.handleStopped();
        break;

      case 'error':
        this.handleError(message);
        break;

      default:
        // Unknown message type - ignore
        console.warn('Unknown STT WebSocket message type:', (message as { type: string }).type);
    }
  }

  /**
   * Parse a raw message string.
   */
  parseMessage(data: string): WSInboundMessage | null {
    try {
      return JSON.parse(data) as WSInboundMessage;
    } catch {
      console.warn('Failed to parse STT WebSocket message:', data);
      return null;
    }
  }

  /**
   * Handle and route a raw message string.
   */
  handleRawMessage(data: string): void {
    const message = this.parseMessage(data);
    if (message) {
      this.handleMessage(message);
    }
  }

  // =========================================================================
  // Private Handlers
  // =========================================================================

  private handleConnected(
    message: Extract<WSInboundMessage, { type: 'connected' }>
  ): void {
    this.callbacks.onConnected?.(
      message.session_id,
      message.audio_config
    );
  }

  private handleTranscription(
    message: Extract<WSInboundMessage, { type: 'transcription' }>
  ): void {
    const result: TranscriptionResult = {
      text: message.text,
      isFinal: message.is_final,
      language: message.language,
      speakerId: message.speaker_id,
    };

    this.callbacks.onTranscription?.(result);
  }

  private handleKeepAlive(): void {
    this.callbacks.onKeepAlive?.();
  }

  private handleStopped(): void {
    this.callbacks.onStopped?.();
  }

  private handleError(
    message: Extract<WSInboundMessage, { type: 'error' }>
  ): void {
    this.callbacks.onError?.(message.message);
  }
}
