/**
 * @arcaai/stt - WebSocketClient
 *
 * WebSocket client for connecting to the backend STT service.
 */

import type { WSOutboundMessage, WSInboundMessage, AudioMetadata } from '../types/index.js';
import { isWebSocketSupported } from '../utils/browserSupport.js';

/**
 * WebSocket connection state.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * Callbacks for WebSocket events.
 */
export interface WebSocketCallbacks {
  /**
   * Called when connection state changes.
   */
  onStateChange?: (state: ConnectionState) => void;

  /**
   * Called when a message is received from the server.
   */
  onMessage?: (message: WSInboundMessage) => void;

  /**
   * Called when an error occurs.
   */
  onError?: (error: Error) => void;

  /**
   * Called when the connection is closed.
   */
  onClose?: (code: number, reason: string) => void;
}

/**
 * Options for WebSocket client.
 */
export interface WebSocketClientOptions {
  /**
   * WebSocket URL for STT service (ws:// or wss://).
   */
  sttSocket: string;

  /**
   * Session ID for the STT service.
   */
  sessionId: string;

  /**
   * Reconnection attempts before giving up.
   * @default 3
   */
  maxReconnectAttempts?: number;

  /**
   * Delay between reconnection attempts in milliseconds.
   * @default 1000
   */
  reconnectDelay?: number;

  /**
   * Interval for keep-alive ping messages in milliseconds.
   * @default 25000
   */
  keepAliveInterval?: number;

  /**
   * Connection timeout in milliseconds.
   * @default 10000
   */
  connectionTimeout?: number;
}

/**
 * Default options for WebSocket client.
 */
export const DEFAULT_WS_OPTIONS: Required<Omit<WebSocketClientOptions, 'sttSocket' | 'sessionId'>> = {
  maxReconnectAttempts: 3,
  reconnectDelay: 1000,
  keepAliveInterval: 25000,
  connectionTimeout: 10000,
};

/**
 * Upper bound on the reconnect backoff delay. Mobile networks can produce
 * very long abnormal-close windows; capping the exponential at 30 s prevents
 * the delay from growing past several minutes after the first few crashes.
 */
const RECONNECT_BACKOFF_CAP_MS = 30_000;

/**
 * WebSocket client for remote STT service.
 *
 * Features:
 * - Automatic reconnection
 * - Keep-alive ping/pong
 * - Binary audio streaming
 * - JSON message handling
 *
 * @example
 * ```typescript
 * const client = new WebSocketClient({
 *   sttSocket: 'wss://api.example.com/ws/stt',
 *   sessionId: 'abc123',
 * });
 *
 * client.setCallbacks({
 *   onMessage: (message) => {
 *     if (message.type === 'transcription') {
 *       console.log('Transcription:', message.text);
 *     }
 *   },
 * });
 *
 * await client.connect();
 *
 * // Send audio
 * client.sendAudio(audioData);
 *
 * // Close
 * client.disconnect();
 * ```
 */
export class WebSocketClient {
  private socket: WebSocket | null = null;
  private options: Required<WebSocketClientOptions>;
  private callbacks: WebSocketCallbacks = {};
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private connectionTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Latched by `disconnect()` and `destroy()`. Aborts any scheduled
   * reconnect and rejects subsequent `connect()` calls so a destroyed client
   * cannot resurrect itself via an in-flight backoff timer.
   */
  private destroyed = false;

  constructor(options: WebSocketClientOptions) {
    this.options = {
      ...DEFAULT_WS_OPTIONS,
      ...options,
    };
  }

  /**
   * Check if WebSocket is supported.
   */
  isSupported(): boolean {
    return isWebSocketSupported();
  }

  /**
   * Set callback handlers.
   */
  setCallbacks(callbacks: WebSocketCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.state === 'connected' && this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Connect to the WebSocket server.
   *
   * @throws if the client has been destroyed via `destroy()`.
   */
  async connect(): Promise<void> {
    if (this.destroyed) {
      throw new Error('WebSocketClient is destroyed');
    }

    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    return new Promise((resolve, reject) => {
      this.setState('connecting');

      // Build WebSocket URL with session ID
      const url = `${this.options.sttSocket}/${this.options.sessionId}`;

      try {
        this.socket = new WebSocket(url);
        this.socket.binaryType = 'arraybuffer';

        // Set connection timeout
        this.connectionTimeoutTimer = setTimeout(() => {
          if (this.state === 'connecting') {
            const error = new Error('WebSocket connection timeout');
            this.handleError(error);
            reject(error);
          }
        }, this.options.connectionTimeout);

        this.socket.onopen = () => {
          this.clearConnectionTimeout();
          this.reconnectAttempts = 0;
          // Don't set connected yet - wait for 'connected' message from server
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event);

          // Resolve on first 'connected' message
          if (this.state === 'connecting') {
            try {
              const message = JSON.parse(event.data as string) as WSInboundMessage;
              if (message.type === 'connected') {
                this.setState('connected');
                this.startKeepAlive();
                resolve();
              }
            } catch {
              // Ignore parse errors during connection
            }
          }
        };

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        this.socket.onerror = (_event) => {
          this.clearConnectionTimeout();
          const error = new Error('WebSocket error');
          this.handleError(error);
          if (this.state === 'connecting') {
            reject(error);
          }
        };

        this.socket.onclose = (event) => {
          this.clearConnectionTimeout();
          this.stopKeepAlive();
          this.handleClose(event.code, event.reason);
        };
      } catch (error) {
        this.clearConnectionTimeout();
        this.setState('error');
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the WebSocket server. Cancels any pending reconnect
   * timer so the client cannot resurrect itself after the caller has decided
   * to stop.
   */
  disconnect(): void {
    this.stopKeepAlive();
    this.clearConnectionTimeout();
    this.clearReconnectTimer();
    this.reconnectAttempts = 0;

    if (this.socket) {
      // Send stop message before closing
      this.sendMessage({ type: 'stop' });

      // Close the socket
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }

    this.setState('disconnected');
  }

  /**
   * Permanently shut down this client. Equivalent to {@link disconnect} plus
   * latching a `destroyed` flag that:
   *   - Cancels any scheduled reconnect attempt
   *   - Rejects subsequent `connect()` calls
   *   - Suppresses post-disconnect `onclose` reconnect logic
   *
   * Use this when the owning hook / component unmounts. After `destroy()`
   * the client instance must be discarded.
   */
  destroy(): void {
    this.destroyed = true;
    this.disconnect();
  }

  /**
   * Send audio data to the server.
   *
   * @param audio - Audio data as Float32Array or ArrayBuffer
   * @param metadata - Optional audio metadata
   */
  sendAudio(audio: Float32Array | ArrayBuffer | Uint8Array, metadata?: AudioMetadata): void {
    if (!this.isConnected()) {
      return;
    }

    // Convert to Uint8Array if needed
    let bytes: Uint8Array;
    if (audio instanceof Float32Array) {
      // Convert float32 to int16 PCM
      const int16 = new Int16Array(audio.length);
      for (let i = 0; i < audio.length; i++) {
        const s = Math.max(-1, Math.min(1, audio[i]!));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      bytes = new Uint8Array(int16.buffer);
    } else if (audio instanceof ArrayBuffer) {
      bytes = new Uint8Array(audio);
    } else {
      bytes = audio;
    }

    // Send as binary for efficiency
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
    }

    // Optionally send metadata separately if provided
    if (metadata) {
      this.sendMessage({
        type: 'audio',
        data: [],
        metadata,
      });
    }
  }

  /**
   * Send a JSON message to the server.
   */
  sendMessage(message: WSOutboundMessage): void {
    if (!this.isConnected() || !this.socket) {
      return;
    }

    try {
      this.socket.send(JSON.stringify(message));
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Send a ping message.
   */
  sendPing(): void {
    this.sendMessage({ type: 'ping' });
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private setState(state: ConnectionState): void {
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private handleMessage(event: MessageEvent): void {
    try {
      // Parse JSON message
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data) as WSInboundMessage;
        this.callbacks.onMessage?.(message);
      }
    } catch {
      // Ignore parse errors for binary data
    }
  }

  private handleError(error: Error): void {
    this.setState('error');
    this.callbacks.onError?.(error);
  }

  private handleClose(code: number, reason: string): void {
    this.socket = null;
    this.callbacks.onClose?.(code, reason);

    // Always transition to 'disconnected' so a scheduled reconnect's
    // `connect()` call actually opens a fresh socket (the early-return guard
    // in `connect()` skips it when state is still 'connected').
    this.setState('disconnected');

    // Attempt reconnection only when:
    //   - The close was abnormal (non-1000)
    //   - The client has not been destroyed
    //   - The retry budget has not been exhausted
    if (this.destroyed) {
      return;
    }

    if (code !== 1000 && this.reconnectAttempts < this.options.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnect attempt with **jittered full-random exponential
   * backoff**:
   *
   *     delay = min(cap, base * 2^attempt) * Math.random()
   *
   * Full jitter (Math.random() multiplier on the entire window) prevents
   * synchronised reconnect storms when many clients lose connection at the
   * same time. The cap (`RECONNECT_BACKOFF_CAP_MS`) bounds the exponential
   * tail.
   */
  private scheduleReconnect(): void {
    if (this.destroyed) {
      return;
    }

    this.clearReconnectTimer();
    this.reconnectAttempts++;

    const exponential = this.options.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    const window_ = Math.min(RECONNECT_BACKOFF_CAP_MS, exponential);
    const delay = window_ * Math.random();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed) {
        return;
      }
      if (this.state !== 'connected') {
        this.connect().catch(() => {
          // Reconnection failed; subsequent onclose will schedule the next
          // attempt (or give up if the retry budget is exhausted).
        });
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.isConnected()) {
        this.sendPing();
      }
    }, this.options.keepAliveInterval);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeoutTimer) {
      clearTimeout(this.connectionTimeoutTimer);
      this.connectionTimeoutTimer = null;
    }
  }
}
