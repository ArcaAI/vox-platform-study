/**
 * TASK-951 R2 (D-8) — the STT session context echo, on the bridge side.
 *
 * The claim under test is narrow and mechanical: whatever a client declared when it CREATED a
 * streaming session comes back, unchanged, on every transcript of that session, beside a session
 * epoch that puts the session's own relative segment times on a wall clock. That is what turns
 * "one standalone session per microphone" into per-mic attribution without HOPE's mixer,
 * diarization or consultation binding learning anything about microphones (OD-8).
 *
 * Two properties matter as much as the echo itself, and both are asserted here:
 *
 *  1. The echo is attached from a value the SUBSCRIBER supplies once, not re-read per message.
 *     `apps/stt` publishes nothing about it — no Python change was needed for this ticket — so the
 *     bridge is the only place the two fields can enter the wire.
 *  2. A session that declared NO context emits exactly the fields it emitted before this ticket.
 *     Transcripts are the highest-volume frame on the platform and every SDK parses a fixed set;
 *     an unconditional new field would be a wire change for every existing caller, so the pair
 *     rides only on sessions that opted in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, take } from 'rxjs';
import { StreamingAudioBridgeService } from '../streamingAudioBridge.service';

const mockXadd = vi.fn().mockResolvedValue('1234567890-0');
const mockXreadgroup = vi.fn().mockResolvedValue(null);
const mockXack = vi.fn().mockResolvedValue(1);
const mockXgroup = vi.fn().mockResolvedValue('OK');
const mockXautoclaim = vi.fn().mockResolvedValue(['0-0', [], []]);
const mockQuit = vi.fn().mockResolvedValue('OK');

function MockRedis() {
  return {
    xadd: vi.fn((...args: unknown[]) => mockXadd(...args)),
    xreadgroup: vi.fn((...args: unknown[]) => mockXreadgroup(...args)),
    xack: vi.fn((...args: unknown[]) => mockXack(...args)),
    xgroup: vi.fn((...args: unknown[]) => mockXgroup(...args)),
    xautoclaim: vi.fn((...args: unknown[]) => mockXautoclaim(...args)),
    quit: vi.fn((...args: unknown[]) => mockQuit(...args)),
    disconnect: vi.fn(),
    on: vi.fn(),
  };
}

vi.mock('ioredis', () => ({ default: MockRedis }));

/* eslint-disable @typescript-eslint/no-explicit-any */
const configService = () =>
  ({
    isRedisConfigured: vi.fn().mockReturnValue(true),
    getRedisConfig: vi.fn().mockReturnValue({ host: 'localhost', port: 6379, password: undefined }),
  }) as any;

/** One `stt:result` entry as the STT worker publishes it: a flat field array. */
const resultEntry = (fields: string[]) => [['stt:result:s-echo', [['1-0', fields]]]];

const FINAL_SEGMENT = ['text', 'good morning', 'start_time', '0.5', 'end_time', '1.2', 'is_final', '1'];

const STREAM_CONTEXT = { stream: { mic_id: 'mic-1', speaker_label: 'Clinician' } };
const SESSION_EPOCH_MS = 1_757_000_000_000;

describe('TASK-951 — stream session context echo on transcripts', () => {
  let service: StreamingAudioBridgeService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-declare the QUIET defaults explicitly: `clearAllMocks` drops call history, not
    // implementations, so a `…Once` left over from a previous case would otherwise leak.
    mockXreadgroup.mockReset().mockResolvedValue(null);
    mockXautoclaim.mockReset().mockResolvedValue(['0-0', [], []]);
    mockXgroup.mockReset().mockResolvedValue('OK');
    mockXack.mockReset().mockResolvedValue(1);
    mockQuit.mockReset().mockResolvedValue('OK');
    service = new StreamingAudioBridgeService(configService());
    await service.connect();
  });

  afterEach(async () => {
    await service.disconnect();
  });

  it('attaches the session context VERBATIM and the session epoch to a transcript', async () => {
    mockXreadgroup.mockResolvedValueOnce(resultEntry(FINAL_SEGMENT)).mockResolvedValue(null);

    const result = (await firstValueFrom(
      service.subscribeToResults('s-echo', { sessionEcho: { context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS } }).pipe(take(1)),
    )) as Record<string, unknown>;

    expect(result).toEqual({
      type: 'transcript',
      text: 'good morning',
      startTime: 0.5,
      endTime: 1.2,
      isFinal: true,
      context: STREAM_CONTEXT,
      sessionEpochMs: SESSION_EPOCH_MS,
    });
    // VERBATIM means the same object graph, not a re-serialized approximation of it: a client
    // that sent nested structure must read nested structure back.
    expect(result.context).toEqual(STREAM_CONTEXT);
  });

  it('echoes on EVERY transcript of the session, partials included — it is per-session, not per-final', async () => {
    mockXreadgroup
      .mockResolvedValueOnce(resultEntry(['text', 'good', 'start_time', '0', 'end_time', '0.4', 'is_final', '0']))
      .mockResolvedValueOnce(resultEntry(FINAL_SEGMENT))
      .mockResolvedValue(null);

    const seen: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const sub = service.subscribeToResults('s-echo', { sessionEcho: { context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS } }).subscribe({
        next: (msg) => {
          seen.push(msg as unknown as Record<string, unknown>);
          if (seen.length === 2) {
            sub.unsubscribe();
            resolve();
          }
        },
        error: reject,
      });
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].isFinal).toBe(false);
    expect(seen[1].isFinal).toBe(true);
    for (const msg of seen) {
      expect(msg.context).toEqual(STREAM_CONTEXT);
      expect(msg.sessionEpochMs).toBe(SESSION_EPOCH_MS);
    }
  });

  it('a session that declared NO context emits a transcript byte-identical to the pre-TASK-951 wire', async () => {
    mockXreadgroup.mockResolvedValueOnce(resultEntry(FINAL_SEGMENT)).mockResolvedValue(null);

    const result = await firstValueFrom(service.subscribeToResults('s-echo').pipe(take(1)));

    // `toEqual` (not `toMatchObject`) is the point: the assertion fails if ANY field was added.
    expect(result).toEqual({
      type: 'transcript',
      text: 'good morning',
      startTime: 0.5,
      endTime: 1.2,
      isFinal: true,
    });
  });

  it('an epoch with no context adds nothing — the pair travels together or not at all', async () => {
    // The gateway never produces this combination (it passes `sessionEcho` only when a context
    // exists), but the contract must be decidable from the bridge alone: a bare epoch would be a
    // silent wire change for every session created before a client started sending context.
    mockXreadgroup.mockResolvedValueOnce(resultEntry(FINAL_SEGMENT)).mockResolvedValue(null);

    const result = (await firstValueFrom(
      service.subscribeToResults('s-echo', { sessionEcho: { sessionEpochMs: SESSION_EPOCH_MS } }).pipe(take(1)),
    )) as Record<string, unknown>;

    expect(result.sessionEpochMs).toBeUndefined();
    expect(result.context).toBeUndefined();
  });

  it('does not touch STATUS frames — the echo belongs to transcripts', async () => {
    mockXreadgroup.mockResolvedValueOnce(resultEntry(['type', 'status', 'status', 'finalizing'])).mockResolvedValue(null);

    const result = (await firstValueFrom(
      service.subscribeToResults('s-echo', { sessionEcho: { context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS } }).pipe(take(1)),
    )) as Record<string, unknown>;

    expect(result.type).toBe('status');
    expect(result.context).toBeUndefined();
    expect(result.sessionEpochMs).toBeUndefined();
  });

  it('a RECLAIMED result (dead-reader hand-off) carries the echo too', async () => {
    // XAUTOCLAIM re-delivers another consumer's abandoned in-flight through a second code path.
    // A transcript that arrives that way is still a transcript of this session, so it must not
    // reach the client stripped of the labels every one of its siblings carries.
    mockXautoclaim.mockResolvedValueOnce(['0-0', [['1-0', FINAL_SEGMENT]], []]);

    const result = (await firstValueFrom(
      service.subscribeToResults('s-echo', { sessionEcho: { context: STREAM_CONTEXT, sessionEpochMs: SESSION_EPOCH_MS } }).pipe(take(1)),
    )) as Record<string, unknown>;

    expect(result.context).toEqual(STREAM_CONTEXT);
    expect(result.sessionEpochMs).toBe(SESSION_EPOCH_MS);
  });
});
