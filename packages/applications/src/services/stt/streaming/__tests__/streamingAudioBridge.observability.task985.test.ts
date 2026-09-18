/**
 * TASK-985 M-03 — the two things the result relay knew and never told anyone.
 *
 * 1. `inference_ms`. `apps/stt` has stamped it on every result entry all along; the bridge
 *    parsed it into a local and then omitted it from the message it constructed. It is the one
 *    number that separates "the model is slow" from "the transport is slow", and no consumer —
 *    SDK, console or dashboard — has ever seen it.
 * 2. Relay lag. The Redis entry id is `<ms>-<seq>` and the `<ms>` half is the Redis server's
 *    own clock at XADD, so the gateway↔STT relay delay is readable with NO wire-format change.
 *    It was not read.
 *
 * The third case here is the one that matters most operationally: a session that opts into
 * neither must be BYTE-IDENTICAL to the pre-TASK-985 wire, because transcripts are the
 * highest-volume frame on the platform and every SDK parses a fixed field set.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, take } from 'rxjs';
import { StreamingAudioBridgeService } from '../streamingAudioBridge.service';
import { sttGatewayRelayLagSeconds } from '../stt-gateway.metrics';

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

/** One `stt:result` entry, with an explicit entry id so the relay-lag read is deterministic. */
const entry = (fields: string[], entryId = `${Date.now()}-0`) => [['stt:result:s-obs', [[entryId, fields]]]];

const histogramField = async (metric: any, suffix: string): Promise<number> => {
  const data = await metric.get();
  const matching = data.values.filter((v: any) => typeof v.metricName === 'string' && v.metricName.endsWith(suffix));
  return matching.reduce((sum: number, v: any) => sum + v.value, 0);
};

const histogramCount = (metric: any): Promise<number> => histogramField(metric, '_count');
const histogramSum = (metric: any): Promise<number> => histogramField(metric, '_sum');

describe('TASK-985 M-03 — bridge observability', () => {
  let service: StreamingAudioBridgeService;

  beforeEach(async () => {
    vi.clearAllMocks();
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

  it('carries inferenceMs onto the transcript when the worker stamped it', async () => {
    const withInference = entry(['text', 'hello', 'start_time', '0', 'end_time', '1', 'is_final', '1', 'inference_ms', '184.5']);
    mockXreadgroup.mockResolvedValueOnce(withInference).mockResolvedValue(null);

    const result = (await firstValueFrom(service.subscribeToResults('s-obs').pipe(take(1)))) as Record<string, unknown>;

    expect(result.inferenceMs).toBe(184.5);
  });

  it('omits inferenceMs entirely for an older worker that does not stamp it', async () => {
    mockXreadgroup.mockResolvedValueOnce(entry(['text', 'hello', 'start_time', '0', 'end_time', '1', 'is_final', '1'])).mockResolvedValue(null);

    const result = (await firstValueFrom(service.subscribeToResults('s-obs').pipe(take(1)))) as Record<string, unknown>;

    // Absent, not `null` and not `0` — a consumer must be able to tell "not reported" from
    // "reported as instant", and an averaged 0 would understate every dashboard it reaches.
    expect('inferenceMs' in result).toBe(false);
  });

  it('ignores a non-numeric or negative inference_ms rather than relaying it', async () => {
    const notANumber = entry(['text', 'hello', 'start_time', '0', 'end_time', '1', 'is_final', '1', 'inference_ms', 'fast']);
    mockXreadgroup.mockResolvedValueOnce(notANumber).mockResolvedValue(null);

    const result = (await firstValueFrom(service.subscribeToResults('s-obs').pipe(take(1)))) as Record<string, unknown>;

    expect('inferenceMs' in result).toBe(false);
  });

  it('observes relay lag from the entry id, with no wire-format change', async () => {
    const before = await histogramCount(sttGatewayRelayLagSeconds);
    const beforeSum = await histogramSum(sttGatewayRelayLagSeconds);
    // 250 ms in the past on the Redis clock.
    const entryId = `${Date.now() - 250}-0`;
    const lagged = entry(['text', 'hello', 'start_time', '0', 'end_time', '1', 'is_final', '1'], entryId);
    mockXreadgroup.mockResolvedValueOnce(lagged).mockResolvedValue(null);

    await firstValueFrom(service.subscribeToResults('s-obs').pipe(take(1)));

    expect(await histogramCount(sttGatewayRelayLagSeconds)).toBe(before + 1);
    expect(await histogramSum(sttGatewayRelayLagSeconds)).toBeGreaterThanOrEqual(beforeSum + 0.2);
  });

  it('clamps a future entry id to zero instead of discarding the sample', async () => {
    // Gateway clock behind the Redis node's. A clamped 0 says "as fast as we can tell"; a
    // discard would silently thin the histogram exactly when clocks disagree, which is when an
    // operator most needs to see that the samples are there.
    const before = await histogramCount(sttGatewayRelayLagSeconds);
    const fromTheFuture = entry(['text', 'hi', 'start_time', '0', 'end_time', '1', 'is_final', '1'], `${Date.now() + 60_000}-0`);
    mockXreadgroup.mockResolvedValueOnce(fromTheFuture).mockResolvedValue(null);

    await firstValueFrom(service.subscribeToResults('s-obs').pipe(take(1)));

    expect(await histogramCount(sttGatewayRelayLagSeconds)).toBe(before + 1);
  });

  it('a session using neither feature emits the pre-TASK-985 wire, field for field', async () => {
    const plain = entry(['text', 'good morning', 'start_time', '0.5', 'end_time', '1.2', 'is_final', '1']);
    mockXreadgroup.mockResolvedValueOnce(plain).mockResolvedValue(null);

    const result = (await firstValueFrom(service.subscribeToResults('s-obs').pipe(take(1)))) as Record<string, unknown>;

    expect(result).toEqual({ type: 'transcript', text: 'good morning', startTime: 0.5, endTime: 1.2, isFinal: true });
  });
});

describe('TASK-985 M-48 — the reclaim idle bound is a parameter, not a constant', () => {
  let service: StreamingAudioBridgeService;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockXreadgroup.mockReset().mockResolvedValue(null);
    mockXautoclaim.mockReset().mockResolvedValue(['0-0', [], []]);
    mockXgroup.mockReset().mockResolvedValue('OK');
    service = new StreamingAudioBridgeService(configService());
    await service.connect();
  });

  afterEach(async () => {
    await service.disconnect();
  });

  it('defaults to the conservative 30 s bound when the caller says nothing', async () => {
    const sub = service.subscribeToResults('s-claim').subscribe({ next: () => {}, error: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.unsubscribe();

    expect(mockXautoclaim).toHaveBeenCalledWith('stt:result:s-claim', expect.any(String), expect.any(String), 30_000, '0-0', 'COUNT', 100);
  });

  it('reclaims at min-idle 0 when the caller has proven the other consumer dead', async () => {
    // The gateway's rebind path: it disconnected the previous reader itself, so waiting 30 s —
    // longer than the 15 s grace window the results have to survive — abandons them.
    const sub = service.subscribeToResults('s-claim', { reclaimMinIdleMs: 0 }).subscribe({ next: () => {}, error: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.unsubscribe();

    expect(mockXautoclaim).toHaveBeenCalledWith('stt:result:s-claim', expect.any(String), expect.any(String), 0, '0-0', 'COUNT', 100);
  });

  it('uses the stable consumer name the caller supplies', async () => {
    const options = { consumerGroup: 'captions', consumerName: 'captions-s-claim' };
    const sub = service.subscribeToResults('s-claim', options).subscribe({ next: () => {}, error: () => {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    sub.unsubscribe();

    const expected = ['GROUP', 'captions', 'captions-s-claim', 'COUNT', 100, 'BLOCK', expect.any(Number), 'STREAMS', 'stt:result:s-claim', '0'];
    expect(mockXreadgroup).toHaveBeenCalledWith(...expected);
  });
});
