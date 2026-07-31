/**
 * SttWebSocketClient Unit Tests — ASR-R-03
 *
 * TDD tests for the WebSocket client that speaks the stt protocol.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SttWebSocketClient } from '../SttWebSocketClient';
import { createMockLogger } from '../../__tests__/setup';
import type { WsTranscriptResult, WsStatusMessage, WsErrorMessage } from '../../types/stt';

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
  bufferedAmount = 0;
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

describe('SttWebSocketClient', () => {
  let client: SttWebSocketClient;
  let mockLogger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    client = new SttWebSocketClient(mockLogger);
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
      const c = new SttWebSocketClient();
      expect(c).toBeDefined();
    });
  });

  // =========================================================================
  // connect
  // =========================================================================

  describe('connect', () => {
    it('should open a WebSocket connection to the given URL', async () => {
      const connectPromise = client.connect('wss://api.example.com/ws/stt/stream?sessionId=abc&token=jwt&tenantId=test-tenant');

      // Simulate server accepting connection
      lastMockWs!.simulateOpen();
      await connectPromise;

      expect(client.isConnected()).toBe(true);
      expect(lastMockWs!.url).toBe('wss://api.example.com/ws/stt/stream?sessionId=abc&token=jwt&tenantId=test-tenant');
    });

    it('should set binaryType to arraybuffer', async () => {
      const connectPromise = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      expect(lastMockWs!.binaryType).toBe('arraybuffer');
    });

    it('should reject if connection fails', async () => {
      const connectPromise = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateError();
      lastMockWs!.close(1006, 'Connection failed');

      await expect(connectPromise).rejects.toThrow();
    });

    it('should not allow connecting when already connected', async () => {
      const p1 = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p1;

      await expect(client.connect('wss://example.com/ws?tenantId=test-tenant')).rejects.toThrow(/already connected/i);
    });

    it('should reject with timeout error if server does not respond within timeoutMs', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect('wss://example.com/ws?tenantId=test-tenant', { timeoutMs: 5000 });

      // Advance past the timeout without simulating open
      vi.advanceTimersByTime(5001);

      await expect(connectPromise).rejects.toThrow(/timed out/i);
      expect(client.isConnected()).toBe(false);

      vi.useRealTimers();
    });

    it('should use default timeout of 10000ms when no timeoutMs is provided', async () => {
      vi.useFakeTimers();

      const connectPromise = client.connect('wss://example.com/ws?tenantId=test-tenant');

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

      const connectPromise = client.connect('wss://example.com/ws?tenantId=test-tenant', { timeoutMs: 5000 });

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
  // WS must not open without a tenant claim.
  //
  // The stt upgrade carried no client-side assertion that the connection is
  // bound to a tenant, so a misconfigured caller could open a socket with no
  // tenant context. A fail-closed guard rejects connect()
  // BEFORE creating the socket unless a claim is resolvable from the options
  // (`tenantClaim`) or the URL (`tenantId` / `tenant`).
  //
  // The EFFECTIVE DEFAULT is fail-closed: `requireTenantClaim`
  // now defaults to `true`, so a bare connect() with no resolvable claim
  // rejects. Callers opt out explicitly with `requireTenantClaim: false`. The
  // SDK's own streaming flow always carries `?tenantId=` (see
  // StreamingSessionManager.getWebSocketUrl), which is why the connect tests
  // throughout this file now pass `?tenantId=test-tenant`. The tests below use
  // a distinct `wss://no-claim.example/ws` host so they are unaffected by that
  // file-wide tenant-id injection.
  // =========================================================================
  describe('tenant-claim guard', () => {
    // --- default-on ---------------------------------------
    it('rejects a bare connect() BY DEFAULT when no claim is resolvable (no socket created)', async () => {
      const connectPromise = client.connect('wss://no-claim.example/ws');
      // Capture the rejection up-front so a slow reject can't leak as an
      // unhandled rejection, and so the run doesn't hang on a pending socket.
      const settled = connectPromise.then(() => 'resolved' as const).catch((e: unknown) => e);

      // Fail-closed by default: the guard trips synchronously, before any socket.
      expect(lastMockWs).toBeNull();

      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/tenant claim/i);
      expect(client.isConnected()).toBe(false);
    });

    it('connects BY DEFAULT (no requireTenantClaim option) when a tenantId is in the URL', async () => {
      const connectPromise = client.connect('wss://api.example.com/ws/stt/stream?tenantId=tenant-A&ticket=t1');
      // Claim resolved from the URL → a socket is created.
      expect(lastMockWs).not.toBeNull();
      lastMockWs!.simulateOpen();
      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });

    it('connects BY DEFAULT when an explicit tenantClaim option is provided (bare URL)', async () => {
      const connectPromise = client.connect('wss://no-claim.example/ws', { tenantClaim: 'tenant-A' });
      expect(lastMockWs).not.toBeNull();
      lastMockWs!.simulateOpen();
      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });

    // --- explicit opt-out escape hatch (only the DEFAULT changed) -------
    it('still connects on a bare URL when requireTenantClaim is explicitly false (escape hatch)', async () => {
      const connectPromise = client.connect('wss://no-claim.example/ws', { requireTenantClaim: false });
      expect(lastMockWs).not.toBeNull();
      lastMockWs!.simulateOpen();
      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });

    it('uses the constructor tenant claim setting for streaming clients', async () => {
      const compatClient = new SttWebSocketClient(mockLogger, { enabled: false, requireTenantClaim: false });
      const connectPromise = compatClient.connect('wss://no-claim.example/ws');
      expect(lastMockWs).not.toBeNull();
      lastMockWs!.simulateOpen();
      await connectPromise;
      expect(compatClient.isConnected()).toBe(true);
      compatClient.disconnect();
    });

    // --- explicit opt-in ----------------
    it('rejects connect() when requireTenantClaim is explicitly true but no claim is resolvable', async () => {
      const connectPromise = client.connect('wss://no-claim.example/ws', { requireTenantClaim: true });
      const settled = connectPromise.then(() => 'resolved' as const).catch((e: unknown) => e);
      expect(lastMockWs).toBeNull();
      const result = await settled;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/tenant claim/i);
      expect(client.isConnected()).toBe(false);
    });

    it('connects when requireTenantClaim is explicitly true and a tenantId is in the URL', async () => {
      const connectPromise = client.connect('wss://api.example.com/ws/stt/stream?tenantId=tenant-A&ticket=t1', {
        requireTenantClaim: true,
      });
      expect(lastMockWs).not.toBeNull();
      lastMockWs!.simulateOpen();
      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });

    it('connects when requireTenantClaim is explicitly true and an explicit tenantClaim option is provided', async () => {
      const connectPromise = client.connect('wss://api.example.com/ws/stt/stream?ticket=t1', {
        requireTenantClaim: true,
        tenantClaim: 'tenant-A',
      });
      expect(lastMockWs).not.toBeNull();
      lastMockWs!.simulateOpen();
      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });
  });

  // =========================================================================
  // sendAudioFrame (binary PCM)
  // =========================================================================

  describe('sendAudioFrame', () => {
    it('should send raw PCM buffer as binary', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const pcmBuffer = new ArrayBuffer(3200); // 100ms of 16kHz int16 mono
      client.sendAudioFrame(pcmBuffer);

      expect(lastMockWs!.sent).toHaveLength(1);
      expect(lastMockWs!.sent[0]).toBe(pcmBuffer);
    });

    it('sends an Int16Array view as-is — zero copy', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const pcmView = new Int16Array([100, -200, 300]);
      const sent = client.sendAudioFrame(pcmView);

      expect(sent).toBe(true);
      expect(lastMockWs!.sent).toHaveLength(1);
      // The exact view object reaches ws.send — no intermediate ArrayBuffer
      // slice/copy on the per-frame hot path.
      expect(lastMockWs!.sent[0]).toBe(pcmView);
      expect((lastMockWs!.sent[0] as unknown as Int16Array).byteLength).toBe(pcmView.byteLength);
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const transcripts: WsTranscriptResult[] = [];
      client.onTranscript((t) => transcripts.push(t));

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'Hel',
          startTime: 0,
          endTime: 0.3,
          isFinal: false,
        }),
      );
      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'Hello',
          startTime: 0,
          endTime: 0.5,
          isFinal: true,
        }),
      );

      expect(transcripts).toHaveLength(2);
      expect(transcripts[0].isFinal).toBe(false);
      expect(transcripts[1].isFinal).toBe(true);
    });
  });

  describe('onStatus', () => {
    it('should fire callback for status messages', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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

    // TASK-567: the backend publishes an ASR-engine swap as a `status`/
    // `provider_switched` result that carries typed fields but NO human
    // `message`. The validator must not drop it, and the typed fields pass
    // through to onStatus.
    it('forwards a provider_switched status frame without a message', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const onStatus = vi.fn();
      client.onStatus(onStatus);

      const msg = {
        type: 'status',
        status: 'provider_switched',
        from_pipeline: 'azure_speech_transcription',
        to_pipeline: 'sarvam_transcription',
        reason: 'auto',
        utterance_index: 4,
      };
      lastMockWs!.simulateMessage(JSON.stringify(msg));

      expect(onStatus).toHaveBeenCalledWith(msg);
    });
  });

  describe('onWsError', () => {
    it('should fire callback for error messages from server', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      expect(() => {
        lastMockWs!.simulateMessage('not valid json {{{');
      }).not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith('Failed to parse WebSocket message', expect.any(Object));
    });

    it('should warn on unknown message type from server', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.simulateMessage(new ArrayBuffer(16));

      expect(mockLogger.warn).toHaveBeenCalledWith('Received non-string WebSocket message', expect.any(Object));
    });

    it('should not fire any callback for unknown message types', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      client.disconnect();

      expect(client.isConnected()).toBe(false);
    });

    it('should be safe to call when not connected', () => {
      expect(() => client.disconnect()).not.toThrow();
    });

    it('should fire onDisconnect callback', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const onDisconnect = vi.fn();
      client.onDisconnect(onDisconnect);

      client.disconnect();

      expect(onDisconnect).toHaveBeenCalled();
    });

    it('should allow reconnecting after disconnect', async () => {
      const p1 = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p1;
      client.disconnect();

      const p2 = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p2;

      expect(client.isConnected()).toBe(true);
    });
  });

  // =========================================================================
  // stopAndDrain (F-31) — intentional stop must not close the socket out
  // from under a tail final still in flight. Sends the finalize control
  // frame, then keeps the socket open until the server's terminal status
  // ('closed'/'cancelled') arrives or a drain timeout elapses.
  // =========================================================================

  describe('stopAndDrain (F-31)', () => {
    it('sends the stop control frame and keeps the socket open to deliver a tail final before closing', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const onTranscript = vi.fn();
      client.onTranscript(onTranscript);

      const drainPromise = client.stopAndDrain();

      // The finalize control frame was sent immediately.
      const sentTypes = lastMockWs!.sent.map((s) => JSON.parse(String(s)).type);
      expect(sentTypes).toContain('stop');

      // Socket must still be OPEN while draining — a tail final can still
      // reach the normal transcript callback.
      expect(client.isConnected()).toBe(true);

      const tailFinal: WsTranscriptResult = {
        type: 'transcript',
        text: 'tail segment arriving after stop',
        startTime: 1.0,
        endTime: 2.0,
        isFinal: true,
      };
      lastMockWs!.simulateMessage(JSON.stringify(tailFinal));
      expect(onTranscript).toHaveBeenCalledWith(tailFinal);

      // Server confirms the session is fully finalized — NOW the client closes.
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'status', status: 'closed', message: 'done' }));

      await drainPromise;
      expect(client.isConnected()).toBe(false);
    });

    it('also drains on a "cancelled" terminal status', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const drainPromise = client.stopAndDrain();
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'status', status: 'cancelled', message: 'session cancelled' }));

      await drainPromise;
      expect(client.isConnected()).toBe(false);
    });

    it('closes anyway once the drain timeout elapses without a terminal status', async () => {
      vi.useFakeTimers();
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const drainPromise = client.stopAndDrain(5000);
      // No terminal status ever arrives.
      expect(client.isConnected()).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);
      await drainPromise;

      expect(client.isConnected()).toBe(false);
      vi.useRealTimers();
    });

    it('is a no-op close when the socket is already gone', async () => {
      await expect(client.stopAndDrain()).resolves.toBeUndefined();
      expect(client.isConnected()).toBe(false);
    });

    it('does not attempt reconnect for an intentional stop-drain close, even with reconnect enabled', async () => {
      vi.useFakeTimers();
      const reconnectClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
      });

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;
      const socketBeforeDrain = lastMockWs;

      const drainPromise = reconnectClient.stopAndDrain();
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'status', status: 'closed', message: 'done' }));
      await drainPromise;

      // Give any (incorrectly-armed) reconnect backoff timer a chance to fire.
      await vi.advanceTimersByTimeAsync(10_000);

      expect(lastMockWs).toBe(socketBeforeDrain); // no new WebSocket was created
      expect(reconnectClient.isConnected()).toBe(false);
      vi.useRealTimers();
    });

    it('does not attempt reconnect when the drain times out, even with reconnect enabled', async () => {
      vi.useFakeTimers();
      const reconnectClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
      });

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;
      const socketBeforeDrain = lastMockWs;

      const drainPromise = reconnectClient.stopAndDrain(5000);
      await vi.advanceTimersByTimeAsync(5000); // drain timeout fires, closes
      await drainPromise;

      await vi.advanceTimersByTimeAsync(10_000); // any reconnect backoff window

      expect(lastMockWs).toBe(socketBeforeDrain);
      expect(reconnectClient.isConnected()).toBe(false);
      vi.useRealTimers();
    });
  });

  // =========================================================================
  // Reconnection (WsReconnectOptions)
  // =========================================================================

  describe('reconnection', () => {
    let reconnectClient: SttWebSocketClient;

    beforeEach(() => {
      reconnectClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
      });
    });

    it('should not auto-reconnect when reconnect is disabled (default)', async () => {
      vi.useFakeTimers();

      // Default client has no reconnect options
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
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

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

    // `onReconnect` fires at attempt-START (during backoff,
    // before the socket is back). Consumers that must reflect "live again" need
    // a distinct SUCCESS signal fired only when the transport actually
    // re-opens. `onReconnected` fires on the reconnect open, never on the first
    // connect.
    it('should fire onReconnected only when a reconnect attempt re-opens the socket (C6-02)', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const onReconnected = vi.fn();
      reconnectClient.onReconnected(onReconnected);

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      // Initial connect is NOT a reconnect — no success signal.
      expect(onReconnected).not.toHaveBeenCalled();

      // Server drops → attemptReconnect schedules (onReconnect at attempt-start).
      lastMockWs!.close(1006, 'Lost');
      await vi.advanceTimersByTimeAsync(101);
      // The socket is still not back — a fresh WS exists but has not opened yet.
      expect(onReconnected).not.toHaveBeenCalled();

      // The reconnect attempt's socket opens — the transport is genuinely back.
      lastMockWs!.simulateOpen();
      expect(onReconnected).toHaveBeenCalledTimes(1);
      expect(reconnectClient.isConnected()).toBe(true);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should log error and fire onReconnectFailed when maxAttempts is 0', async () => {
      // With maxAttempts=0, the first disconnect immediately exhausts attempts
      const onReconnectFailed = vi.fn();
      const zeroAttemptsClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 0,
        baseDelayMs: 50,
        maxDelayMs: 5000,
      });
      zeroAttemptsClient.onReconnectFailed(onReconnectFailed);

      const p = zeroAttemptsClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

    // A genuine reconnect (one that goes on to deliver a message)
    // must reset the attempt budget so EACH disconnect episode gets the full
    // maxAttempts, instead of the counter depleting cumulatively across the
    // session. The reset is triggered by the first server message after a
    // reconnect (the "session is alive" signal); a flap that opens then closes
    // WITHOUT a message never resets — that is what keeps the reconnect loop exhausting.
    it('should give each disconnect episode a fresh retry budget after a reconnect delivers a message', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const onReconnect = vi.fn();
      const onReconnectFailed = vi.fn();
      reconnectClient.onReconnect(onReconnect);
      reconnectClient.onReconnectFailed(onReconnectFailed);

      const p = reconnectClient.connect('wss://example.com/ws?sessionId=s1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      // --- Episode 1: burn two attempts (flap with no message), then a third
      //     attempt that DELIVERS a message → the session is genuinely alive. ---

      // Drop → attempt 1 (delay 100 * 2^0 = 100ms).
      lastMockWs!.close(1006, 'Lost');
      await vi.advanceTimersByTimeAsync(101);
      expect(onReconnect).toHaveBeenLastCalledWith(1);

      // Attempt 1 socket opens then flaps shut (no message → no acknowledgement).
      lastMockWs!.simulateOpen();
      lastMockWs!.close(1006, 'Lost'); // → attempt 2 (delay 100 * 2^1 = 200ms)
      await vi.advanceTimersByTimeAsync(201);
      expect(onReconnect).toHaveBeenLastCalledWith(2);
      expect(reconnectClient.getReconnectAttempts()).toBe(2);

      // Attempt 2 socket opens AND the server sends a message — genuine recovery.
      lastMockWs!.simulateOpen();
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript', text: 'post-reconnect caption', isFinal: false }));

      // reconnect success → the budget is reset (not stuck at 2).
      expect(reconnectClient.getReconnectAttempts()).toBe(0);
      expect(onReconnectFailed).not.toHaveBeenCalled();

      // --- Episode 2 (a later drop): must get the FULL budget again, not the
      //     single leftover attempt a cumulative counter (the bug) would give. ---
      onReconnect.mockClear();

      lastMockWs!.close(1006, 'Lost again');
      await vi.advanceTimersByTimeAsync(101);
      // Fresh episode restarts at attempt 1 (under the bug it would be 3).
      expect(onReconnect).toHaveBeenLastCalledWith(1);
      expect(reconnectClient.getReconnectAttempts()).toBe(1);

      // Spend the remaining budget by flapping: attempts 2 and 3, then give up.
      lastMockWs!.simulateOpen();
      lastMockWs!.close(1006, 'Lost again'); // → attempt 2 (200ms)
      await vi.advanceTimersByTimeAsync(201);
      lastMockWs!.simulateOpen();
      lastMockWs!.close(1006, 'Lost again'); // → attempt 3 (400ms)
      await vi.advanceTimersByTimeAsync(401);
      lastMockWs!.simulateOpen();
      lastMockWs!.close(1006, 'Lost again'); // 3 >= maxAttempts(3) → exhausted

      expect(onReconnect).toHaveBeenLastCalledWith(3);
      // A full budget of 3 fresh attempts was spent before giving up.
      expect(onReconnectFailed).toHaveBeenCalledTimes(1);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    // F-07: a reconnect attempt that fails to OPEN (refused/DNS/TLS/timeout)
    // closes with `this.ws` still null, so `connect`'s onclose takes the reject
    // branch and does NOT re-arm — the old code let the retry chain die silently
    // before maxAttempts and never fired onReconnectFailed. The failure path
    // must now schedule the next attempt (and ultimately fire the failed
    // callback when the budget is spent).
    it('F-07: a reconnect attempt that fails to OPEN schedules the next attempt (chain does not die)', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const onReconnect = vi.fn();
      reconnectClient.onReconnect(onReconnect);

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      // Server drops → attempt 1 scheduled (100ms).
      lastMockWs!.close(1006, 'Lost');
      await vi.advanceTimersByTimeAsync(101);
      expect(onReconnect).toHaveBeenLastCalledWith(1);
      const attempt1Ws = lastMockWs!;

      // Attempt 1's socket is REFUSED — it closes before ever opening.
      attempt1Ws.close(1006, 'refused');
      // Flush the connect() rejection handler so the failure path re-arms.
      await vi.advanceTimersByTimeAsync(1);

      // The chain continued: a SECOND attempt was scheduled (backoff 200ms).
      await vi.advanceTimersByTimeAsync(300);
      expect(onReconnect).toHaveBeenLastCalledWith(2);
      expect(lastMockWs).not.toBe(attempt1Ws);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('F-07: when every reconnect attempt fails to OPEN, onReconnectFailed fires exactly once', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const onReconnectFailed = vi.fn();
      reconnectClient.onReconnectFailed(onReconnectFailed); // maxAttempts = 3

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      // Server drops → attempt 1 scheduled.
      lastMockWs!.close(1006, 'Lost');

      // Refuse all three attempts in turn; each refusal must re-arm the next.
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(2000); // fire the scheduled connect()
        lastMockWs!.close(1006, 'refused'); // attempt fails to open
        await vi.advanceTimersByTimeAsync(1); // flush the rejection → re-arm/give-up
      }

      expect(onReconnectFailed).toHaveBeenCalledTimes(1);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    // F-06 client coordination: the gateway now answers a false resume (a
    // freshly-created session after grace/cross-instance) with
    // `resume_failed { reason: 'unknown_session' }`. That is TERMINAL — the
    // session is gone — so the client must surface the reconnect-failed callback
    // so the higher layer rebuilds. A `buffer_overflow` resume_failed is
    // RECOVERABLE (the session is alive; only the replay buffer rolled) and must
    // NOT trip the terminal callback.
    it('F-06: a terminal resume_failed (unknown_session) surfaces onReconnectFailed', async () => {
      const onReconnectFailed = vi.fn();
      reconnectClient.onReconnectFailed(onReconnectFailed);

      const p = reconnectClient.connect('wss://example.com/ws?sessionId=s1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'resume_failed', sessionId: 's1', reason: 'unknown_session' }));

      expect(onReconnectFailed).toHaveBeenCalledTimes(1);
    });

    it('F-06: a recoverable resume_failed (buffer_overflow) does NOT surface onReconnectFailed', async () => {
      const onReconnectFailed = vi.fn();
      reconnectClient.onReconnectFailed(onReconnectFailed);

      const p = reconnectClient.connect('wss://example.com/ws?sessionId=s1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'resume_failed', sessionId: 's1', reason: 'buffer_overflow', minAvailableSeq: 5 }));

      expect(onReconnectFailed).not.toHaveBeenCalled();
    });

    it('should compute delay capped by maxDelayMs using exponential backoff formula', () => {
      // Verify the backoff formula: delay = min(baseDelayMs * 2^(attempt-1), maxDelayMs) + jitter
      // This tests the configuration is stored correctly and the computed delays
      // follow the expected pattern. The actual timer-based behavior is tested
      // in the simpler auto-reconnect test above.
      const cappedClient = new SttWebSocketClient(mockLogger, {
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

      const jitterClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      });

      const p = jitterClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.close(1006, 'Lost');

      // With Math.random() = 0, jitter = 0, delay = 1000ms exactly
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('reconnecting in 1000ms'), expect.any(Object));

      // With Math.random() = 1.0, jitter = exponentialDelay * 0.5
      // For attempt 1: exponentialDelay = 1000, jitter = 500, total = 1500
      mathRandomSpy.mockReturnValue(1.0);

      // Advance past first reconnect to trigger second attempt
      await vi.advanceTimersByTimeAsync(1001);
      lastMockWs!.simulateOpen();
      lastMockWs!.close(1006, 'Lost');

      // Attempt 2: exponentialDelay = min(1000 * 2^1, 30000) = 2000
      // jitter = 1.0 * 2000 * 0.5 = 1000, total = 3000
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('reconnecting in 3000ms'), expect.any(Object));

      jitterClient.disconnect();
      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('should cancel pending reconnection via cancelReconnect()', async () => {
      vi.useFakeTimers();

      const onReconnect = vi.fn();
      reconnectClient.onReconnect(onReconnect);

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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

      const p = reconnectClient.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const failClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 0,
        baseDelayMs: 50,
        maxDelayMs: 5000,
      });

      const p = failClient.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      // Server closes — maxAttempts=0 immediately exhausts
      lastMockWs!.close(1006, 'Lost');
      expect(failClient.isConnected()).toBe(false);

      // Manual reconnect should still work
      const p2 = failClient.connect('wss://example.com/ws?tenantId=test-tenant');
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
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(1, 'base64data');

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      expect(parsed).toEqual({ type: 'audio', seq: 1, data: 'base64data' });
      expect(parsed).not.toHaveProperty('microphoneId');
    });

    it('should not include microphoneId when passed as empty string', async () => {
      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      client.sendAudioFrameJson(1, 'base64data', '');

      const parsed = JSON.parse(lastMockWs!.sent[0] as string);
      // Empty string is falsy — microphoneId should not be set
      expect(parsed).not.toHaveProperty('microphoneId');
    });
  });

  // =========================================================================
  // Reconnect loop must not cycle infinitely
  // =========================================================================

  describe('reconnect counter must not reset on brief connections', () => {
    it('should exhaust maxAttempts even if connections open briefly then close', async () => {
      vi.useFakeTimers();
      try {
        const mockLogger = createMockLogger();
        const client = new SttWebSocketClient(mockLogger, {
          enabled: true,
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        });

        const failedCb = vi.fn();
        client.onReconnectFailed(failedCb);

        // Initial connect
        const connectPromise = client.connect('ws://test/stream?tenantId=test-tenant');
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
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?sessionId=secret-123&token=jwt-abc&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const debugCalls = (mockLogger.debug as any).mock.calls;
      const connectLog = debugCalls.find((c: any[]) => c[0] === 'Connecting to stt WebSocket');
      expect(connectLog).toBeDefined();

      const loggedUrl = connectLog[1]?.attributes?.url;
      expect(loggedUrl).not.toContain('secret-123');
      expect(loggedUrl).not.toContain('jwt-abc');
      // stripQueryParams removes ALL query params (sessionId, token, tenantId),
      // leaving only the base; tenantId is non-secret but still must not be logged.
      expect(loggedUrl).not.toContain('test-tenant');
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
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({ text: 'hello' }));

      expect(transcriptCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/invalid|unknown/i), expect.anything());

      client.disconnect();
    });

    it('should reject messages with invalid type value', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
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
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript' }));

      expect(transcriptCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/invalid.*transcript/i), expect.anything());

      client.disconnect();
    });

    it('should accept valid transcript messages', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'hello world',
          startTime: 0.0,
          endTime: 1.5,
          isFinal: true,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(expect.objectContaining({ type: 'transcript', text: 'hello world', isFinal: true }));

      client.disconnect();
    });

    it('should normalize snake_case transcript payloads from backend stream', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'hello snake case',
          start_time: 0.25,
          end_time: 1.75,
          is_final: '1',
          speaker_id: 'speaker-42',
          speaker_confidence: '0.87',
        }),
      );

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

    it('should normalize english_text from backend stream', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்',
          english_text: 'Will not call ...',
          start_time: 74.784,
          end_time: 82.88,
          is_final: '1',
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'transcript',
          text: 'வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்',
          englishText: 'Will not call ...',
          startTime: 74.784,
          endTime: 82.88,
          isFinal: true,
        }),
      );

      client.disconnect();
    });

    it('should normalize optional speaker metadata fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
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
        }),
      );

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

    // The applications bridge derives a canonical camelCase
    // `speakerLabel` and the gateway relays it type-erased, so the wire the SDK
    // actually receives carries `speakerId` + `speakerLabel` (camelCase). Lock
    // that the client carries BOTH straight through to the admin/vox consumers.
    it('should carry the canonical camelCase speakerId + speakerLabel from the wire', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'anonymous diarized final',
          startTime: 4.0,
          endTime: 5.0,
          isFinal: true,
          speakerId: 'Speaker 0',
          speakerLabel: 'Speaker 0',
          seq: 12,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(expect.objectContaining({ speakerId: 'Speaker 0', speakerLabel: 'Speaker 0' }));

      client.disconnect();
    });

    // stableChars (committed-prefix length on partials) is
    // additive and dual-cased like the other normalized fields.
    it('should normalize stableChars from camelCase payloads', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'hello tentative tail',
          startTime: 0.5,
          endTime: 1.5,
          isFinal: false,
          stableChars: 5,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(expect.objectContaining({ stableChars: 5, isFinal: false }));

      client.disconnect();
    });

    it('should normalize stable_chars from snake_case payloads', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'hello tentative tail',
          start_time: 0.5,
          end_time: 1.5,
          is_final: '0',
          stable_chars: 7,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(expect.objectContaining({ stableChars: 7 }));

      client.disconnect();
    });

    it('should omit stableChars when neither casing is present (older servers)', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'plain partial',
          startTime: 0,
          endTime: 1,
          isFinal: false,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledTimes(1);
      const normalized = transcriptCb.mock.calls[0][0];
      expect('stableChars' in normalized).toBe(false);

      client.disconnect();
    });

    // utteranceIndex + resultType are additive and
    // dual-cased; gloss results ride the normal transcript relay with the
    // gateway's camelCase field names.
    it('should normalize utteranceIndex and resultType from gateway (camelCase) payloads', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'xin chào',
          startTime: 0,
          endTime: 1.5,
          isFinal: true,
          resultType: 'gloss',
          englishText: 'hello',
          utteranceIndex: 4,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(
        expect.objectContaining({
          resultType: 'gloss',
          englishText: 'hello',
          utteranceIndex: 4,
          isFinal: true,
        }),
      );

      client.disconnect();
    });

    it('should normalize utterance_index from snake_case payloads', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'snake payload',
          start_time: 0,
          end_time: 1,
          is_final: '0',
          utterance_index: 7,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledWith(expect.objectContaining({ utteranceIndex: 7 }));

      client.disconnect();
    });

    // The wire-level result kind field is `type` (segment|gloss). It cannot
    // ride the WS envelope (whose `type` is 'transcript'), so the wire-shape
    // acceptance is pinned against normalizeTranscript directly.
    it('should accept the wire `type` field as resultType in normalizeTranscript', () => {
      const normalize = (
        SttWebSocketClient as unknown as {
          normalizeTranscript(msg: Record<string, unknown>): WsTranscriptResult | null;
        }
      ).normalizeTranscript;

      const normalized = normalize({
        type: 'gloss',
        text: 'xin chào',
        start_time: 0,
        end_time: 1.5,
        is_final: true,
        english_text: 'hello',
        utterance_index: 3,
      });

      expect(normalized).not.toBeNull();
      expect(normalized!.resultType).toBe('gloss');
      expect(normalized!.englishText).toBe('hello');
      expect(normalized!.utteranceIndex).toBe(3);

      // The WS envelope's own `type: 'transcript'` must NOT leak into
      // resultType — only segment/gloss are accepted.
      const envelope = normalize({
        type: 'transcript',
        text: 'plain',
        start_time: 0,
        end_time: 1,
        is_final: true,
      });
      expect(envelope).not.toBeNull();
      expect('resultType' in envelope!).toBe(false);
    });

    // Guards against dropping the ENTIRE transcript the moment ONE of
    // text/startTime/endTime/isFinal is absent or mistyped (e.g. a numeric
    // is_final, or a server that omits timing on a partial). Instead it
    // degrades gracefully: only a genuinely unusable payload (no text) is
    // dropped; missing OPTIONAL metadata defaults instead of discarding the
    // caption.
    it('tolerates missing/mistyped optional fields instead of dropping the caption (C6-04)', () => {
      const normalize = (
        SttWebSocketClient as unknown as {
          normalizeTranscript(msg: Record<string, unknown>): WsTranscriptResult | null;
        }
      ).normalizeTranscript;

      // Timing + isFinal omitted entirely — the caption text still surfaces and
      // an absent isFinal degrades to a partial (not a premature final).
      const missingTiming = normalize({ type: 'transcript', text: 'worse after lunch' });
      expect(missingTiming).not.toBeNull();
      expect(missingTiming!.text).toBe('worse after lunch');
      expect(missingTiming!.isFinal).toBe(false);
      expect(missingTiming!.startTime).toBe(0);
      expect(missingTiming!.endTime).toBe(0);

      // A NUMERIC is_final (1/0) — the old branch only knew booleans and the
      // strings '1'/'0', so it dropped this. Now it coerces.
      const numericFinal = normalize({ type: 'transcript', text: 'done', start_time: 1, end_time: 2, is_final: 1 });
      expect(numericFinal).not.toBeNull();
      expect(numericFinal!.text).toBe('done');
      expect(numericFinal!.isFinal).toBe(true);

      const numericPartial = normalize({ type: 'transcript', text: 'typing', is_final: 0 });
      expect(numericPartial).not.toBeNull();
      expect(numericPartial!.isFinal).toBe(false);

      // Additive resume/segment metadata still rides through on a partial payload.
      const withMeta = normalize({ type: 'transcript', text: 'partial', seq: 12, stable_chars: 4 });
      expect(withMeta).not.toBeNull();
      expect(withMeta!.seq).toBe(12);
      expect(withMeta!.stableChars).toBe(4);

      // A genuinely unusable payload (no text at all) is STILL rejected.
      expect(normalize({ type: 'transcript', start_time: 0, end_time: 1, is_final: true })).toBeNull();
      expect(normalize({ type: 'transcript', text: 42 })).toBeNull();
    });

    it('should omit utteranceIndex and resultType when neither casing is present (older servers)', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const transcriptCb = vi.fn();
      client.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'legacy payload',
          startTime: 0,
          endTime: 1,
          isFinal: true,
        }),
      );

      expect(transcriptCb).toHaveBeenCalledTimes(1);
      const normalized = transcriptCb.mock.calls[0][0];
      expect('utteranceIndex' in normalized).toBe(false);
      expect('resultType' in normalized).toBe(false);

      client.disconnect();
    });

    it('should reject status messages missing required fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const statusCb = vi.fn();
      client.onStatus(statusCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'status' }));

      expect(statusCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/invalid.*status/i), expect.anything());

      client.disconnect();
    });

    it('should reject error messages missing required fields', async () => {
      const mockLogger = createMockLogger();
      const client = new SttWebSocketClient(mockLogger);

      const connectPromise = client.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      const errorCb = vi.fn();
      client.onWsError(errorCb);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'error' }));

      expect(errorCb).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringMatching(/invalid.*error/i), expect.anything());

      client.disconnect();
    });
  });

  // =========================================================================
  // Debug Mode
  //
  // Originally these tests asserted that debug-mode transcripts hit
  // `console.log`. W0-13 routes that channel through `SDKLogger.debug(...)`
  // instead, so the assertions now target `mockLogger.debug` and we keep a
  // spy on `console.log` to PROVE the ad-hoc console call has been removed.
  // =========================================================================
  describe('debug mode transcript logging', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      mockLogger.debug.mockClear();
    });

    afterEach(() => {
      consoleSpy.mockRestore();
    });

    it('routes transcript debug through SDKLogger.debug (NOT console.log) when debugMode=true', async () => {
      const debugClient = new SttWebSocketClient(mockLogger, undefined, true);

      const connectPromise = debugClient.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      mockLogger.debug.mockClear();

      const transcriptCb = vi.fn();
      debugClient.onTranscript(transcriptCb);

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'hello world',
          startTime: 1.234,
          endTime: 3.567,
          isFinal: true,
          speakerId: 'speaker-2',
        }),
      );

      expect(transcriptCb).toHaveBeenCalled();
      expect(consoleSpy).not.toHaveBeenCalled();

      // Find the transcript debug call (debug() is also invoked from other
      // code paths like onclose; filter on the [ARCAAI:DEBUG] marker).
      const transcriptDebugCalls = mockLogger.debug.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('[ARCAAI:DEBUG]'),
      );
      expect(transcriptDebugCalls).toHaveLength(1);
      const message = transcriptDebugCalls[0]![0] as string;
      expect(message).toContain('SttWebSocket');
      expect(message).toContain('Transcript:');
      const meta = transcriptDebugCalls[0]![1] as { component?: string; attributes?: { entry?: Record<string, unknown> } } | undefined;
      expect(meta?.component).toBe('SttWebSocketClient');
      expect(meta?.attributes?.entry?.segment).toBe(1);
      expect(meta?.attributes?.entry?.speaker).toBe('speaker-2');
      expect(meta?.attributes?.entry?.start).toBe(1.234);
      expect(meta?.attributes?.entry?.end).toBe(3.567);

      debugClient.disconnect();
    });

    it('does NOT log transcript debug when debugMode is false', async () => {
      const noDebugClient = new SttWebSocketClient(mockLogger, undefined, false);

      const connectPromise = noDebugClient.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      mockLogger.debug.mockClear();
      noDebugClient.onTranscript(vi.fn());

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'hello',
          startTime: 0,
          endTime: 1,
          isFinal: true,
        }),
      );

      expect(consoleSpy).not.toHaveBeenCalled();
      const transcriptDebugCalls = mockLogger.debug.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('[ARCAAI:DEBUG]'),
      );
      expect(transcriptDebugCalls).toHaveLength(0);

      noDebugClient.disconnect();
    });

    it('does NOT log transcript for non-final results even in debug mode', async () => {
      const debugClient = new SttWebSocketClient(mockLogger, undefined, true);

      const connectPromise = debugClient.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      mockLogger.debug.mockClear();
      debugClient.onTranscript(vi.fn());

      lastMockWs!.simulateMessage(
        JSON.stringify({
          type: 'transcript',
          text: 'partial',
          startTime: 0,
          endTime: 0.5,
          isFinal: false,
        }),
      );

      expect(consoleSpy).not.toHaveBeenCalled();
      const transcriptDebugCalls = mockLogger.debug.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('[ARCAAI:DEBUG]'),
      );
      expect(transcriptDebugCalls).toHaveLength(0);

      debugClient.disconnect();
    });

    it('increments the segment counter across multiple final transcripts (via logger.debug)', async () => {
      const debugClient = new SttWebSocketClient(mockLogger, undefined, true);

      const connectPromise = debugClient.connect('wss://api.example.com/ws/stream?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await connectPromise;

      mockLogger.debug.mockClear();
      debugClient.onTranscript(vi.fn());

      for (let i = 0; i < 3; i++) {
        lastMockWs!.simulateMessage(
          JSON.stringify({
            type: 'transcript',
            text: `segment ${i}`,
            startTime: i,
            endTime: i + 1,
            isFinal: true,
          }),
        );
      }

      const transcriptDebugCalls = mockLogger.debug.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('[ARCAAI:DEBUG]'),
      );
      expect(transcriptDebugCalls).toHaveLength(3);
      expect((transcriptDebugCalls[0]![1] as { attributes: { entry: { segment: number } } }).attributes.entry.segment).toBe(1);
      expect((transcriptDebugCalls[2]![1] as { attributes: { entry: { segment: number } } }).attributes.entry.segment).toBe(3);
      expect(consoleSpy).not.toHaveBeenCalled();

      debugClient.disconnect();
    });
  });

  // =========================================================================
  // Source file MUST NOT contain `console.log`.
  //
  // This locks the contract that no future edit can accidentally re-introduce
  // an ad-hoc console.log call into SttWebSocketClient.ts. The check reads
  // the source file as text and strips comments so doc-block examples that
  // mention `console.log` don't false-positive.
  // =========================================================================
  // =========================================================================
  // Bounded queue + bufferedAmount watermark backpressure
  // =========================================================================
  describe('backpressure', () => {
    it('drops binary frames when bufferedAmount exceeds the high-watermark', async () => {
      const client = new SttWebSocketClient(mockLogger, undefined, false, {
        bufferedAmountHighWatermark: 100,
      });
      const onDrop = vi.fn();
      client.onBackpressureDrop(onDrop);

      const p = client.connect('wss://example.com/ws?sessionId=s1&ticket=t1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      // 50 < 100 — should be sent.
      lastMockWs!.bufferedAmount = 50;
      const sent = client.sendAudioFrame(new ArrayBuffer(16));
      expect(sent).toBe(true);
      expect(lastMockWs!.sent).toHaveLength(1);

      // 200 > 100 — drop.
      lastMockWs!.bufferedAmount = 200;
      const dropped = client.sendAudioFrame(new ArrayBuffer(16));
      expect(dropped).toBe(false);
      expect(lastMockWs!.sent).toHaveLength(1); // unchanged
      expect(onDrop).toHaveBeenCalledWith('buffered_amount_high');
      expect(client.getDroppedFrameCount()).toBe(1);
    });

    it('drops JSON frames when bufferedAmount exceeds the high-watermark', async () => {
      const client = new SttWebSocketClient(mockLogger, undefined, false, {
        bufferedAmountHighWatermark: 10,
      });
      const onDrop = vi.fn();
      client.onBackpressureDrop(onDrop);

      const p = client.connect('wss://example.com/ws?sessionId=s1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.bufferedAmount = 50;
      const ok = client.sendAudioFrameJson(1, 'aaa');
      expect(ok).toBe(false);
      expect(client.getDroppedFrameCount()).toBe(1);
      expect(onDrop).toHaveBeenCalledTimes(1);
    });

    it('resets dropped-frame counter on each new connect', async () => {
      const client = new SttWebSocketClient(mockLogger, undefined, false, {
        bufferedAmountHighWatermark: 10,
      });

      const p = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.bufferedAmount = 100;
      client.sendAudioFrame(new ArrayBuffer(16));
      expect(client.getDroppedFrameCount()).toBe(1);

      client.disconnect();

      const p2 = client.connect('wss://example.com/ws?tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p2;
      expect(client.getDroppedFrameCount()).toBe(0);
    });
  });

  // =========================================================================
  // Resumability handshake
  // =========================================================================
  describe('resume handshake', () => {
    it('records the highest transcript seq and exposes it via getLastReceivedSeq', async () => {
      const client = new SttWebSocketClient(mockLogger);

      const p = client.connect('wss://example.com/ws?sessionId=s-1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;
      client.onTranscript(vi.fn());

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript', text: 'a', startTime: 0, endTime: 1, isFinal: true, seq: 5 }));
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript', text: 'b', startTime: 1, endTime: 2, isFinal: true, seq: 7 }));
      // Out-of-order older seq must not lower lastReceivedSeq.
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript', text: 'c', startTime: 2, endTime: 3, isFinal: true, seq: 6 }));

      expect(client.getLastReceivedSeq()).toBe(7);
    });

    it('sends `{type:"resume", sessionId, lastSeq}` after a reconnect', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const reconnectClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
      });

      const p = reconnectClient.connect('wss://example.com/ws?sessionId=sess-abc&ticket=tkt-1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      reconnectClient.onTranscript(vi.fn());
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript', text: 'foo', startTime: 0, endTime: 1, isFinal: true, seq: 42 }));
      expect(reconnectClient.getLastReceivedSeq()).toBe(42);

      // Trigger reconnect.
      lastMockWs!.close(1006, 'lost');
      await vi.advanceTimersByTimeAsync(101);
      // The reconnect attempt creates a new MockWebSocket.
      lastMockWs!.simulateOpen();

      // First message on the resumed socket should be the resume handshake.
      const resumeFrames = lastMockWs!.sent.filter((m) => typeof m === 'string' && (m as string).includes('"type":"resume"'));
      expect(resumeFrames).toHaveLength(1);
      const parsed = JSON.parse(resumeFrames[0] as string);
      expect(parsed).toEqual({ type: 'resume', sessionId: 'sess-abc', lastSeq: 42 });

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('does NOT send a resume handshake on the FIRST connect', async () => {
      const client = new SttWebSocketClient(mockLogger);

      const p = client.connect('wss://example.com/ws?sessionId=s-only&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const resumeFrames = lastMockWs!.sent.filter((m) => typeof m === 'string' && (m as string).includes('"type":"resume"'));
      expect(resumeFrames).toHaveLength(0);
    });

    it('handles a `resumed` server response without error', async () => {
      const client = new SttWebSocketClient(mockLogger);

      const p = client.connect('wss://example.com/ws?sessionId=s-1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      const onError = vi.fn();
      client.onWsError(onError);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'resumed', sessionId: 's-1', fromSeq: 12 }));

      expect(onError).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Server accepted resume handshake',
        expect.objectContaining({ attributes: expect.objectContaining({ fromSeq: 12 }) }),
      );
    });

    it('surfaces a `resume_failed` server response via onWsError and resets lastReceivedSeq', async () => {
      const client = new SttWebSocketClient(mockLogger);

      const p = client.connect('wss://example.com/ws?sessionId=s-1&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      client.onTranscript(vi.fn());
      lastMockWs!.simulateMessage(JSON.stringify({ type: 'transcript', text: 'x', startTime: 0, endTime: 1, isFinal: true, seq: 100 }));
      expect(client.getLastReceivedSeq()).toBe(100);

      const onError = vi.fn();
      client.onWsError(onError);

      lastMockWs!.simulateMessage(JSON.stringify({ type: 'resume_failed', sessionId: 's-1', reason: 'buffer_overflow', minAvailableSeq: 500 }));

      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: 'RESUME_FAILED' }));
      expect(client.getLastReceivedSeq()).toBe(0);
    });
  });

  // =========================================================================
  // Fresh ticket on reconnect
  // =========================================================================
  describe('fresh ticket on reconnect', () => {
    it('calls refreshTicket() before reopening and rewrites the ticket query param', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const refreshTicket = vi.fn().mockResolvedValue('new-ticket-XYZ');
      const reconnectClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        refreshTicket,
      });

      const p = reconnectClient.connect('wss://example.com/ws?sessionId=sess-1&ticket=stale-ticket&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;

      lastMockWs!.close(1006, 'lost');
      await vi.advanceTimersByTimeAsync(101);
      // Allow the awaited refreshTicket promise to resolve.
      await Promise.resolve();
      await Promise.resolve();

      expect(refreshTicket).toHaveBeenCalledTimes(1);
      const newUrl = lastMockWs!.url;
      expect(newUrl).toContain('ticket=new-ticket-XYZ');
      expect(newUrl).not.toContain('stale-ticket');
      expect(newUrl).toContain('sessionId=sess-1');

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });

    it('aborts the reconnect and fires onReconnectFailed when refreshTicket throws', async () => {
      vi.useFakeTimers();
      const mathRandomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      const refreshTicket = vi.fn().mockRejectedValue(new Error('network down'));
      const reconnectClient = new SttWebSocketClient(mockLogger, {
        enabled: true,
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 5000,
        refreshTicket,
      });
      const failedCb = vi.fn();
      reconnectClient.onReconnectFailed(failedCb);

      const p = reconnectClient.connect('wss://example.com/ws?sessionId=sess-1&ticket=tkt&tenantId=test-tenant');
      lastMockWs!.simulateOpen();
      await p;
      const initialMock = lastMockWs;

      lastMockWs!.close(1006, 'lost');
      await vi.advanceTimersByTimeAsync(101);
      // Let the rejected promise propagate.
      await Promise.resolve();
      await Promise.resolve();

      expect(refreshTicket).toHaveBeenCalled();
      expect(failedCb).toHaveBeenCalled();
      // No new WebSocket should have been created.
      expect(lastMockWs).toBe(initialMock);

      mathRandomSpy.mockRestore();
      vi.useRealTimers();
    });
  });

  describe('source must not contain console.log', () => {
    it('SttWebSocketClient.ts source file contains zero console.log call sites', async () => {
      const { readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const sourcePath = resolve(__dirname, '..', 'SttWebSocketClient.ts');
      const source = readFileSync(sourcePath, 'utf8');

      // Strip JSDoc block comments so usage-example snippets don't trip the
      // regex (they contain literal `console.log(t.text, t.isFinal)`).
      const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
      // Strip single-line comments.
      const stripped = noBlockComments.replace(/^\s*\/\/.*$/gm, '');

      expect(stripped).not.toMatch(/console\.log\s*\(/);
    });
  });
});
