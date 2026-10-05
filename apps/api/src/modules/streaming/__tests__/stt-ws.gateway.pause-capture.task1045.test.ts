/**
 * SttWsGateway — capture pause/resume control.
 *
 * Client `pause` / `resume-capture` become STT control `pause` / `resume`; while paused the gateway
 * drops inbound audio without advancing its seq or audio clock; STT status frames are relayed
 * unchanged; an STT error answering the control maps to PAUSE_UNSUPPORTED. The reconnect
 * `resume` handshake is a different message and is untouched.
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


describe('SttWsGateway — capture pause/resume', () => {
  let gateway: SttWsGateway;
  let sessionService: { getSessionStatus: ReturnType<typeof vi.fn>; removeSession: ReturnType<typeof vi.fn> };
  let bridgeService: {
    writeAudioFrame: ReturnType<typeof vi.fn>;
    writeControlCommand: ReturnType<typeof vi.fn>;
    subscribeToResults: ReturnType<typeof vi.fn>;
    unsubscribeFromResults: ReturnType<typeof vi.fn>;
  };
  let results: Subject<Record<string, unknown>>;
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
    results = new Subject<Record<string, unknown>>();
    bridgeService = {
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
      subscribeToResults: vi.fn(() => results.asObservable()),
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

  const sent = (socket: MockSocket) => socket.send.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);

  it('forwards pause as a control command and drops audio while paused without advancing the clock', async () => {
    const socket = await connect('sess-pause');
    await sendBinary(socket, [1, 2]);
    await sendJson(socket, { type: 'pause' });
    expect(bridgeService.writeControlCommand).toHaveBeenCalledWith('sess-pause', 'pause');

    await sendBinary(socket, [3, 4]);
    await sendJson(socket, { type: 'audio', seq: 9, data: Buffer.from([5, 6]).toString('base64') });
    expect(bridgeService.writeAudioFrame).toHaveBeenCalledTimes(1);

    await sendJson(socket, { type: 'resume-capture' });
    expect(bridgeService.writeControlCommand).toHaveBeenCalledWith('sess-pause', 'resume');
    await sendBinary(socket, [7, 8]);
    const calls = bridgeService.writeAudioFrame.mock.calls;
    expect(calls).toHaveLength(2);
    // Seq continues from the last forwarded frame: nothing advanced while paused.
    expect(calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it('is idempotent: a repeated pause or resume-capture is harmless and never errors', async () => {
    const socket = await connect('sess-idem');
    await sendJson(socket, { type: 'pause' });
    await sendJson(socket, { type: 'pause' });
    await sendJson(socket, { type: 'resume-capture' });
    await sendJson(socket, { type: 'resume-capture' });
    expect(sent(socket).filter((m) => m.type === 'error')).toEqual([]);
    await sendBinary(socket, [1, 2]);
    expect(bridgeService.writeAudioFrame).toHaveBeenCalledTimes(1);
  });

  it('relays paused, capturing and pause_expired status frames unchanged', async () => {
    const socket = await connect('sess-status');
    for (const frame of [
      { type: 'status', status: 'paused', sessionId: 'sess-status', audioOffsetMs: 1234 },
      { type: 'status', status: 'capturing', sessionId: 'sess-status', audioOffsetMs: 1234 },
      { type: 'status', status: 'pause_expired', sessionId: 'sess-status' },
    ]) {
      results.next(frame);
    }
    const statuses = sent(socket).filter((m) => m.type === 'status' && m.status !== 'ready');
    expect(statuses).toEqual([
      { type: 'status', status: 'paused', sessionId: 'sess-status', audioOffsetMs: 1234 },
      { type: 'status', status: 'capturing', sessionId: 'sess-status', audioOffsetMs: 1234 },
      { type: 'status', status: 'pause_expired', sessionId: 'sess-status' },
    ]);
  });

  it('maps an STT error answering the control to PAUSE_UNSUPPORTED and keeps capturing', async () => {
    const socket = await connect('sess-old-stt');
    await sendJson(socket, { type: 'pause' });
    results.next({ type: 'error', message: "Control action 'pause' is not supported by the streaming backend" });

    expect(sent(socket)).toContainEqual(expect.objectContaining({ type: 'error', code: 'PAUSE_UNSUPPORTED' }));
    await sendBinary(socket, [1, 2]);
    expect(bridgeService.writeAudioFrame).toHaveBeenCalledTimes(1);
  });

  it('does not map an unrelated STT error when no capture control is pending', async () => {
    const socket = await connect('sess-other-error');
    results.next({ type: 'error', message: 'boom' });
    expect(sent(socket).some((m) => m.code === 'PAUSE_UNSUPPORTED')).toBe(false);
  });

  it('leaves the reconnect resume handshake untouched', async () => {
    const socket = await connect('sess-handshake');
    await sendJson(socket, { type: 'pause' });
    bridgeService.writeControlCommand.mockClear();
    await sendJson(socket, { type: 'resume', sessionId: 'sess-handshake', lastSeq: 0 });
    expect(bridgeService.writeControlCommand).not.toHaveBeenCalled();
    // And the handshake does not clear the capture pause.
    await sendBinary(socket, [1, 2]);
    expect(bridgeService.writeAudioFrame).not.toHaveBeenCalled();
  });
});
