/**
 * SttWsGateway — end-of-stream ordering and superseded-session finalize.
 *
 * - `stop` writes an IN-BAND terminal frame on `stt:audio` (zero-length, `final=1`, the next seq
 *   after the last forwarded frame), so STT reaches it strictly after every frame already sent.
 *   The control `finalize` stays as the fallback.
 * - `stt.session.superseded` finalizes the replaced session through the normal teardown (flush
 *   and upload on STT), never a cancel, and only for the tenant that owns it.
 */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STT_GATEWAY_DEFAULTS } from '@arcaai/applications';
import { SttWsGateway, WS_CLOSE_CODES } from '../stt-ws.gateway';

interface MockSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
}

const createMockSocket = (): MockSocket => ({
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  ping: vi.fn(),
  terminate: vi.fn(),
  readyState: 1,
  OPEN: 1,
  bufferedAmount: 0,
});

const settings = () => ({
  hasSetting: vi.fn((key: string) => key in STT_GATEWAY_DEFAULTS),
  getValueWithDefault: vi.fn(<T,>(key: string, fallback: T) =>
    key in STT_GATEWAY_DEFAULTS ? (STT_GATEWAY_DEFAULTS[key as keyof typeof STT_GATEWAY_DEFAULTS] as unknown as T) : fallback,
  ),
});

const SUPERSEDED_EVENT = 'stt.session.superseded';

describe('SttWsGateway — in-band end of stream and superseded sessions', () => {
  let gateway: SttWsGateway;
  let sessionService: { getSessionStatus: ReturnType<typeof vi.fn>; removeSession: ReturnType<typeof vi.fn> };
  let bridgeService: {
    writeAudioFrame: ReturnType<typeof vi.fn>;
    writeControlCommand: ReturnType<typeof vi.fn>;
    subscribeToResults: ReturnType<typeof vi.fn>;
    unsubscribeFromResults: ReturnType<typeof vi.fn>;
  };
  let removalRetry: { enqueue: ReturnType<typeof vi.fn> };
  /** The binding store behind the double: `clear` really removes, `lookupBinding` really reads. */
  let bindings: Map<string, { tenantId: string; userId: string | null }>;
  let sessionBinding: Record<string, ReturnType<typeof vi.fn>>;

  const buildReq = (sessionId: string) => ({ url: `/ws/stt/stream?sessionId=${sessionId}&ticket=t-${sessionId}` });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});

    sessionService = { getSessionStatus: vi.fn(), removeSession: vi.fn().mockResolvedValue(undefined) };
    bridgeService = {
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
      subscribeToResults: vi.fn(() => new Subject<Record<string, unknown>>().asObservable()),
      unsubscribeFromResults: vi.fn(),
    };
    removalRetry = { enqueue: vi.fn() };
    bindings = new Map();
    sessionBinding = {
      bind: vi.fn().mockResolvedValue(undefined),
      bindSessionMeta: vi.fn().mockResolvedValue(undefined),
      bindMetadataMarks: vi.fn().mockResolvedValue(undefined),
      lookupBinding: vi.fn(async (id: string) => bindings.get(id) ?? null),
      lookupSessionMeta: vi.fn().mockResolvedValue(null),
      lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
      clear: vi.fn(async (id: string) => {
        bindings.delete(id);
      }),
    };
    const streamTicketService = {
      issueTicket: vi.fn(),
      consumeTicket: vi.fn(async (ticket: string) => ({
        userId: 'user-1',
        tenantId: 'tenant-1',
        scope: `stt_session:${ticket.replace(/^t-/, '')}`,
        exp: Date.now() + 30_000,
        impersonatedBy: null,
      })),
    };
    gateway = new SttWsGateway(
      sessionService as never,
      bridgeService as never,
      streamTicketService as never,
      sessionBinding as never,
      removalRetry as never,
      { publishLocalCount: vi.fn().mockResolvedValue(undefined), publishLocalTenantCounts: vi.fn().mockResolvedValue(undefined) } as never,
      undefined,
      settings() as never,
    );
  });

  const connect = async (sessionId: string): Promise<MockSocket> => {
    bindings.set(sessionId, { tenantId: 'tenant-1', userId: 'user-1' });
    const socket = createMockSocket();
    await gateway.handleConnection(socket as never, buildReq(sessionId) as never);
    return socket;
  };

  const sendBinary = (socket: MockSocket, bytes: number[]) => gateway.handleMessage(socket as never, Buffer.from(bytes) as never, true);
  const sendJson = (socket: MockSocket, msg: Record<string, unknown>) => gateway.handleMessage(socket as never, JSON.stringify(msg));

  // -------------------------------------------------------------------------------------------
  // In-band end of stream
  // -------------------------------------------------------------------------------------------
  describe('stop writes an in-band terminal frame', () => {
    it('writes a zero-length final frame with the next seq after the last forwarded frame', async () => {
      const socket = await connect('sess-eos');
      await sendBinary(socket, [1, 2]);
      await sendBinary(socket, [3, 4]);
      await sendBinary(socket, [5, 6]);

      await sendJson(socket, { type: 'stop' });

      const calls = bridgeService.writeAudioFrame.mock.calls;
      expect(calls).toHaveLength(4);
      expect(calls.slice(0, 3).map((c) => [c[1], c[5]])).toEqual([
        [1, false],
        [2, false],
        [3, false],
      ]);
      const [sessionId, seq, data, sampleRate, encoding, isFinal, carrier] = calls[3];
      expect(sessionId).toBe('sess-eos');
      expect(seq).toBe(4);
      expect(Buffer.isBuffer(data) && (data as Buffer).length).toBe(0);
      expect(sampleRate).toBe(16000);
      expect(encoding).toBe('pcm_s16le');
      expect(isFinal).toBe(true);
      // Same session carrier as every audio frame.
      expect(carrier).toBe(calls[0][6]);
    });

    it('is issued after every forwarded frame and before the control finalize, which is kept as fallback', async () => {
      const socket = await connect('sess-order');
      await sendBinary(socket, [1, 2]);
      await sendJson(socket, { type: 'stop' });

      expect(bridgeService.writeControlCommand).toHaveBeenCalledWith('sess-order', 'finalize');
      expect(bridgeService.writeAudioFrame.mock.calls.map((c) => c[5])).toEqual([false, true]);
      const audioOrder = bridgeService.writeAudioFrame.mock.invocationCallOrder;
      const finalOrder = audioOrder[audioOrder.length - 1];
      expect(Math.max(...audioOrder.slice(0, -1))).toBeLessThan(finalOrder);
      expect(finalOrder).toBeLessThan(bridgeService.writeControlCommand.mock.invocationCallOrder[0]);
    });

    it('continues past an explicit JSON seq so the terminal frame is never at or below a forwarded seq', async () => {
      const socket = await connect('sess-json-seq');
      await sendJson(socket, { type: 'audio', seq: 7, data: Buffer.from([1, 2]).toString('base64') });

      await sendJson(socket, { type: 'stop' });

      const last = bridgeService.writeAudioFrame.mock.calls.at(-1);
      expect(last?.[1]).toBe(8);
      expect(last?.[5]).toBe(true);
    });

    it('writes the terminal frame once even if the client sends stop twice', async () => {
      const socket = await connect('sess-twice');
      await sendBinary(socket, [1, 2]);
      await sendJson(socket, { type: 'stop' });
      await sendJson(socket, { type: 'stop' });

      const finals = bridgeService.writeAudioFrame.mock.calls.filter((c) => c[5] === true);
      expect(finals).toHaveLength(1);
    });

    it('still sends the control finalize when the terminal frame write fails or hangs', async () => {
      const socket = await connect('sess-eos-fail');
      await sendBinary(socket, [1, 2]);
      bridgeService.writeAudioFrame.mockReturnValueOnce(new Promise(() => {}));

      await sendJson(socket, { type: 'stop' });
      expect(bridgeService.writeControlCommand).toHaveBeenCalledWith('sess-eos-fail', 'finalize');

      const socket2 = await connect('sess-eos-reject');
      bridgeService.writeAudioFrame.mockRejectedValueOnce(new Error('redis down'));
      await sendJson(socket2, { type: 'stop' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(bridgeService.writeControlCommand).toHaveBeenCalledWith('sess-eos-reject', 'finalize');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Superseded session (contract C-1)
  // -------------------------------------------------------------------------------------------
  describe('stt.session.superseded', () => {
    const payload = (over: Partial<Record<string, string>> = {}) => ({
      tenantId: 'tenant-1',
      consultationId: 'consult-1',
      supersededSessionId: 'sess-old',
      supersedingSessionId: 'sess-new',
      ...over,
    });

    it('is registered as a listener for the event name', () => {
      const listeners = Reflect.getMetadata('EVENT_LISTENER_METADATA', SttWsGateway.prototype.onSttSessionSuperseded) as Array<{ event: string }>;
      expect(listeners.map((l) => l.event)).toContain(SUPERSEDED_EVENT);
    });

    it('finalizes an in-memory session through the normal teardown and closes its socket as superseded', async () => {
      const socket = await connect('sess-old');

      await gateway.onSttSessionSuperseded(payload());

      expect(sessionService.removeSession).toHaveBeenCalledTimes(1);
      // A superseded session is not a clinician stop, so the ledger row says interrupted.
      expect(sessionService.removeSession).toHaveBeenCalledWith('sess-old', true, 'tenant-1');
      expect(bridgeService.unsubscribeFromResults).toHaveBeenCalledWith('sess-old');
      expect(socket.close).toHaveBeenCalledWith(WS_CLOSE_CODES.SESSION_SUPERSEDED, expect.any(String));
      expect(gateway.getActiveSessionCount()).toBe(0);
      // Never a cancel.
      expect(bridgeService.writeControlCommand).not.toHaveBeenCalledWith('sess-old', 'cancel');
    });

    it('asks STT to finalize a session this instance does not hold, once, for its own tenant', async () => {
      bindings.set('sess-elsewhere', { tenantId: 'tenant-1', userId: 'user-1' });

      await gateway.onSttSessionSuperseded(payload({ supersededSessionId: 'sess-elsewhere' }));

      expect(sessionService.removeSession).toHaveBeenCalledTimes(1);
      expect(sessionService.removeSession).toHaveBeenCalledWith('sess-elsewhere', true, 'tenant-1');
      expect(bindings.has('sess-elsewhere')).toBe(false);
    });

    it('parks a failed removal for retry instead of leaking the STT session', async () => {
      bindings.set('sess-flaky', { tenantId: 'tenant-1', userId: 'user-1' });
      sessionService.removeSession.mockRejectedValueOnce(new Error('stt down'));

      await gateway.onSttSessionSuperseded(payload({ supersededSessionId: 'sess-flaky' }));

      expect(removalRetry.enqueue).toHaveBeenCalledWith('sess-flaky', true, 'tenant-1');
    });

    it('ignores a payload whose tenant does not own the in-memory session', async () => {
      const socket = await connect('sess-old');
      const warn = vi.mocked(Logger.prototype.warn);
      warn.mockClear();

      await gateway.onSttSessionSuperseded(payload({ tenantId: 'tenant-2' }));

      expect(sessionService.removeSession).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
      expect(gateway.getActiveSessionCount()).toBe(1);
      expect(warn).toHaveBeenCalled();
    });

    it('ignores a payload whose tenant does not own a session held elsewhere', async () => {
      bindings.set('sess-foreign', { tenantId: 'tenant-1', userId: 'user-1' });

      await gateway.onSttSessionSuperseded(payload({ tenantId: 'tenant-2', supersededSessionId: 'sess-foreign' }));

      expect(sessionService.removeSession).not.toHaveBeenCalled();
      expect(bindings.has('sess-foreign')).toBe(true);
    });

    it('a second event for the same session is a no-op', async () => {
      await connect('sess-old');

      await gateway.onSttSessionSuperseded(payload());
      await gateway.onSttSessionSuperseded(payload());

      expect(sessionService.removeSession).toHaveBeenCalledTimes(1);
    });

    it('a second event for a session held elsewhere is a no-op', async () => {
      bindings.set('sess-elsewhere', { tenantId: 'tenant-1', userId: 'user-1' });

      await gateway.onSttSessionSuperseded(payload({ supersededSessionId: 'sess-elsewhere' }));
      await gateway.onSttSessionSuperseded(payload({ supersededSessionId: 'sess-elsewhere' }));

      expect(sessionService.removeSession).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the superseding session is the same session', async () => {
      await connect('sess-old');

      await gateway.onSttSessionSuperseded(payload({ supersedingSessionId: 'sess-old' }));

      expect(sessionService.removeSession).not.toHaveBeenCalled();
      expect(gateway.getActiveSessionCount()).toBe(1);
    });
  });
});
