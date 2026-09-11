/**
 * TASK-951 R2 (clarified 2026-09-11) — the gateway's half of per-span stream metadata.
 *
 * The timeline arithmetic is pinned next door in `@arcaai/applications`
 * (`stream-metadata-timeline.task951.test.ts`). What CANNOT be seen from there, and is what
 * this file is for, is everything the gateway decides:
 *
 *  1. **The clock.** Spans are placed at `bytesForwarded / (sampleRate * 2)` — the gateway's
 *     own count of the audio it has forwarded, which is the same quantity `apps/stt` derives a
 *     segment's `start_time`/`end_time` from (`preprocessor.py`: `total_samples_fed /
 *     target_sr`). It must advance on BOTH frame kinds, at the session's NEGOTIATED sample
 *     rate, and must never rewind across a reconnect.
 *  2. **The two refusals, without killing the session.** Oversized and schema-violating frames
 *     are answered on the error channel and IGNORED. Closing a live consultation's socket over
 *     a malformed label would turn an attribution problem into a clinical one.
 *  3. **The accessor, not a snapshot.** The bridge is handed a function called per transcript,
 *     so a microphone that opens mid-session is reflected on the segments it actually affected
 *     — a value captured at subscribe time would stamp the whole consultation with whatever was
 *     in force at attach, which is the exact failure this ticket exists to fix.
 *  4. **Rebuild on a cross-instance reconnect**, spans AND clock together: spans rebuilt onto a
 *     clock that restarted at zero would place every later declaration before the ones already
 *     recorded.
 */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttWsGateway, WS_RESULT_CONSUMER_GROUP } from '../stt-ws.gateway';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ONE_MIC = { micIds: ['mic-1'] };
const TWO_MICS = { micIds: ['mic-1', 'mic-2'] };

/** The `fields` of a `streamContext` kind: `micIds` is a required array of strings. */
const METADATA_SCHEMA = {
  type: 'object',
  properties: { micIds: { type: 'array', items: { type: 'string' } } },
  required: ['micIds'],
};

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
  bindMetadataMarks: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn().mockResolvedValue('tenant-abc'),
  lookupBinding: vi.fn().mockResolvedValue({ tenantId: 'tenant-abc', userId: 'user-123' }),
  lookupSessionMeta: vi.fn().mockResolvedValue({ sampleRate: 16000 }),
  lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
  clear: vi.fn().mockResolvedValue(undefined),
});

const createMockStreamTicketService = () => ({
  issueTicket: vi.fn(),
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

/** The live span accessor the gateway installed for `sessionId`. */
const accessorFor = (bridge: ReturnType<typeof createMockBridgeService>, sessionId: string) => {
  // The LAST subscribe for this session (a rebind re-subscribes). `findLast` needs lib es2023; the api targets ES2022.
  const call = [...bridge.subscribeToResults.mock.calls].reverse().find((entry: unknown[]) => entry[0] === sessionId);
  expect(call, `subscribeToResults was never called for ${sessionId}`).toBeDefined();
  const spans = (call![1] as { sessionEcho?: { metadataSpans?: (s: number, e: number) => unknown } }).sessionEcho?.metadataSpans;
  expect(spans, 'the gateway must install a live metadata-span accessor').toBeTypeOf('function');
  return spans!;
};

/** One second of 16 kHz PCM16 mono. The clock's unit, made explicit. */
const oneSecond = () => Buffer.alloc(32_000);

describe('TASK-951 — SttWsGateway per-span metadata', () => {
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

  const ticketFor = (sessionId: string) =>
    streamTicketService.consumeTicket.mockResolvedValueOnce({
      userId: 'user-123',
      tenantId: 'tenant-abc',
      scope: `stt_session:${sessionId}`,
      exp: Date.now() + 30_000,
      impersonatedBy: null,
    });

  /** Connect a session and hand back its socket. */
  const connect = async (sessionId: string) => {
    ticketFor(sessionId);
    const client = createMockSocket();
    await gateway.handleConnection(client as any, buildReq(sessionId) as any);
    return client;
  };

  const sendJson = async (client: ReturnType<typeof createMockSocket>, payload: unknown) =>
    gateway.handleMessage(client as any, JSON.stringify(payload), false);

  const sendPcm = async (client: ReturnType<typeof createMockSocket>, buffer: Buffer) => gateway.handleMessage(client as any, buffer, true);

  // ── 1. The frame ──────────────────────────────────────────────────────────

  it('records a metadata frame and reports it on a transcript that overlaps it', async () => {
    const client = await connect('sess-basic');

    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(client, oneSecond());

    expect(accessorFor(bridgeService, 'sess-basic')(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
    // A declaration is NOT an error, and must not be answered as one.
    expect(framesOn(client).some((f) => f.type === 'error')).toBe(false);
  });

  it('a mid-utterance change is reported as TWO spans on that utterance', async () => {
    // The whole point of the ticket: one, two or more microphones, changing WHILE recording,
    // and the platform returns exactly which was in force over which part of the audio.
    const client = await connect('sess-change');

    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(client, oneSecond());
    await sendPcm(client, oneSecond());
    await sendJson(client, { type: 'metadata', metadata: TWO_MICS });
    await sendPcm(client, oneSecond());

    expect(accessorFor(bridgeService, 'sess-change')(1, 3)).toEqual([
      { from: 1, to: 2, value: ONE_MIC },
      { from: 2, to: 3, value: TWO_MICS },
    ]);
  });

  it('accepts metadata on a JSON audio frame, applying it BEFORE that frame advances the clock', async () => {
    // The value describes the audio in THIS frame, so it has to take effect at the offset
    // before these bytes are counted — otherwise the frame it labels is the one span it misses.
    const client = await connect('sess-inline');

    await sendJson(client, { type: 'audio', seq: 1, data: oneSecond().toString('base64'), metadata: ONE_MIC });

    expect(accessorFor(bridgeService, 'sess-inline')(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
    expect(bridgeService.writeAudioFrame).toHaveBeenCalledTimes(1);
  });

  it('re-stating the value already in force changes nothing and rewrites nothing', async () => {
    // A broker re-declaring its mic set every few seconds over a lossy link is normal. It must
    // not grow the span list, and must not cost a Redis write per repeat.
    const client = await connect('sess-coalesce');

    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(client, oneSecond());
    await sendJson(client, { type: 'metadata', metadata: { micIds: ['mic-1'] } });
    await sendPcm(client, oneSecond());

    expect(accessorFor(bridgeService, 'sess-coalesce')(0, 2)).toEqual([{ from: 0, to: 2, value: ONE_MIC }]);
    expect(sessionBinding.bindMetadataMarks).toHaveBeenCalledTimes(1);
  });

  // ── 2. The clock ──────────────────────────────────────────────────────────

  it('advances the clock on BINARY frames', async () => {
    const client = await connect('sess-binary');

    await sendPcm(client, oneSecond());
    await sendPcm(client, oneSecond());
    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });

    expect(accessorFor(bridgeService, 'sess-binary')(0, 3)).toEqual([{ from: 2, to: 3, value: ONE_MIC }]);
  });

  it('advances the clock on JSON audio frames too', async () => {
    // Two frame kinds, one counter. A client that sends base64 audio must get the same
    // timeline as one that sends binary — the wire encoding is not a semantic choice.
    const client = await connect('sess-json-clock');

    await sendJson(client, { type: 'audio', seq: 1, data: oneSecond().toString('base64') });
    await sendJson(client, { type: 'audio', seq: 2, data: oneSecond().toString('base64') });
    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });

    expect(accessorFor(bridgeService, 'sess-json-clock')(0, 3)).toEqual([{ from: 2, to: 3, value: ONE_MIC }]);
  });

  it('uses the session’s NEGOTIATED sample rate, not a hardcoded 16000', async () => {
    // The same bytes are half as many seconds at 32 kHz. Reading the rate off the meta record
    // is what keeps the gateway's clock and the ASR's sample count the same quantity.
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 32_000 });
    const client = await connect('sess-32k');

    await sendPcm(client, oneSecond());
    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });

    expect(accessorFor(bridgeService, 'sess-32k')(0, 1)).toEqual([{ from: 0.5, to: 1, value: ONE_MIC }]);
  });

  it('does NOT rewind the clock across a grace-window reconnect', async () => {
    // A resume continues ONE audio timeline. A clock that restarted would place every later
    // declaration on top of the spans already recorded.
    const first = await connect('sess-rebind');
    await sendPcm(first, oneSecond());
    await sendPcm(first, oneSecond());

    gateway.handleDisconnect(first as any);
    const second = await connect('sess-rebind');
    await sendJson(second, { type: 'metadata', metadata: ONE_MIC });

    expect(accessorFor(bridgeService, 'sess-rebind')(0, 3)).toEqual([{ from: 2, to: 3, value: ONE_MIC }]);
  });

  // ── 3. The refusals ───────────────────────────────────────────────────────

  it('refuses an oversized object with METADATA_TOO_LARGE and keeps the session up', async () => {
    const client = await connect('sess-too-large');
    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(client, oneSecond());

    await sendJson(client, { type: 'metadata', metadata: { micIds: ['mic-1'], note: 'x'.repeat(2048) } });

    const error = framesOn(client).find((f) => f.type === 'error');
    expect(error?.code).toBe('METADATA_TOO_LARGE');
    expect(client.close).not.toHaveBeenCalled();
    // IGNORED, not partially applied: the previous declaration stays in force.
    expect(accessorFor(bridgeService, 'sess-too-large')(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
  });

  it('refuses a schema violation with METADATA_SCHEMA_VIOLATION and the problems that caused it', async () => {
    // A client cannot fix a shape it is not shown, so the refusal carries `problems`.
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000, metadataSchema: METADATA_SCHEMA });
    const client = await connect('sess-violation');

    await sendJson(client, { type: 'metadata', metadata: { micIds: 'mic-1' } });

    const error = framesOn(client).find((f) => f.type === 'error');
    expect(error?.code).toBe('METADATA_SCHEMA_VIOLATION');
    expect(Array.isArray(error?.problems)).toBe(true);
    expect(error.problems.length).toBeGreaterThan(0);
    expect(client.close).not.toHaveBeenCalled();
    expect(accessorFor(bridgeService, 'sess-violation')(0, 1)).toEqual([]);
  });

  it('accepts an object that DOES satisfy the bound schema', async () => {
    sessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 16000, metadataSchema: METADATA_SCHEMA });
    const client = await connect('sess-conforms');

    await sendJson(client, { type: 'metadata', metadata: TWO_MICS });
    await sendPcm(client, oneSecond());

    expect(framesOn(client).some((f) => f.type === 'error')).toBe(false);
    expect(accessorFor(bridgeService, 'sess-conforms')(0, 1)).toEqual([{ from: 0, to: 1, value: TWO_MICS }]);
  });

  it('accepts ANY object when the session’s agent binds no stream-identity kind', async () => {
    // Absent schema means "this tenant has no opinion about how a client labels its audio" —
    // never "reject everything", which is the same reading the sibling HTTP gate gives an
    // agent with no bound context schema at all.
    const client = await connect('sess-no-schema');

    await sendJson(client, { type: 'metadata', metadata: { anythingAtAll: { nested: true } } });
    await sendPcm(client, oneSecond());

    expect(framesOn(client).some((f) => f.type === 'error')).toBe(false);
    expect(accessorFor(bridgeService, 'sess-no-schema')(0, 1)).toHaveLength(1);
  });

  it('refuses a non-object metadata with METADATA_INVALID', async () => {
    const client = await connect('sess-not-object');

    await sendJson(client, { type: 'metadata', metadata: ['mic-1'] });

    expect(framesOn(client).find((f) => f.type === 'error')?.code).toBe('METADATA_INVALID');
    expect(client.close).not.toHaveBeenCalled();
  });

  it('a `metadata` frame is a known type — never UNKNOWN_TYPE', async () => {
    const client = await connect('sess-known');

    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });

    expect(framesOn(client).some((f) => f.code === 'UNKNOWN_TYPE')).toBe(false);
  });

  // ── 4. Persistence + rebuild ──────────────────────────────────────────────

  it('persists the spans WITH the clock they were measured on', async () => {
    const client = await connect('sess-persist');

    await sendPcm(client, oneSecond());
    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });

    expect(sessionBinding.bindMetadataMarks).toHaveBeenCalledWith('sess-persist', {
      spans: [{ from: 1, to: null, value: ONE_MIC }],
      audioSec: 1,
    });
  });

  it('rebuilds spans AND clock for a session reconnecting onto a gateway that never saw it', async () => {
    // Cross-instance / restarted pod: nothing is in memory. Rebuilding the spans onto a clock
    // that restarted at zero would place the next declaration before the ones already recorded.
    sessionBinding.lookupMetadataMarks.mockResolvedValueOnce({
      spans: [{ from: 0, to: null, value: ONE_MIC }],
      audioSec: 12,
    });
    const client = await connect('sess-rebuild');

    await sendJson(client, { type: 'metadata', metadata: TWO_MICS });

    expect(accessorFor(bridgeService, 'sess-rebuild')(0, 20)).toEqual([
      { from: 0, to: 12, value: ONE_MIC },
      { from: 12, to: 20, value: TWO_MICS },
    ]);
  });

  it('a marks-lookup failure degrades to an empty timeline rather than refusing the handshake', async () => {
    // Same posture as the sampleRate and session-echo reads at this seam: a Redis blip costs a
    // client its labels, never its live transcription.
    sessionBinding.lookupMetadataMarks.mockRejectedValueOnce(new Error('redis blip'));
    const client = await connect('sess-marks-blip');

    expect(client.close).not.toHaveBeenCalled();
    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    expect(accessorFor(bridgeService, 'sess-marks-blip')(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
  });

  it('a failed marks WRITE does not disturb the in-memory timeline', async () => {
    sessionBinding.bindMetadataMarks.mockRejectedValueOnce(new Error('redis blip'));
    const client = await connect('sess-write-blip');

    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(client, oneSecond());

    expect(accessorFor(bridgeService, 'sess-write-blip')(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
  });

  // ── 5. The accessor contract ──────────────────────────────────────────────

  it('installs an accessor read at EMIT time, not a snapshot taken at subscribe', async () => {
    // The subscription is created at handshake, before any metadata exists. A value captured
    // then would be empty for the life of the session — which is exactly how a session-level
    // echo fails at this job, and why the bridge is handed a function.
    const client = await connect('sess-live');
    const spansAt = accessorFor(bridgeService, 'sess-live');

    expect(spansAt(0, 1)).toEqual([]);

    await sendJson(client, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(client, oneSecond());

    expect(spansAt(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
  });

  it('a session that never sends metadata reports none — the caller omits the field', async () => {
    const client = await connect('sess-silent');
    await sendPcm(client, oneSecond());

    expect(accessorFor(bridgeService, 'sess-silent')(0, 1)).toEqual([]);
    expect(sessionBinding.bindMetadataMarks).not.toHaveBeenCalled();
  });

  it('keeps the caption consumer group — the metadata accessor rides alongside, it does not replace', async () => {
    await connect('sess-group');

    const call = bridgeService.subscribeToResults.mock.calls.find((entry: unknown[]) => entry[0] === 'sess-group');
    expect((call![1] as { consumerGroup?: string }).consumerGroup).toBe(WS_RESULT_CONSUMER_GROUP);
  });

  it('a grace-window reconnect keeps reporting the spans declared before the drop', async () => {
    // The re-established caption reader gets a NEW accessor closure; it must close over the
    // same kept `SessionInfo`, or a two-second network blip silently unlabels the rest of the
    // consultation while transcripts keep arriving.
    const first = await connect('sess-keep');
    await sendJson(first, { type: 'metadata', metadata: ONE_MIC });
    await sendPcm(first, oneSecond());

    gateway.handleDisconnect(first as any);
    await connect('sess-keep');

    expect(accessorFor(bridgeService, 'sess-keep')(0, 1)).toEqual([{ from: 0, to: 1, value: ONE_MIC }]);
  });
});
