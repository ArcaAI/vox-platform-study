/**
 * TASK-951 R2 (D-8) — the WS gateway's half of the STT session context echo.
 *
 * The bridge attaches the echo (see `session-context-echo.task951.test.ts` in `@arcaai/applications`);
 * this side decides WHAT it is handed, and when. Three properties are load-bearing and none of
 * them is visible from the bridge:
 *
 *  1. **Read once, at attach.** The gateway already reads the session meta record exactly once
 *     during the handshake, for the negotiated `sampleRate`. The context and the session epoch
 *     ride on that SAME read. A per-transcript lookup would add a Redis round trip to every
 *     utterance of every session to re-learn a value that cannot change.
 *  2. **A resumed session keeps echoing.** A grace-window reconnect tears down the caption reader
 *     and re-establishes it; if the echo lived only in the subscribe call and not on the session,
 *     a client that dropped for two seconds would silently lose its mic labels for the rest of
 *     the consultation — the worst kind of failure, because the transcripts keep arriving.
 *  3. **Nothing changes for a session without a context.** The subscribe call must be byte-identical
 *     to the pre-ticket one, so no existing session pays for a feature it did not ask for.
 *
 * `ready` additionally carries the epoch, because a caller aligning several per-microphone
 * sessions needs the clock BEFORE the first utterance — and `ready` is a control frame, sent once.
 */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttWsGateway, WS_RESULT_CONSUMER_GROUP } from '../stt-ws.gateway';

/* eslint-disable @typescript-eslint/no-explicit-any */

const STREAM_CONTEXT = { stream: { mic_id: 'mic-2', speaker_label: 'Patient' } };
const SESSION_EPOCH_MS = 1_757_000_000_000;

const createMockSocket = () => ({ send: vi.fn(), close: vi.fn(), on: vi.fn(), readyState: 1, OPEN: 1 });

const buildReq = (sessionId: string) => ({ url: `/ws/stt/stream?sessionId=${sessionId}&ticket=valid-ticket` });

const createMockBridgeService = () => ({
  connect: vi.fn(),
  writeAudioFrame: vi.fn().mockResolvedValue(undefined),
  writeControlCommand: vi.fn().mockResolvedValue(undefined),
  subscribeToResults: vi.fn().mockReturnValue(new Subject().asObservable()),
  unsubscribeFromResults: vi.fn(),
});

const createMockSessionBinding = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  bindSessionMeta: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn().mockResolvedValue('tenant-abc'),
  lookupBinding: vi.fn().mockResolvedValue({ tenantId: 'tenant-abc', userId: 'user-123' }),
  // Default: NO meta record at all — the pre-TASK-951 world, and the baseline every
  // "nothing changed" assertion below is measured against.
  lookupSessionMeta: vi.fn().mockResolvedValue(null),
  // TASK-951 lane E2 reads the metadata marks in the SAME Promise.all as the meta; a mock without it
  // throws inside the handshake and silently drops the echo — exactly the failure this file then reports.
  lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
  bindMetadataMarks: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
});

const createMockStreamTicketService = () => ({
  issueTicket: vi.fn(),
  // A scope no session id matches: every case installs its own via `ticketFor`, so a missing
  // one fails loudly rather than connecting to the wrong session.
  consumeTicket: vi.fn().mockResolvedValue({
    userId: 'user-123',
    tenantId: 'tenant-abc',
    scope: 'stt_session:__none__',
    exp: Date.now() + 30_000,
    impersonatedBy: null,
  }),
});

/** Every JSON frame the gateway pushed to this socket, parsed. */
const framesOn = (client: ReturnType<typeof createMockSocket>) => client.send.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));

/**
 * AMENDED BY LANE E2 (TASK-951 R2, clarified) — the three "subscribes exactly as before"
 * assertions below now read `noEchoedContext`, not a whole-object equality.
 *
 * `sessionEcho` is installed on EVERY session since the per-span metadata timeline landed,
 * because a session that declared no `context` may still send `{type:'metadata'}` frames — the
 * two are independent client choices, and the accessor has to be in place before the first one
 * arrives. What lane E was protecting is untouched and is what these assertions now state
 * directly: such a session echoes NO context and NO epoch, so its transcript wire is still
 * byte-identical (the bridge spreads `context` only when there is one, and `metadata` only when
 * the clipped span list is non-empty).
 */
const noEchoedContext = (sessionId: string, bridge: { subscribeToResults: { mock: { calls: unknown[][] } } }) => {
  const call = bridge.subscribeToResults.mock.calls.find(([id]) => id === sessionId);
  expect(call, `subscribeToResults was never called for ${sessionId}`).toBeDefined();
  const options = call![1] as { consumerGroup?: string; sessionEcho?: { context?: unknown; sessionEpochMs?: unknown } };
  expect(options.consumerGroup).toBe(WS_RESULT_CONSUMER_GROUP);
  expect(options.sessionEcho?.context).toBeUndefined();
  expect(options.sessionEcho?.sessionEpochMs).toBeUndefined();
};

describe('TASK-951 — SttWsGateway stream-context echo', () => {
  let gateway: SttWsGateway;
  let bridgeService: ReturnType<typeof createMockBridgeService>;
  let sessionBinding: ReturnType<typeof createMockSessionBinding>;
  let streamTicketService: ReturnType<typeof createMockStreamTicketService>;

  beforeEach(() => {
    vi.clearAllMocks();

    bridgeService = createMockBridgeService();
    sessionBinding = createMockSessionBinding();
    streamTicketService = createMockStreamTicketService();

    gateway = new SttWsGateway(
      { getSessionStatus: vi.fn(), removeSession: vi.fn().mockResolvedValue(undefined) } as any,
      bridgeService as any,
      streamTicketService as any,
      sessionBinding as any,
      { enqueue: vi.fn() } as any,
    );

    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  /** Point the one-shot ticket at a specific session so the handshake's scope check passes. */
  const ticketFor = (sessionId: string) =>
    streamTicketService.consumeTicket.mockResolvedValueOnce({
      userId: 'user-123',
      tenantId: 'tenant-abc',
      scope: `stt_session:${sessionId}`,
      exp: Date.now() + 30_000,
      impersonatedBy: null,
    });

  it('hands the bound context + epoch to the caption reader, from the ONE meta read at handshake', async () => {
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000, context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS });
    ticketFor('sess-echo');

    await gateway.handleConnection(createMockSocket() as any, buildReq('sess-echo') as any);

    expect(sessionBinding.lookupSessionMeta).toHaveBeenCalledTimes(1);
    expect(bridgeService.subscribeToResults).toHaveBeenCalledWith('sess-echo', {
      consumerGroup: WS_RESULT_CONSUMER_GROUP,
      sessionEcho: { context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS, metadataSpans: expect.any(Function) },
    });
  });

  it('the `ready` ack carries the session epoch, so a client can align before the first transcript', async () => {
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000, context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS });
    ticketFor('sess-ready');
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-ready') as any);

    const ready = framesOn(client).find((f) => f.type === 'ready');
    expect(ready).toBeDefined();
    expect(ready.sessionEpochMs).toBe(SESSION_EPOCH_MS);
    // The pre-existing readiness contract is untouched.
    expect(ready.sessionId).toBe('sess-ready');
    expect(ready.fromSeq).toBe(1);
  });

  it('a session with NO bound context subscribes exactly as it did before this ticket', async () => {
    // Default mock: `lookupSessionMeta` → null (no meta record at all).
    ticketFor('sess-plain');
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-plain') as any);

    noEchoedContext('sess-plain', bridgeService);
    const ready = framesOn(client).find((f) => f.type === 'ready');
    expect(ready.sessionEpochMs).toBeUndefined();
  });

  it('an epoch with no context subscribes plainly too — the transcript pair is opt-in', async () => {
    // A session created before a client started sending `context`: the epoch is recorded (every
    // session gets one) but there is nothing to echo, so the transcript wire must not change.
    // `ready` still advertises the clock, which costs one field on one control frame.
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000, sessionEpochMs: SESSION_EPOCH_MS });
    ticketFor('sess-epoch-only');
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-epoch-only') as any);

    noEchoedContext('sess-epoch-only', bridgeService);
    expect(framesOn(client).find((f) => f.type === 'ready').sessionEpochMs).toBe(SESSION_EPOCH_MS);
  });

  it('a grace-window RECONNECT keeps echoing — the session, not the subscribe call, owns the echo', async () => {
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000, context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS });
    ticketFor('sess-resume');
    const first = createMockSocket();
    await gateway.handleConnection(first as any, buildReq('sess-resume') as any);

    // Transient drop, then a reconnect INSIDE the grace window: `rebindSession` re-establishes the
    // caption reader against the SessionInfo it kept — it never re-reads the meta record, which is
    // exactly why the echo has to live on the session.
    gateway.handleDisconnect(first as any);
    ticketFor('sess-resume');
    const second = createMockSocket();
    await gateway.handleConnection(second as any, buildReq('sess-resume') as any);

    expect(sessionBinding.lookupSessionMeta).toHaveBeenCalledTimes(2);
    expect(bridgeService.subscribeToResults).toHaveBeenCalledTimes(2);
    expect(bridgeService.subscribeToResults).toHaveBeenLastCalledWith('sess-resume', {
      consumerGroup: WS_RESULT_CONSUMER_GROUP,
      sessionEcho: { context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS, metadataSpans: expect.any(Function) },
    });
    expect(framesOn(second).find((f) => f.type === 'ready').sessionEpochMs).toBe(SESSION_EPOCH_MS);
  });

  it('a meta-read failure degrades to no echo rather than refusing the handshake', async () => {
    // The echo is a display/attribution aid. A Redis blip must not cost a clinician their live
    // transcription — the same posture the sampleRate fallback already takes.
    sessionBinding.lookupSessionMeta.mockRejectedValueOnce(new Error('redis blip'));
    ticketFor('sess-blip');
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-blip') as any);

    expect(client.close).not.toHaveBeenCalled();
    noEchoedContext('sess-blip', bridgeService);
  });
});
