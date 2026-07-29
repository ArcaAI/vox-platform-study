/**
 * @arcaai/stt - WebSocketClient Tests
 *
 * Tests for the WebSocket client with mocked WebSocket.
 * Note: Runs in Node environment with mocked browser APIs.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketClient, DEFAULT_WS_OPTIONS, type WebSocketCallbacks, type ConnectionState } from '../websocket/WebSocketClient.js';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  private sentMessages: (string | ArrayBuffer | Uint8Array)[] = [];

  constructor(public url: string) {}

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sentMessages.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data });
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }

  simulateClose(code: number, reason: string): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  getSentMessages(): (string | ArrayBuffer | Uint8Array)[] {
    return this.sentMessages;
  }
}

describe('WebSocketClient', () => {
  let originalWebSocket: typeof WebSocket;
  let mockWsInstance: MockWebSocket | null = null;

  beforeEach(() => {
    // Save original and mock WebSocket
    originalWebSocket = globalThis.WebSocket;

    // @ts-expect-error - Mocking WebSocket
    globalThis.WebSocket = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        mockWsInstance = this as unknown as MockWebSocket;
      }
    };

    // Mock browser environment
    vi.stubGlobal('window', { document: {} });
  });

  afterEach(() => {
    // Restore original
    globalThis.WebSocket = originalWebSocket;
    mockWsInstance = null;
    vi.unstubAllGlobals();
  });

  describe('constructor', () => {
    it('should initialize with required options', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      expect(client.getState()).toBe('disconnected');
      expect(client.isConnected()).toBe(false);
    });

    it('should merge default options', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        maxReconnectAttempts: 5,
      });

      // Client should use custom value for maxReconnectAttempts
      // and defaults for others
      expect(client.getState()).toBe('disconnected');
    });
  });

  describe('setCallbacks', () => {
    it('should set callback handlers', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      const onStateChange = vi.fn();
      const onMessage = vi.fn();

      client.setCallbacks({ onStateChange, onMessage });

      // Callbacks are set internally, we test them during connection
    });

    it('should merge callbacks', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      const onStateChange = vi.fn();
      const onError = vi.fn();

      client.setCallbacks({ onStateChange });
      client.setCallbacks({ onError });

      // Both callbacks should be set
    });
  });

  describe('getState / isConnected', () => {
    it('should return disconnected initially', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      expect(client.getState()).toBe('disconnected');
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('should set state to connecting', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      const stateChanges: ConnectionState[] = [];
      client.setCallbacks({
        onStateChange: (state) => stateChanges.push(state),
      });

      // Start connection (don't await, we'll manually trigger events)
      const connectPromise = client.connect();

      // Simulate WebSocket open
      mockWsInstance?.simulateOpen();

      // Simulate connected message from server
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );

      await connectPromise;

      expect(stateChanges).toContain('connecting');
      expect(stateChanges).toContain('connected');
      expect(client.getState()).toBe('connected');
      expect(client.isConnected()).toBe(true);
    });

    it('should build correct URL with session ID', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws/stt',
        sessionId: 'my-session',
        connectionTimeout: 5000,
      });

      const connectPromise = client.connect();

      // Check URL
      expect(mockWsInstance?.url).toBe('wss://example.com/ws/stt/my-session');

      // Complete connection
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'my-session',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );

      await connectPromise;
    });

    it('should not reconnect if already connected', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // First connection
      const connectPromise1 = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise1;

      // Try to connect again
      await client.connect();

      // Should still be connected (same state)
      expect(client.isConnected()).toBe(true);
    });

    it('should handle connection timeout', async () => {
      vi.useFakeTimers();

      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 100,
      });

      const connectPromise = client.connect();

      // Don't simulate open - let it timeout
      vi.advanceTimersByTime(150);

      await expect(connectPromise).rejects.toThrow('WebSocket connection timeout');
      expect(client.getState()).toBe('error');

      vi.useRealTimers();
    });

    it('should handle connection error', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 1000,
      });

      const onError = vi.fn();
      const stateChanges: ConnectionState[] = [];
      client.setCallbacks({
        onError,
        onStateChange: (state) => stateChanges.push(state),
      });

      // Start connection (don't await - just check state changes)
      client.connect().catch(() => {
        // Expected to reject
      });

      // Simulate error
      mockWsInstance?.simulateError();

      // Verify error handling
      expect(client.getState()).toBe('error');
      expect(stateChanges).toContain('connecting');
      expect(stateChanges).toContain('error');
      expect(onError).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket and set state to disconnected', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect first
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Disconnect
      client.disconnect();

      expect(client.getState()).toBe('disconnected');
      expect(client.isConnected()).toBe(false);
    });

    it('should send stop message before closing', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Disconnect
      client.disconnect();

      // Check that stop message was sent
      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      const stopMessage = sentMessages.find((msg) => typeof msg === 'string' && msg.includes('"type":"stop"'));
      expect(stopMessage).toBeDefined();
    });

    it('should be safe to call when not connected', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      // Should not throw
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('sendAudio', () => {
    it('should not send if not connected', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      const audio = new Float32Array([0.1, 0.2, 0.3]);
      client.sendAudio(audio);

      // Nothing should be sent
      expect(mockWsInstance?.getSentMessages().length ?? 0).toBe(0);
    });

    it('should convert Float32Array to PCM bytes', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send audio
      const audio = new Float32Array([0.5, -0.5, 1.0, -1.0]);
      client.sendAudio(audio);

      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      // Should have at least one binary message
      const binaryMessage = sentMessages.find((msg) => msg instanceof Uint8Array);
      expect(binaryMessage).toBeDefined();
    });

    it('should handle ArrayBuffer input', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send ArrayBuffer
      const buffer = new ArrayBuffer(8);
      client.sendAudio(buffer);

      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      expect(sentMessages.find((msg) => msg instanceof Uint8Array)).toBeDefined();
    });

    it('should handle Uint8Array input', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send Uint8Array
      const bytes = new Uint8Array([0, 1, 2, 3]);
      client.sendAudio(bytes);

      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      expect(sentMessages.find((msg) => msg instanceof Uint8Array)).toBeDefined();
    });

    it('should send metadata separately if provided', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send audio with metadata
      const audio = new Float32Array([0.1]);
      client.sendAudio(audio, { sampleRate: 16000, channels: 1 });

      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      const metadataMessage = sentMessages.find((msg) => typeof msg === 'string' && msg.includes('"type":"audio"'));
      expect(metadataMessage).toBeDefined();
    });
  });

  describe('sendMessage', () => {
    it('should not send if not connected', () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
      });

      client.sendMessage({ type: 'ping' });

      expect(mockWsInstance?.getSentMessages().length ?? 0).toBe(0);
    });

    it('should send JSON message when connected', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send message
      client.sendMessage({ type: 'ping' });

      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      const pingMessage = sentMessages.find((msg) => typeof msg === 'string' && msg.includes('"type":"ping"'));
      expect(pingMessage).toBeDefined();
    });
  });

  describe('sendPing', () => {
    it('should send ping message', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send ping
      client.sendPing();

      const sentMessages = mockWsInstance?.getSentMessages() ?? [];
      const pingMessage = sentMessages.find((msg) => typeof msg === 'string' && msg.includes('"type":"ping"'));
      expect(pingMessage).toBeDefined();
    });
  });

  describe('message handling', () => {
    it('should call onMessage callback for messages', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      const onMessage = vi.fn();
      client.setCallbacks({ onMessage });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Send a transcription message
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'transcription',
          text: 'Hello',
          is_final: true,
          speaker_id: 'sp1',
          session_id: 'session-123',
          language: 'en',
        }),
      );

      expect(onMessage).toHaveBeenCalled();
      const lastCall = onMessage.mock.calls[onMessage.mock.calls.length - 1];
      expect(lastCall[0].type).toBe('transcription');
    });
  });

  describe('close handling', () => {
    it('should call onClose callback when connection closes', async () => {
      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
      });

      const onClose = vi.fn();
      client.setCallbacks({ onClose });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Simulate close
      mockWsInstance?.simulateClose(1001, 'Server shutdown');

      expect(onClose).toHaveBeenCalledWith(1001, 'Server shutdown');
    });

    it('should attempt reconnection on unexpected close', async () => {
      vi.useFakeTimers();

      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
        maxReconnectAttempts: 3,
        reconnectDelay: 1000,
      });

      const stateChanges: ConnectionState[] = [];
      client.setCallbacks({
        onStateChange: (state) => stateChanges.push(state),
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Simulate unexpected close (not 1000)
      mockWsInstance?.simulateClose(1006, 'Connection lost');

      // Advance timers to trigger reconnection
      vi.advanceTimersByTime(1500);

      // Should have attempted reconnection
      expect(stateChanges).toContain('connecting');

      vi.useRealTimers();
    });

    it('should not reconnect on normal close (code 1000)', async () => {
      vi.useFakeTimers();

      const client = new WebSocketClient({
        sttSocket: 'wss://example.com/ws',
        sessionId: 'session-123',
        connectionTimeout: 5000,
        maxReconnectAttempts: 3,
      });

      // Connect
      const connectPromise = client.connect();
      mockWsInstance?.simulateOpen();
      mockWsInstance?.simulateMessage(
        JSON.stringify({
          type: 'connected',
          session_id: 'session-123',
          audio_config: {},
          timestamp: new Date().toISOString(),
        }),
      );
      await connectPromise;

      // Simulate normal close
      mockWsInstance?.simulateClose(1000, 'Normal closure');

      // State should be disconnected (not connecting for reconnect)
      expect(client.getState()).toBe('disconnected');

      vi.useRealTimers();
    });
  });

  describe('DEFAULT_WS_OPTIONS', () => {
    it('should have expected default values', () => {
      expect(DEFAULT_WS_OPTIONS.maxReconnectAttempts).toBe(3);
      expect(DEFAULT_WS_OPTIONS.reconnectDelay).toBe(1000);
      expect(DEFAULT_WS_OPTIONS.keepAliveInterval).toBe(25000);
      expect(DEFAULT_WS_OPTIONS.connectionTimeout).toBe(10000);
    });
  });
});
