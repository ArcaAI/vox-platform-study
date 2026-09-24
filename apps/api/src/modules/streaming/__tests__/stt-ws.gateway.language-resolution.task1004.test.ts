/**
 * TASK-1004 — the language RECEIPT on the client-facing socket.
 *
 *  - `ready` carries the receipt the session was CREATED with, read off the same one meta record
 *    the handshake already reads (no extra round trip), so a socket-only consumer sees it;
 *  - a `provider_switched` status relays the re-resolved receipt (projected by the bridge), and
 *    the gateway keeps it as the session's CURRENT receipt, so a grace-window reconnect's `ready`
 *    reports what is serving now rather than what served at create.
 */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttWsGateway } from '../stt-ws.gateway';

/* eslint-disable @typescript-eslint/no-explicit-any */

const AT_CREATE = {
  requestedMode: 'ml-en',
  source: 'consultation',
  appliedMode: 'ml-en',
  engine: 'WHISPER_CPP',
  provider: null,
  params: { language: null, codeSwitching: false, streamingEnglishGloss: false, primed: false },
  degraded: true,
  reason: 'whisper_cpp_pair_unprimed',
};
const AFTER_SWITCH = {
  ...AT_CREATE,
  engine: 'SARVAM',
  provider: 'sarvam',
  params: { language: 'ml', codeSwitching: true, streamingEnglishGloss: false, primed: false },
  degraded: false,
  reason: null,
};

const createMockSocket = () => ({ send: vi.fn(), close: vi.fn(), on: vi.fn(), readyState: 1, OPEN: 1 });
const buildReq = (sessionId: string) => ({ url: `/ws/stt/stream?sessionId=${sessionId}&ticket=valid-ticket` });
const framesOn = (client: ReturnType<typeof createMockSocket>) => client.send.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));

describe('TASK-1004 — SttWsGateway language receipt', () => {
  let gateway: SttWsGateway;
  let results: Subject<unknown>;
  let sessionBinding: any;
  let streamTicketService: any;

  beforeEach(() => {
    vi.clearAllMocks();
    results = new Subject();
    sessionBinding = {
      bind: vi.fn(),
      bindSessionMeta: vi.fn(),
      lookup: vi.fn().mockResolvedValue('tenant-abc'),
      lookupBinding: vi.fn().mockResolvedValue({ tenantId: 'tenant-abc', userId: 'user-123' }),
      lookupSessionMeta: vi.fn().mockResolvedValue({ sampleRate: 16000, languageResolution: AT_CREATE }),
      lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
      bindMetadataMarks: vi.fn(),
      clear: vi.fn(),
    };
    streamTicketService = {
      issueTicket: vi.fn(),
      consumeTicket: vi.fn(async () => ({
        userId: 'user-123',
        tenantId: 'tenant-abc',
        scope: 'stt_session:sess-1',
        exp: Date.now() + 30_000,
        impersonatedBy: null,
      })),
    };
    gateway = new SttWsGateway(
      { getSessionStatus: vi.fn(), removeSession: vi.fn().mockResolvedValue(undefined) } as any,
      {
        connect: vi.fn(),
        writeAudioFrame: vi.fn().mockResolvedValue(undefined),
        writeControlCommand: vi.fn().mockResolvedValue(undefined),
        subscribeToResults: vi.fn().mockReturnValue(results.asObservable()),
        unsubscribeFromResults: vi.fn(),
      } as any,
      streamTicketService,
      sessionBinding,
      { enqueue: vi.fn() } as any,
    );
    for (const level of ['log', 'warn', 'error', 'debug'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => {});
  });

  it('`ready` carries the create-time receipt from the one meta read', async () => {
    const client = createMockSocket();
    await gateway.handleConnection(client as any, buildReq('sess-1') as any);

    expect(sessionBinding.lookupSessionMeta).toHaveBeenCalledTimes(1);
    const ready = framesOn(client).find((f) => f.type === 'ready');
    expect(ready.languageResolution).toEqual(AT_CREATE);
  });

  it('a session whose meta carries no receipt sends `ready` without the key (older sessions unchanged)', async () => {
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000 });
    const client = createMockSocket();
    await gateway.handleConnection(client as any, buildReq('sess-1') as any);

    expect(framesOn(client).find((f) => f.type === 'ready')).not.toHaveProperty('languageResolution');
  });

  it('a provider_switched receipt is relayed AND becomes the receipt a reconnect’s `ready` reports', async () => {
    const first = createMockSocket();
    await gateway.handleConnection(first as any, buildReq('sess-1') as any);

    results.next({ type: 'status', status: 'provider_switched', active: 'fallback', is_fallback: true, languageResolution: AFTER_SWITCH });
    const relayed = framesOn(first).find((f) => f.type === 'status' && f.status === 'provider_switched');
    expect(relayed.languageResolution).toEqual(AFTER_SWITCH);

    // grace-window reconnect onto the same gateway instance
    await (gateway as any).handleDisconnect(first);
    const second = createMockSocket();
    await gateway.handleConnection(second as any, buildReq('sess-1') as any);

    const ready = framesOn(second).find((f) => f.type === 'ready');
    expect(ready.languageResolution).toEqual(AFTER_SWITCH);
  });
});
