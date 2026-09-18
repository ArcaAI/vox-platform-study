/**
 * TASK-985 lane L-GATEWAY — reliability, lifecycle and observability on the STT WS gateway.
 *
 * One file, because every case here drives the SAME object through the SAME handshake and the
 * findings interact: the ping sweep (M-47) shortens the window in which the concurrency count
 * was wrong (M-68), the stable consumer name (M-48) is what makes the re-emission guard
 * necessary, and the resume coalescing (ST-5) is what keeps the replay honest once redelivery
 * is routine.
 *
 * Findings pinned: M-03 (gateway metric surface), M-43 (`gap`), M-47, M-48, M-64 (its own file),
 * M-67, M-68, QW-1 gateway half, ST-5.
 */
import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STT_EGRESS_HIGH_WATERMARK_BYTES_KEY,
  STT_GATEWAY_DEFAULTS,
  STT_RESUME_MAX_REPLAY_AGE_MS_KEY,
  STT_WS_PING_INTERVAL_MS_KEY,
  STT_WS_PING_MISSES_KEY,
  sttGatewayAudioEgressDroppedTotal,
  sttGatewayAudioIngestDroppedTotal,
  sttGatewayClientAudioDroppedTotal,
  sttGatewayCommitLatencySeconds,
  sttGatewayFirstPartialSeconds,
} from '@arcaai/applications';
import { SttWsGateway, WS_RESUME_GRACE_MS, wsResultConsumerName } from '../stt-ws.gateway';

// The Prometheus read helpers below walk `prom-client`'s untyped metric snapshots.
/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------------------------

interface MockSocket {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  /** Fire a handler the gateway registered with `client.on(event, fn)`. */
  emit: (event: string, ...args: unknown[]) => void;
}

const createMockSocket = (bufferedAmount = 0): MockSocket => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: MockSocket = {
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    }),
    ping: vi.fn(),
    terminate: vi.fn(),
    readyState: 1,
    OPEN: 1,
    bufferedAmount,
    emit: (event, ...args) => (handlers.get(event) ?? []).forEach((fn) => fn(...args)),
  };
  return socket;
};

const framesOn = (socket: MockSocket): Array<Record<string, unknown>> =>
  socket.send.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])) as Record<string, unknown>);

/** Settings facade double: only the keys a test explicitly writes count as "stored rows". */
const settingsWith = (rows: Record<string, number>) => ({
  hasSetting: vi.fn((key: string) => key in rows),
  getValueWithDefault: vi.fn(<T,>(key: string, fallback: T) => (key in rows ? (rows[key] as unknown as T) : fallback)),
});

/** Prometheus read helpers — the register is process-global, so every assertion is a DELTA. */
const counterTotal = async (metric: any, labels?: Record<string, string>): Promise<number> => {
  const data = await metric.get();
  const matching = data.values.filter((v: any) => !labels || Object.entries(labels).every(([k, val]) => v.labels?.[k] === val));
  return matching.reduce((sum: number, v: any) => sum + v.value, 0);
};

const histogramCount = async (metric: any): Promise<number> => {
  const data = await metric.get();
  const counts = data.values.filter((v: any) => typeof v.metricName === 'string' && v.metricName.endsWith('_count'));
  return counts.reduce((sum: number, v: any) => sum + v.value, 0);
};

describe('SttWsGateway — TASK-985 reliability', () => {
  let gateway: SttWsGateway;
  let sessionService: { getSessionStatus: ReturnType<typeof vi.fn>; removeSession: ReturnType<typeof vi.fn> };
  let bridgeService: {
    writeAudioFrame: ReturnType<typeof vi.fn>;
    writeControlCommand: ReturnType<typeof vi.fn>;
    subscribeToResults: ReturnType<typeof vi.fn>;
    unsubscribeFromResults: ReturnType<typeof vi.fn>;
  };
  let socketRegistry: { publishLocalCount: ReturnType<typeof vi.fn>; publishLocalTenantCounts: ReturnType<typeof vi.fn> };
  let results: Subject<Record<string, unknown>>;

  const buildReq = (sessionId: string) => ({ url: `/ws/stt/stream?sessionId=${sessionId}&ticket=t-${sessionId}` });

  const build = (settings?: ReturnType<typeof settingsWith>) => {
    results = new Subject<Record<string, unknown>>();
    sessionService = { getSessionStatus: vi.fn(), removeSession: vi.fn().mockResolvedValue(undefined) };
    bridgeService = {
      writeAudioFrame: vi.fn().mockResolvedValue(undefined),
      writeControlCommand: vi.fn().mockResolvedValue(undefined),
      subscribeToResults: vi.fn(() => results.asObservable()),
      unsubscribeFromResults: vi.fn(),
    };
    socketRegistry = { publishLocalCount: vi.fn().mockResolvedValue(undefined), publishLocalTenantCounts: vi.fn().mockResolvedValue(undefined) };
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
    const sessionBinding = {
      bind: vi.fn().mockResolvedValue(undefined),
      bindSessionMeta: vi.fn().mockResolvedValue(undefined),
      bindMetadataMarks: vi.fn().mockResolvedValue(undefined),
      lookupBinding: vi.fn().mockResolvedValue({ tenantId: 'tenant-1', userId: 'user-1' }),
      lookupSessionMeta: vi.fn().mockResolvedValue(null),
      lookupMetadataMarks: vi.fn().mockResolvedValue({ spans: [], audioSec: 0 }),
      clear: vi.fn().mockResolvedValue(undefined),
    };
    gateway = new SttWsGateway(
      sessionService as never,
      bridgeService as never,
      streamTicketService as never,
      sessionBinding as never,
      { enqueue: vi.fn() } as never,
      socketRegistry as never,
      undefined,
      settings as never,
    );
  };

  const connect = async (sessionId: string, bufferedAmount = 0): Promise<MockSocket> => {
    const socket = createMockSocket(bufferedAmount);
    await gateway.handleConnection(socket as never, buildReq(sessionId) as never);
    return socket;
  };

  const transcript = (over: Record<string, unknown>) => ({ type: 'transcript', text: 't', startTime: 0, endTime: 1, isFinal: false, ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    build();
  });

  // -------------------------------------------------------------------------------------------
  // M-68 — the concurrency gate counted live SOCKETS, not live SESSIONS
  // -------------------------------------------------------------------------------------------
  describe('M-68 — per-tenant session counts', () => {
    it('a disconnected session still counts for the whole grace window (it still holds a GPU slot)', async () => {
      vi.useFakeTimers();
      const socket = await connect('sess-a');
      socketRegistry.publishLocalTenantCounts.mockClear();

      gateway.handleDisconnect(socket as never);

      const published = socketRegistry.publishLocalTenantCounts.mock.calls.at(-1)?.[0];
      expect(published).toEqual({ 'tenant-1': 1 });
      vi.useRealTimers();
    });

    it('once the grace window expires and the session is finalized, it stops counting', async () => {
      vi.useFakeTimers();
      const socket = await connect('sess-b');
      gateway.handleDisconnect(socket as never);
      socketRegistry.publishLocalTenantCounts.mockClear();

      await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS + 10);

      const published = socketRegistry.publishLocalTenantCounts.mock.calls.at(-1)?.[0];
      expect(published).toEqual({});
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------------------------
  // M-47 — keepalive
  // -------------------------------------------------------------------------------------------
  describe('M-47 — ping / pong', () => {
    it('pings on each heartbeat tick and terminates only after the configured number of misses', async () => {
      vi.useFakeTimers();
      build(settingsWith({ [STT_WS_PING_INTERVAL_MS_KEY]: 1_000, [STT_WS_PING_MISSES_KEY]: 2 }));
      gateway.onModuleInit();
      const socket = await connect('sess-ping');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.ping).toHaveBeenCalledTimes(1);
      expect(socket.terminate).not.toHaveBeenCalled();

      // ONE miss must not terminate — a single lost pong on a congested link is normal.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.ping).toHaveBeenCalledTimes(2);
      expect(socket.terminate).not.toHaveBeenCalled();

      // The third tick sees two consecutive unanswered pings.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(socket.terminate).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('a pong resets the miss count, so a live-but-slow client is never terminated', async () => {
      vi.useFakeTimers();
      build(settingsWith({ [STT_WS_PING_INTERVAL_MS_KEY]: 1_000, [STT_WS_PING_MISSES_KEY]: 2 }));
      gateway.onModuleInit();
      const socket = await connect('sess-pong');

      for (let tick = 0; tick < 6; tick++) {
        await vi.advanceTimersByTimeAsync(1_000);
        socket.emit('pong');
      }

      expect(socket.ping).toHaveBeenCalledTimes(6);
      expect(socket.terminate).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  // -------------------------------------------------------------------------------------------
  // ST-5 / M-38 — resume coalescing
  // -------------------------------------------------------------------------------------------
  describe('ST-5 — resume buffer coalescing', () => {
    it('keeps exactly ONE partial per utteranceIndex, and every final', async () => {
      const socket = await connect('sess-coalesce');

      results.next(transcript({ utteranceIndex: 0, text: 'he' }));
      results.next(transcript({ utteranceIndex: 0, text: 'hell' }));
      results.next(transcript({ utteranceIndex: 0, text: 'hello' }));
      results.next(transcript({ utteranceIndex: 0, text: 'hello there', isFinal: true, endTime: 2 }));
      results.next(transcript({ utteranceIndex: 1, text: 'do' }));
      results.next(transcript({ utteranceIndex: 1, text: 'doc' }));
      socket.send.mockClear();

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'resume', sessionId: 'sess-coalesce', lastSeq: 0 }));

      const replayed = framesOn(socket).filter((f) => f.type === 'transcript');
      // The final of utterance 0 survives; its three superseded partials do not (the last of
      // them is additionally superseded by the final itself). Utterance 1 keeps its newest
      // partial only.
      expect(replayed.map((f) => f.text)).toEqual(['hello there', 'doc']);
    });

    it('never coalesces two finals that share an utterance index — a final is distinct clinical content', async () => {
      const socket = await connect('sess-finals');

      results.next(transcript({ utteranceIndex: 4, text: 'first', isFinal: true, endTime: 1 }));
      results.next(transcript({ utteranceIndex: 4, text: 'second', isFinal: true, endTime: 2 }));
      socket.send.mockClear();

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'resume', sessionId: 'sess-finals', lastSeq: 0 }));

      const replayed = framesOn(socket).filter((f) => f.type === 'transcript');
      expect(replayed.map((f) => f.text)).toEqual(['first', 'second']);
    });

    it('drops a partial older than the governed replay-age bound, and keeps the final of the same age', async () => {
      vi.useFakeTimers();
      build(settingsWith({ [STT_RESUME_MAX_REPLAY_AGE_MS_KEY]: 5_000 }));
      const socket = await connect('sess-age');

      // The final's utterance index is BELOW the partial's, so the partial is not superseded by
      // it — age is the only rule that can drop it, which is what this case has to isolate.
      results.next(transcript({ utteranceIndex: 5, text: 'stale final', isFinal: true, endTime: 3 }));
      results.next(transcript({ utteranceIndex: 7, text: 'stale partial' }));
      await vi.advanceTimersByTimeAsync(6_000);
      socket.send.mockClear();

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'resume', sessionId: 'sess-age', lastSeq: 0 }));

      const replayed = framesOn(socket).filter((f) => f.type === 'transcript');
      expect(replayed.map((f) => f.text)).toEqual(['stale final']);
      vi.useRealTimers();
    });

    it('leaves an older worker (no utteranceIndex) on exactly the pre-TASK-985 behaviour', async () => {
      const socket = await connect('sess-legacy');

      results.next(transcript({ text: 'p1' }));
      results.next(transcript({ text: 'p2' }));
      results.next(transcript({ text: 'p3' }));
      socket.send.mockClear();

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'resume', sessionId: 'sess-legacy', lastSeq: 0 }));

      const replayed = framesOn(socket).filter((f) => f.type === 'transcript');
      expect(replayed.map((f) => f.text)).toEqual(['p1', 'p2', 'p3']);
    });
  });

  // -------------------------------------------------------------------------------------------
  // M-48 — stable consumer name, and the guard it makes mandatory
  // -------------------------------------------------------------------------------------------
  describe('M-48 — stable consumer name + re-emission guard', () => {
    it('subscribes under a stable per-session consumer name', async () => {
      await connect('sess-name');
      expect(bridgeService.subscribeToResults.mock.calls[0]?.[1]).toMatchObject({
        consumerGroup: 'captions',
        consumerName: wsResultConsumerName('sess-name'),
      });
      // A FIRST subscribe must NOT reclaim at min-idle 0: no other consumer has been proven
      // dead, and stealing a live one's in-flight would split the captions.
      expect(bridgeService.subscribeToResults.mock.calls[0]?.[1]).not.toHaveProperty('reclaimMinIdleMs');
    });

    it('the rebind path reclaims at min-idle 0', async () => {
      vi.useFakeTimers();
      const first = await connect('sess-rebind');
      gateway.handleDisconnect(first as never);
      await connect('sess-rebind');

      expect(bridgeService.subscribeToResults.mock.calls.at(-1)?.[1]).toMatchObject({
        consumerName: wsResultConsumerName('sess-rebind'),
        reclaimMinIdleMs: 0,
      });
      vi.useRealTimers();
    });

    it('a REDELIVERED result reuses its original seq and does not occupy a second buffer slot', async () => {
      const socket = await connect('sess-redeliver');
      const entry = transcript({ utteranceIndex: 2, text: 'redelivered', isFinal: true, endTime: 5 });

      results.next({ ...entry });
      results.next({ ...entry }); // at-least-once: the same Redis entry, read twice
      const live = framesOn(socket).filter((f) => f.type === 'transcript');
      expect(live.map((f) => f.seq)).toEqual([1, 1]);

      socket.send.mockClear();
      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'resume', sessionId: 'sess-redeliver', lastSeq: 0 }));
      const replayed = framesOn(socket).filter((f) => f.type === 'transcript');
      expect(replayed).toHaveLength(1);
    });

    it('two genuinely different partials of one utterance still get different seqs', async () => {
      const socket = await connect('sess-distinct');

      results.next(transcript({ utteranceIndex: 0, text: 'he' }));
      results.next(transcript({ utteranceIndex: 0, text: 'hello' }));

      const live = framesOn(socket).filter((f) => f.type === 'transcript');
      expect(live.map((f) => f.seq)).toEqual([1, 2]);
    });
  });

  // -------------------------------------------------------------------------------------------
  // QW-1 gateway half — finalize on the terminal `closed`, with the right `interrupted`
  // -------------------------------------------------------------------------------------------
  describe('QW-1 — finalize on the upstream terminal status', () => {
    it("a session the client STOPPED finalizes as NOT interrupted, without waiting for the grace window", async () => {
      const socket = await connect('sess-stop');
      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'stop' }));
      expect(bridgeService.writeControlCommand).toHaveBeenCalledWith('sess-stop', 'finalize');

      results.complete();

      expect(sessionService.removeSession).toHaveBeenCalledWith('sess-stop', false, 'tenant-1');
      // The client is still told the stream closed — the frame goes out before teardown.
      expect(framesOn(socket).some((f) => f.type === 'status' && f.status === 'closed')).toBe(true);
    });

    it('a session that never asked to stop finalizes as INTERRUPTED', async () => {
      await connect('sess-abort');

      results.complete();

      expect(sessionService.removeSession).toHaveBeenCalledWith('sess-abort', true, 'tenant-1');
    });

    it('a `close` arriving after the gateway already finalized is answered politely, not with NO_SESSION', async () => {
      const socket = await connect('sess-late-close');
      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'stop' }));
      results.complete();
      socket.send.mockClear();

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'close' }));

      const frames = framesOn(socket);
      expect(frames.some((f) => f.type === 'error' && f.code === 'NO_SESSION')).toBe(false);
      expect(frames.some((f) => f.type === 'status' && f.status === 'closed')).toBe(true);
      expect(socket.close).toHaveBeenCalledWith(1000, 'Session closed by client');
    });

    it('any OTHER frame on a finalized session still errors — the client is streaming into nothing', async () => {
      const socket = await connect('sess-orphan');
      results.complete();
      socket.send.mockClear();

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'resume', sessionId: 'sess-orphan', lastSeq: 0 }));

      expect(framesOn(socket).some((f) => f.type === 'error' && f.code === 'NO_SESSION')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // M-43 — the `gap` frame
  // -------------------------------------------------------------------------------------------
  describe('M-43 — gap signalling', () => {
    it('signals once per back-pressure episode, and AGAIN after the socket drains', async () => {
      // The latch used to be cleared only inside the queued-finals drain poll, which never runs
      // for an episode that dropped partials without queueing a final — so every later episode
      // in that session was silent for its whole life.
      const socket = await connect('sess-gap', 10 * 1024 * 1024);

      results.next(transcript({ utteranceIndex: 0, text: 'dropped a' }));
      results.next(transcript({ utteranceIndex: 0, text: 'dropped b' }));
      expect(framesOn(socket).filter((f) => f.type === 'gap')).toHaveLength(1);

      socket.bufferedAmount = 0;
      results.next(transcript({ utteranceIndex: 1, text: 'delivered' }));

      socket.bufferedAmount = 10 * 1024 * 1024;
      results.next(transcript({ utteranceIndex: 2, text: 'dropped c' }));

      expect(framesOn(socket).filter((f) => f.type === 'gap')).toHaveLength(2);
    });

    it('a dropped partial carries reason=egress_partial_dropped and the running count', async () => {
      const socket = await connect('sess-gap-shape', 10 * 1024 * 1024);
      results.next(transcript({ text: 'dropped' }));

      const gap = framesOn(socket).find((f) => f.type === 'gap');
      expect(gap).toMatchObject({ reason: 'egress_partial_dropped', sessionId: 'sess-gap-shape', droppedPartials: 1 });
    });
  });

  // -------------------------------------------------------------------------------------------
  // ST-5 — the watermark is governed, per session
  // -------------------------------------------------------------------------------------------
  describe('ST-5 — governed egress watermark', () => {
    it('a stored row governs the drop decision for sessions opened after it', async () => {
      build(settingsWith({ [STT_EGRESS_HIGH_WATERMARK_BYTES_KEY]: 100 }));
      const socket = await connect('sess-watermark', 200);

      results.next(transcript({ text: 'over the low watermark' }));

      expect(framesOn(socket).some((f) => f.type === 'gap')).toBe(true);
      expect(framesOn(socket).some((f) => f.type === 'transcript')).toBe(false);
    });

    it('the code default is 32 KiB — not the 512 KiB (~50 s of stale captions) it replaced', () => {
      expect(STT_GATEWAY_DEFAULTS[STT_EGRESS_HIGH_WATERMARK_BYTES_KEY]).toBe(32 * 1024);
    });
  });

  // -------------------------------------------------------------------------------------------
  // M-67 — the client's own transport self-report
  // -------------------------------------------------------------------------------------------
  describe('M-67 — client_stats', () => {
    it('records a client-reported drop count on its own counter, and never errors on the frame', async () => {
      const socket = await connect('sess-stats');
      const before = await counterTotal(sttGatewayClientAudioDroppedTotal);

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'client_stats', droppedFrames: 12, sentFrames: 900 }));

      expect(await counterTotal(sttGatewayClientAudioDroppedTotal)).toBe(before + 12);
      expect(framesOn(socket).some((f) => f.type === 'error')).toBe(false);
    });

    it('a malformed stats frame is ignored rather than answered with an error', async () => {
      // It arrives exactly when the client is trying to leave; failing the frame would turn a
      // telemetry problem into a teardown problem.
      const socket = await connect('sess-stats-bad');
      const before = await counterTotal(sttGatewayClientAudioDroppedTotal);

      await gateway.handleMessage(socket as never, JSON.stringify({ type: 'client_stats', droppedFrames: 'lots' }));

      expect(await counterTotal(sttGatewayClientAudioDroppedTotal)).toBe(before);
      expect(framesOn(socket).some((f) => f.type === 'error')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // M-03 — the gateway had NO Prometheus series at all
  // -------------------------------------------------------------------------------------------
  describe('M-03 — metric surface', () => {
    it('observes first-partial latency exactly once per session', async () => {
      const socket = await connect('sess-metrics');
      const before = await histogramCount(sttGatewayFirstPartialSeconds);

      await gateway.handleMessage(socket as never, Buffer.from([0, 0, 0, 0]), true);
      results.next(transcript({ utteranceIndex: 0, text: 'first' }));
      results.next(transcript({ utteranceIndex: 0, text: 'first partial' }));

      expect(await histogramCount(sttGatewayFirstPartialSeconds)).toBe(before + 1);
    });

    it('observes commit latency against the audio clock when a final carries an endTime', async () => {
      const socket = await connect('sess-commit');
      const before = await histogramCount(sttGatewayCommitLatencySeconds);

      // 16 kHz PCM16 mono ⇒ 32 000 bytes per second of audio. Two frames of 3 200 bytes put the
      // clock at 0.2 s, which is far enough past the 100 ms sampling interval to leave samples
      // the final's endTime can land on.
      await gateway.handleMessage(socket as never, Buffer.alloc(3_200), true);
      await gateway.handleMessage(socket as never, Buffer.alloc(3_200), true);
      results.next(transcript({ utteranceIndex: 0, text: 'done', isFinal: true, startTime: 0, endTime: 0.15 }));

      expect(await histogramCount(sttGatewayCommitLatencySeconds)).toBe(before + 1);
    });

    it('does NOT invent a commit-latency sample when the audio clock holds nothing for that endTime', async () => {
      // A session resumed onto a gateway that never saw the earlier audio. A fabricated number
      // in a latency histogram is worse than a missing one.
      await connect('sess-no-clock');
      const before = await histogramCount(sttGatewayCommitLatencySeconds);

      results.next(transcript({ utteranceIndex: 0, text: 'done', isFinal: true, startTime: 0, endTime: 42 }));

      expect(await histogramCount(sttGatewayCommitLatencySeconds)).toBe(before);
    });

    it('counts a dropped partial on the egress counter, labelled by kind', async () => {
      await connect('sess-egress-metric', 10 * 1024 * 1024);
      const before = await counterTotal(sttGatewayAudioEgressDroppedTotal, { kind: 'partial' });

      results.next(transcript({ text: 'dropped' }));

      expect(await counterTotal(sttGatewayAudioEgressDroppedTotal, { kind: 'partial' })).toBe(before + 1);
    });

    it('counts a failed upstream audio write on the ingest counter', async () => {
      const socket = await connect('sess-ingest-metric');
      bridgeService.writeAudioFrame.mockRejectedValueOnce(new Error('redis down'));
      const before = await counterTotal(sttGatewayAudioIngestDroppedTotal);

      await gateway.handleMessage(socket as never, Buffer.from([1, 2, 3, 4]), true);
      // The write is fire-and-forget; let its rejection handler run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(await counterTotal(sttGatewayAudioIngestDroppedTotal)).toBe(before + 1);
    });
  });
});
