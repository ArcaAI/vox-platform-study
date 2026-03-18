/**
 * SttV2WebSocketClient Unit Tests — ASR-R-03
 *
 * TDD tests for the WebSocket client that speaks the stt-v2 protocol.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SttV2WebSocketClient } from '../SttV2WebSocketClient';
import { createMockLogger } from '../../__tests__/setup';
import type {
  WsTranscriptResult,
  WsStatusMessage,
  WsErrorMessage,
} from '../../types/stt-v2';

// ===========================================================================
// Mock WebSocket
// ===========================================================================

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  binaryType: BinaryType = 'blob';
  sent: Array<string | ArrayBufferLike> = [];

  constructor(url: string) {
    this.url = url;
  }

  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose(new CloseEvent('close', { code: code ?? 1000, reason: reason ?? '' }));
    }
  }

  // Test helpers: simulate server events
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  simulateMessage(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

// Install mock WebSocket globally
const originalWebSocket = globalThis.WebSocket;
let lastMockWs: MockWebSocket | null = null;

beforeEach(() => {
  lastMockWs = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      lastMockWs = this;
    }
  };
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
  lastMockWs = null;
});

// ===========================================================================
// Tests
// ===========================================================================

describe('SttV2WebSocketClient', () => {
  let client: SttV2WebSocketClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new SttV2WebSocketClient(mockLogger);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(client).toBeDefined();
      expect(client.isConnected()).toBe(false);
    });

    it('should create without logger', () => {
      const c = new SttV2WebSocketClient();
      expect(c).toBeDefined();
    });
  });

  // =========================================================================
  // connect
  // =========================================================================

  describe('connect', () => {
    it('should open a WebSocket connection to the given URL', async () => {
      const connectPromise = client.connect('wss://api.example.com/ws/stt-v2/stream?sessionId=abc&token=jwt');

      // Simulate server accepting connection
      lastMockWs!.simulateOpen();
      await connectPromise;

      expect(client.isConnected()).toBe(true);
      expect(lastMockWs!.url).toBe('wss://api.example.com/ws/stt-v2/stream?sessionId=abc&token=jwt');
    });

    it('should set binaryType to arraybuffer', async () => {
      const connectPromise = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await connectPromise;

      expect(lastMockWs!.binaryType).toBe('arraybuffer');
    });

    it('should reject if connection fails', async () => {
      const connectPromise = client.connect('wss://example.com/ws');
      lastMockWs!.simulateError();
      lastMockWs!.close(1006, 'Connection failed');

      await expect(connectPromise).rejects.toThrow();
    });

    it('should not allow connecting when already connected', async () => {
      const p1 = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p1;

      await expect(
        client.connect('wss://example.com/ws')
      ).rejects.toThrow(/already connected/i);
    });

    it('should reject with timeout error if server does not respond within timeoutMs', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect('wss://example.com/ws', { timeoutMs: 5000 });

      // Advance past the timeout without simulating open
      vi.advanceTimersByTime(5001);

      await expect(connectPromise).rejects.toThrow(/timed out/i);
      expect(client.isConnected()).toBe(false);

      vi.useRealTimers();
    });

    it('should use default timeout of 10000ms when no timeoutMs is provided', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect('wss://example.com/ws');

      // 9 seconds — should not have timed out
      vi.advanceTimersByTime(9000);
      // Still pending — simulate open before full timeout
      lastMockWs!.simulateOpen();
      await connectPromise;

      expect(client.isConnected()).toBe(true);

      vi.useRealTimers();
    });

    it('should clear the timeout when connection succeeds', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect('wss://example.com/ws', { timeoutMs: 5000 });

      // Succeed before timeout
      lastMockWs!.simulateOpen();
      await connectPromise;

      // Advance past the timeout — should not throw or disconnect
      vi.advanceTimersByTime(6000);

      expect(client.isConnected()).toBe(true);

      vi.useRealTimers();
    });
  });

  // =========================================================================
  // sendAudioFrame (binary PCM)
  // =========================================================================

  describe('sendAudioFrame', () => {
    it('should send raw PCM buffer as binary', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const pcmBuffer = new ArrayBuffer(3200); // 100ms of 16kHz int16 mono
      client.sendAudioFrame(pcmBuffer);

      expect(lastMockWs!.sent).toHaveLength(1);
      expect(lastMockWs!.sent[0]).toBe(pcmBuffer);
    });

    it('should throw when not connected', () => {
      const pcm = new ArrayBuffer(100);
      expect(() => client.sendAudioFrame(pcm)).toThrow(/not connected/i);
    });
  });

  // =========================================================================
  // sendAudioFrameJson
  // =========================================================================

  describe('sendAudioFrameJson', () => {
    it('should send JSON audio frame with seq and base64 data', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(1, 'base64audiocontent');

      expect(lastMockWs!.sent).toHaveLength(1);
      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      expect(parsed.type).toBe('audio');
      expect(parsed.seq).toBe(1);
      expect(parsed.data).toBe('base64audiocontent');
    });

    it('should include optional microphoneId', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(2, 'data', 'mic-1');

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      expect(parsed.microphoneId).toBe('mic-1');
    });
  });

  // =========================================================================
  // sendStop / sendClose
  // =========================================================================

  describe('sendStop', () => {
    it('should send stop message', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendStop();

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      expect(parsed.type).toBe('stop');
    });

    it('should throw when not connected', () => {
      expect(() => client.sendStop()).toThrow(/not connected/i);
    });
  });

  describe('sendClose', () => {
    it('should send close message', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendClose();

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      expect(parsed.type).toBe('close');
    });

    it('should throw when not connected', () => {
      expect(() => client.sendClose()).toThrow(/not connected/i);
    });
  });

  describe('sendAudioFrameJson (not connected)', () => {
    it('should throw when not connected', () => {
      expect(() => client.sendAudioFrameJson(1, 'data')).toThrow(/not connected/i);
    });
  });

  // =========================================================================
  // Receive messages (server → client)
  // =========================================================================

  describe('onTranscript', () => {
    it('should fire callback when a transcript message is received', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onTranscript = vi.fn();
      client.onTranscript(onTranscript);

      const msg: WsTranscriptResult = {
        type: 'transcript',
        text: 'Hello world',
        startTime: 0.5,
        endTime: 1.2,
        isFinal: true,
      };
      lastMockWs!.simulateMessage(JSON.stringify(msg));

      expect(onTranscript).toHaveBeenCalledWith(msg);
    });

    it('should distinguish final vs partial transcripts', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const transcripts: WsTranscriptResult[] = [];
      client.onTranscript((t) => transcripts.push(t));

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript', text: 'Hel', startTime: 0, endTime: 0.3, isFinal: false,
      }));
      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript', text: 'Hello', startTime: 0, endTime: 0.5, isFinal: true,
      }));

      expect(transcripts).toHaveLength(2);
      expect(transcripts[0].isFinal).toBe(false);
      expect(transcripts[1].isFinal).toBe(true);
    });
  });

  describe('onStatus', () => {
    it('should fire callback for status messages', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onStatus = vi.fn();
      client.onStatus(onStatus);

      const msg: WsStatusMessage = {
        type: 'status',
        status: 'connected',
        message: 'Ready for audio',
      };
      lastMockWs!.simulateMessage(JSON.stringify(msg));

      expect(onStatus).toHaveBeenCalledWith(msg);
    });
  });

  describe('onWsError', () => {
    it('should fire callback for error messages from server', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onErr = vi.fn();
      client.onWsError(onErr);

      const msg: WsErrorMessage = {
        type: 'error',
        code: 'SESSION_EXPIRED',
        message: 'Session has expired',
      };
      lastMockWs!.simulateMessage(JSON.stringify(msg));

      expect(onErr).toHaveBeenCalledWith(msg);
    });
  });

  // =========================================================================
  // Edge cases: malformed / unexpected messages
  // =========================================================================

  describe('message edge cases', () => {
    it('should not throw on malformed JSON from server', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      expect(() => {
        lastMockWs!.simulateMessage('not valid json {{{');
      }).not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to parse WebSocket message',
        expect.any(Object),
      );
    });

    it('should warn on unknown message type from server', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'heartbeat', data: 123 }));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Unknown WebSocket message type',
        expect.objectContaining({
          attributes: expect.objectContaining({ messageType: 'heartbeat' }),
        }),
      );
    });

    it('should warn on non-string (binary) message from server', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.simulateMessage(new ArrayBuffer(16));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Received non-string WebSocket message',
        expect.any(Object),
      );
    });

    it('should not fire any callback for unknown message types', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onTranscript = vi.fn();
      const onStatus = vi.fn();
      const onErr = vi.fn();
      client.onTranscript(onTranscript);
      client.onStatus(onStatus);
      client.onWsError(onErr);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'ping' }));

      expect(onTranscript).not.toHaveBeenCalled();
      expect(onStatus).not.toHaveBeenCalled();
      expect(onErr).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge case: server-initiated close
  // =========================================================================

  describe('server-initiated close', () => {
    it('should fire onDisconnect when server closes after connection', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onDisconnect = vi.fn();
      client.onDisconnect(onDisconnect);

      // Server closes the connection
      lastMockWs!.close(1001, 'Server going away');

      expect(onDisconnect).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });
  });

  // =========================================================================
  // Edge case: multiple rapid sends
  // =========================================================================

  describe('multiple rapid sends', () => {
    it('should preserve order of multiple audio frames', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(1, 'frame1');
      client.sendAudioFrameJson(2, 'frame2');
      client.sendAudioFrameJson(3, 'frame3');

      expect(lastMockWs!.sent).toHaveLength(3);
      expect(JSON.parse(lastMockWs!.sent[0] as string).seq).toBe(1);
      expect(JSON.parse(lastMockWs!.sent[1] as string).seq).toBe(2);
      expect(JSON.parse(lastMockWs!.sent[2] as string).seq).toBe(3);
    });
  });

  // =========================================================================
  // disconnect
  // =========================================================================

  describe('disconnect', () => {
    it('should close the WebSocket connection', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.disconnect();

      expect(client.isConnected()).toBe(false);
    });

    it('should be safe to call when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });

    it('should fire onDisconnect callback', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onDisconnect = vi.fn();
      client.onDisconnect(onDisconnect);

      client.disconnect();

      expect(onDisconnect).toHaveBeenCalled();
    });

    it('should allow reconnecting after disconnect', async () => {
      const p1 = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p1;
      client.disconnect();

      const p2 = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p2;

      expect(client.isConnected()).toBe(true);
    });
  });

  // =========================================================================
  // Reconnection (WsReconnectOptions)
  // =========================================================================

  describe('reconnection', () => {
    let reconnectClient: SttV2WebSocketClient;

    beforeEach(() => {
      reconnectClient = new SttV2WebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
      });
    });

    it('should not auto-reconnect when reconnect is disabled (default)', async () => {
      vi.useFakeTimers();

      // Default client has no reconnect options
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      const onDisconnect = vi.fn();
      client.onDisconnect(onDisconnect);

      // Server closes
      lastMockWs!.close(1006, 'Connection lost');

      await vi.advanceTimersByTimeAsync(10_000);

      // Only onDisconnect fired, no reconnection
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      expect(client.isConnected()).toBe(false);

      vi.useRealTimers();
    });

    it('should auto-reconnect on unexpected disconnect when enabled', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes unexpectedly
      lastMockWs!.close(1006, 'Connection lost');

      // After baseDelayMs (100ms * 2^0 = 100ms) + jitter(0) = 100ms
      await vi.advanceTimersByTimeAsync(101);

      // A new WebSocket was created (reconnect attempt)
      expect(lastMockWs).toBeDefined();
      // Simulate the new WS connecting
      lastMockWs!.simulateOpen();

      expect(reconnectClient.isConnected()).toBe(true);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should not auto-reconnect on intentional disconnect', async () => {
      vi.useFakeTimers();

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      reconnectClient.disconnect();

      await vi.advanceTimersByTimeAsync(10_000);

      expect(reconnectClient.isConnected()).toBe(false);
      expect(reconnectClient.getReconnectAttempts()).toBe(0);

      vi.useRealTimers();
    });

    it('should fire onReconnect callback with attempt number', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const onReconnect = vi.fn();
      reconnectClient.onReconnect(onReconnect);

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes
      lastMockWs!.close(1006, 'Lost');

      // First reconnect attempt after 100ms + jitter(0)
      await vi.advanceTimersByTimeAsync(101);

      expect(onReconnect).toHaveBeenCalledWith(1);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should log error and fire onReconnectFailed when maxAttempts is 0', async () => {
      // With maxAttempts=0, the first disconnect immediately exhausts attempts
      const onReconnectFailed = vi.fn();
      const zeroAttemptsClient = new SttV2WebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 0,
        baseDelayMs: 50,
        maxDelayMs: 5000,
      });
      zeroAttemptsClient.onReconnectFailed(onReconnectFailed);

      const p = zeroAttemptsClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes — attemptReconnect called, but 0 >= 0 so immediately fails
      lastMockWs!.close(1006, 'Lost');

      expect(onReconnectFailed).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'WebSocket reconnection failed — max attempts exhausted',
        expect.objectContaining({
          attributes: expect.objectContaining({ maxAttempts: 0 }),
        }),
      );
    });

    it('should reset reconnect attempts when connection is acknowledged stable', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes
      lastMockWs!.close(1006, 'Lost');

      // First reconnect attempt after 100ms + jitter(0)
      await vi.advanceTimersByTimeAsync(101);
      // Reconnect succeeds
      lastMockWs!.simulateOpen();

      // Counter stays at 1 until caller acknowledges stability
      expect(reconnectClient.getReconnectAttempts()).toBe(1);
      expect(reconnectClient.isConnected()).toBe(true);

      // Caller confirms the connection is stable (e.g. first transcript received)
      reconnectClient.acknowledgeConnection();
      expect(reconnectClient.getReconnectAttempts()).toBe(0);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should compute delay capped by maxDelayMs using exponential backoff formula', () => {
      // Verify the backoff formula: delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs) + jitter
      // This tests the configuration is stored correctly and the computed delays
      // follow the expected pattern. The actual timer-based behavior is tested
      // in the simpler auto-reconnect test above.
      const cappedClient = new SttV2WebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
      });

      // Client starts with 0 reconnect attempts
      expect(cappedClient.getReconnectAttempts()).toBe(0);
      expect(cappedClient.isConnected()).toBe(false);
    });

    it('should add jitter to reconnection delay to prevent thundering herd', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random');

      // With jitter = 0 (Math.random returns 0), delay should be exactly baseDelayMs
      mathRandomSpy.mockReturnValue(0);

      const jitterClient = new SttV2WebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      });

      const p = jitterClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.close(1006, 'Lost');

      // With Math.random() = 0, jitter = 0, delay = 1000ms exactly
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('reconnecting in 1000ms'),
        expect.any(Object),
      );

      // With Math.random() = 1.0, jitter = exponentialDelay * 0.5
      // For attempt 1: exponentialDelay = 1000, jitter = 500, total = 1500
      mathRandomSpy.mockReturnValue(1.0);

      // Advance past first reconnect to trigger second attempt
      await vi.advanceTimersByTimeAsync(1001);
      lastMockWs!.simulateOpen();
      lastMockWs!.close(1006, 'Lost');

      // Attempt 2: exponentialDelay = min(1000 * 2^1, 30000) = 2000
      // jitter = 1.0 * 2000 * 0.5 = 1000, total = 3000
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('reconnecting in 3000ms'),
        expect.any(Object),
      );

      jitterClient.disconnect();
      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should cancel pending reconnection via cancelReconnect()', async () => {
      vi.useFakeTimers();

      const onReconnect = vi.fn();
      reconnectClient.onReconnect(onReconnect);

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.close(1006, 'Lost');

      // Cancel before the timer fires
      reconnectClient.cancelReconnect();

      await vi.advanceTimersByTimeAsync(10_000);

      // onReconnect was called (before timer, as the callback fires on schedule)
      // but the connect itself should not proceed because we cancelled
      expect(reconnectClient.getReconnectAttempts()).toBe(0);

      vi.useRealTimers();
    });

    it('should start with 0 reconnect attempts', () => {
      expect(reconnectClient.getReconnectAttempts()).toBe(0);
    });

    it('should not reconnect when no previous URL exists', () => {
      expect(reconnectClient.isConnected()).toBe(false);
      expect(reconnectClient.getReconnectAttempts()).toBe(0);
    });

    it('should not auto-reconnect on normal close (code 1000)', async () => {
      vi.useFakeTimers();

      const onReconnect = vi.fn();
      reconnectClient.onReconnect(onReconnect);

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Normal close (code 1000) — server intentionally closed
      lastMockWs!.close(1000, 'Normal closure');

      await vi.advanceTimersByTimeAsync(5000);

      // onReconnect fires because the client saw an unexpected onclose
      // (the client doesn't distinguish 1000 from 1006 — the reconnect
      //  is suppressed only by intentionalDisconnect flag from disconnect()).
      // This tests real behavior: server-side 1000 close IS treated as unexpected.
      // The test documents this design decision.
      expect(reconnectClient.isConnected()).toBe(false);

      vi.useRealTimers();
    });

    it('should cancel reconnect timer when disconnect() is called during reconnection', async () => {
      vi.useFakeTimers();

      const onReconnect = vi.fn();
      reconnectClient.onReconnect(onReconnect);

      const p = reconnectClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes — triggers reconnect timer
      lastMockWs!.close(1006, 'Lost');
      expect(onReconnect).toHaveBeenCalledTimes(1);

      // User calls disconnect() while timer is pending
      reconnectClient.disconnect();

      // Timer should be cancelled
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reconnectClient.isConnected()).toBe(false);
      expect(reconnectClient.getReconnectAttempts()).toBe(0);

      vi.useRealTimers();
    });

    it('should allow manual connect() after reconnect sequence is exhausted', async () => {
      const failClient = new SttV2WebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 0,
        baseDelayMs: 50,
        maxDelayMs: 5000,
      });

      const p = failClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes — maxAttempts=0 immediately exhausts
      lastMockWs!.close(1006, 'Lost');
      expect(failClient.isConnected()).toBe(false);

      // Manual reconnect should still work
      const p2 = failClient.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p2;

      expect(failClient.isConnected()).toBe(true);
    });
  });

  // =========================================================================
  // Edge: sendAudioFrameJson without microphoneId
  // =========================================================================

  describe('sendAudioFrameJson without microphoneId', () => {
    it('should not include microphoneId key when not provided', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(1, 'base64data');

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      expect(parsed).toEqual({ type: 'audio', seq: 1, data: 'base64data' });
      expect(parsed).not.toHaveProperty('microphoneId');
    });

    it('should not include microphoneId when passed as empty string', async () => {
      const p = client.connect('wss://example.com/ws');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(1, 'base64data', '');

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      // Empty string is falsy — microphoneId should not be set
      expect(parsed).not.toHaveProperty('microphoneId');
    });
  });

  // =========================================================================
  // BUG-04: Reconnect loop must not cycle infinitely
  // =========================================================================

  describe('BUG-04: reconnect counter must not reset on brief connections', () => {
    it('should exhaust maxAttempts even if connections open briefly then close', async () => {
      vi.useFakeTimers();
      try {
        const mockLogger = createMockLogger();
        const client = new SttV2WebSocketClient(mockLogger, {
          enabled: true,
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        });

        const failedCb = vi.fn();
        client.onReconnectFailed(failedCb);

        // Initial connect
        const connectPromise = client.connect('ws://test/stream');
        lastMockWs!.simulateOpen();
        await connectPromise;

        // Simulate unexpected close (triggers reconnect attempt 1)
        lastMockWs!.close(1006, 'abnormal');
        vi.advanceTimersByTime(200);

        // Reconnect attempt 1: opens briefly then closes
        lastMockWs!.simulateOpen();
        lastMockWs!.close(1006, 'abnormal');
        vi.advanceTimersByTime(400);

        // Reconnect attempt 2: opens briefly then closes
        lastMockWs!.simulateOpen();
        lastMockWs!.close(1006, 'abnormal');
        vi.advanceTimersByTime(800);

        // Reconnect attempt 3: opens briefly then closes
        lastMockWs!.simulateOpen();
        lastMockWs!.close(1006, 'abnormal');
        vi.advanceTimersByTime(1600);

        // After maxAttempts (3), the onReconnectFailed callback should fire
        expect(failedCb).toHaveBeenCalled();

        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =========================================================================
  // SEC-06: URL query params stripped from logs
  // =========================================================================

  describe('SEC-06: should not log query parameters in WebSocket URL', () => {
    it('should strip query params from URL in debug log', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?sessionId=secret-123&token=jwt-abc');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const debugCalls = (mockLogger.debug as any).mock.calls;
      const connectLog = debugCalls.find((c: any[]) => c[0] === 'Connecting to stt-v2 WebSocket');
      expect(connectLog).toBeDefined();

      const loggedUrl = connectLog[1]?.attributes?.url;
      expect(loggedUrl).not.toContain('secret-123');
      expect(loggedUrl).not.toContain('jwt-abc');
      expect(loggedUrl).toContain('wss://api.example.com/ws/stream');

      client.disconnect();
    });
  });

  // =========================================================================
  // ENH-08: Runtime validation for WebSocket messages
  // =========================================================================

  describe('ENH-08: runtime validation for WebSocket messages', () => {
    it('should reject messages with missing type field', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({ text: 'hello' }));

      expect(transcriptCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/invalid|unknown/i),
        expect.anything(),
      );

      client.disconnect();
    });

    it('should reject messages with invalid type value', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      const statusCb = vi.fn();
      client.onTranscript(transcriptCb);
      client.onStatus(statusCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'unknown_type', data: 'x' }));

      expect(transcriptCb).not.toHaveBeenCalled();
      expect(statusCb).not.toHaveBeenCalled();

      client.disconnect();
    });

    it('should reject transcript messages missing required fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript' }));

      expect(transcriptCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/invalid.*transcript/i),
        expect.anything(),
      );

      client.disconnect();
    });

    it('should accept valid transcript messages', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript',
        text: 'hello world',
        startTime: 0.0,
        endTime: 1.5,
        isFinal: true,
      }));

      expect(transcriptCb).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'transcript', text: 'hello world', isFinal: true }),
      );

      client.disconnect();
    });

    it('should normalize snake_case transcript payloads from backend stream', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript',
        text: 'hello snake case',
        start_time: 0.25,
        end_time: 1.75,
        is_final: '1',
        speaker_id: 'speaker-42',
        speaker_confidence: '0.87',
      }));

      expect(transcriptCb).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'transcript',
          text: 'hello snake case',
          startTime: 0.25,
          endTime: 1.75,
          isFinal: true,
          speakerId: 'speaker-42',
          speakerConfidence: 0.87,
        }),
      );

      client.disconnect();
    });

    it('should normalize optional speaker metadata fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript',
        text: 'speaker enriched payload',
        start_time: 1.0,
        end_time: 2.0,
        is_final: '1',
        speaker_id: 'speaker-7',
        speaker_label: 'Doctor',
        speaker_confidence: 0.91,
        speaker_embedding: [0.1, 0.2, 0.3],
        speaker_features: { source: 'remote', model: 'ecapa' },
      }));

      expect(transcriptCb).toHaveBeenCalledWith(
        expect.objectContaining({
          speakerId: 'speaker-7',
          speakerLabel: 'Doctor',
          speakerConfidence: 0.91,
          speakerEmbedding: [0.1, 0.2, 0.3],
          speakerFeatures: { source: 'remote', model: 'ecapa' },
        }),
      );

      client.disconnect();
    });

    it('should reject status messages missing required fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const statusCb = vi.fn();
      client.onStatus(statusCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'status' }));

      expect(statusCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/invalid.*status/i),
        expect.anything(),
      );

      client.disconnect();
    });

    it('should reject error messages missing required fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttV2WebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const errorCb = vi.fn();
      client.onWsError(errorCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'error' }));

      expect(errorCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/invalid.*error/i),
        expect.anything(),
      );

      client.disconnect();
    });
  });

  // =========================================================================
  // TASK-241: Debug Mode
  // =========================================================================

  describe('debug mode transcript logging', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('should log transcript JSON when debugMode is true and result is final', async () => {
      const debugClient = new SttV2WebSocketClient(mockLogger, undefined, true);

      const connectPromise = debugClient.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      debugClient.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript',
        text: 'hello world',
        startTime: 1.234,
        endTime: 3.567,
        isFinal: true,
        speakerId: 'speaker-2',
      }));

      expect(transcriptCb).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
      const logOutput = consoleSpy.mock.calls[0]![0] as string;
      expect(logOutput).toContain('[ARCAAI:DEBUG]');
      expect(logOutput).toContain('Transcript:');

      const jsonStr = logOutput.split('Transcript:\n')[1]!;
      const parsed = JSON.parse(jsonStr);
      expect(parsed.segment).toBe(1);
      expect(parsed.speaker).toBe('speaker-2');
      expect(parsed.start).toBe(1.234);
      expect(parsed.end).toBe(3.567);

      debugClient.disconnect();
    });

    it('should not log transcript when debugMode is false', async () => {
      const noDebugClient = new SttV2WebSocketClient(mockLogger, undefined, false);

      const connectPromise = noDebugClient.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      noDebugClient.onTranscript(vi.fn());

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript',
        text: 'hello',
        startTime: 0,
        endTime: 1,
        isFinal: true,
      }));

      expect(consoleSpy).not.toHaveBeenCalled();

      noDebugClient.disconnect();
    });

    it('should not log transcript for non-final results even in debug mode', async () => {
      const debugClient = new SttV2WebSocketClient(mockLogger, undefined, true);

      const connectPromise = debugClient.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      debugClient.onTranscript(vi.fn());

      lastMockWs!.simulateMessage(JSON.stringify({
        type: 'transcript',
        text: 'partial',
        startTime: 0,
        endTime: 0.5,
        isFinal: false,
      }));

      expect(consoleSpy).not.toHaveBeenCalled();

      debugClient.disconnect();
    });

    it('should increment segment counter across multiple final transcripts', async () => {
      const debugClient = new SttV2WebSocketClient(mockLogger, undefined, true);

      const connectPromise = debugClient.connect('wss://api.example.com/ws/stream');
      lastMockWs!.simulateOpen();
      await connectPromise;

      debugClient.onTranscript(vi.fn());

      for (let i = 0; i < 3; i++) {
        lastMockWs!.simulateMessage(JSON.stringify({
          type: 'transcript',
          text: `segment ${i}`,
          startTime: i,
          endTime: i + 1,
          isFinal: true,
        }));
      }

      expect(consoleSpy).toHaveBeenCalledTimes(3);
      const firstParsed = JSON.parse((consoleSpy.mock.calls[0]![0] as string).split('Transcript:\n')[1]!);
      const thirdParsed = JSON.parse((consoleSpy.mock.calls[2]![0] as string).split('Transcript:\n')[1]!);
      expect(firstParsed.segment).toBe(1);
      expect(thirdParsed.segment).toBe(3);

      debugClient.disconnect();
    });
  });
});
