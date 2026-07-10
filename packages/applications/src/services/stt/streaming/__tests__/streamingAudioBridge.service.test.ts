/**
 * StreamingAudioBridgeService Unit Tests
 *
 * Tests the Redis Streams bridge that forwards audio between the API Gateway
 * and STT-V2:
 * - Audio frame writing (XADD to stt:audio:{sessionId})
 * - Control command writing (XADD to stt:control:{sessionId})
 * - Result subscription (XREAD from stt:result:{sessionId})
 * - Connection lifecycle (connect / disconnect / onModuleDestroy)
 * - Error handling and edge cases
 *
 * Testing Strategy:
 * - Mock ioredis with vi.mock() — no real Redis needed
 * - Direct instantiation with mocked IConfigService
 * - Verify XADD/XREAD call arguments match the protocol contract
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, toArray, take, lastValueFrom } from 'rxjs';
import { StreamingAudioBridgeService } from '../streamingAudioBridge.service';

// ---------------------------------------------------------------------------
// Mock ioredis
// ---------------------------------------------------------------------------

const mockXadd = vi.fn().mockResolvedValue('1234567890-0');
// TASK-457 — the result reader now uses a Redis consumer group.
const mockXreadgroup = vi.fn().mockResolvedValue(null);
const mockXack = vi.fn().mockResolvedValue(1);
const mockXgroup = vi.fn().mockResolvedValue('OK');
const mockXautoclaim = vi.fn().mockResolvedValue(['0-0', [], []]);
const mockQuit = vi.fn().mockResolvedValue('OK');

/**
 * TASK-351 P1-3 (H5) — every `new Redis()` call is recorded here with
 * per-instance spies (delegating to the shared fns above, so the aggregate
 * assertions of older tests keep working). This lets tests assert WHICH
 * connection issued an XREADGROUP — the structural property behind the
 * per-subscriber-reader fix.
 */
interface MockRedisInstance {
    xadd: ReturnType<typeof vi.fn>;
    xreadgroup: ReturnType<typeof vi.fn>;
    xack: ReturnType<typeof vi.fn>;
    xgroup: ReturnType<typeof vi.fn>;
    xautoclaim: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    // TASK-457 C1 — disconnect() forcibly drops the reader connection on
    // unsubscribe; M3 — on() registers writer health listeners.
    disconnect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
}

const mockRedisInstances: MockRedisInstance[] = [];

/**
 * Create a mock Redis constructor that returns an object with our mock methods.
 * We need a real constructor function (not an arrow function) so `new Redis()`
 * works correctly in both threads and forks pool modes.
 */
function MockRedis() {
    const instance: MockRedisInstance = {
        xadd: vi.fn((...args: unknown[]) => mockXadd(...args)),
        xreadgroup: vi.fn((...args: unknown[]) => mockXreadgroup(...args)),
        xack: vi.fn((...args: unknown[]) => mockXack(...args)),
        xgroup: vi.fn((...args: unknown[]) => mockXgroup(...args)),
        xautoclaim: vi.fn((...args: unknown[]) => mockXautoclaim(...args)),
        quit: vi.fn((...args: unknown[]) => mockQuit(...args)),
        disconnect: vi.fn(),
        on: vi.fn(),
    };
    mockRedisInstances.push(instance);
    return instance;
}

vi.mock('ioredis', () => {
    return {
        default: MockRedis,
    };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockConfigService(configured = true) {
    return {
        isRedisConfigured: vi.fn().mockReturnValue(configured),
        getRedisConfig: vi.fn().mockReturnValue({
            host: 'localhost',
            port: 6379,
            password: undefined,
        }),
    } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamingAudioBridgeService', () => {
    let service: StreamingAudioBridgeService;
    let configService: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockRedisInstances.length = 0;
        configService = createMockConfigService();
        service = new StreamingAudioBridgeService(configService);
    });

    afterEach(async () => {
        await service.disconnect();
    });

    // ===================================================================
    // Connection management
    // ===================================================================

    describe('connect()', () => {
        it('should create writer and reader Redis clients (writeAudioFrame works after connect)', async () => {
            await service.connect();

            // If connect worked, writeAudioFrame should not throw "not connected"
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0));
            expect(mockXadd).toHaveBeenCalled();
        });

        it('should be idempotent — second call is a no-op', async () => {
            await service.connect();
            await service.connect();

            // Still works — only one set of connections created
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0));
            expect(mockXadd).toHaveBeenCalledTimes(1);
        });

        it('should skip connection when Redis is not configured', async () => {
            const unconfigured = createMockConfigService(false);
            const svc = new StreamingAudioBridgeService(unconfigured);

            await svc.connect();

            expect(unconfigured.getRedisConfig).not.toHaveBeenCalled();
            // Should still be "not connected"
            await expect(
                svc.writeAudioFrame('s-1', 1, Buffer.from('test')),
            ).rejects.toThrow('Audio bridge not connected');
        });

        it('should skip connection when configService is undefined', async () => {
            const svc = new StreamingAudioBridgeService(undefined);

            await svc.connect();

            // Should not throw, just silently skip
            await expect(
                svc.writeAudioFrame('s-1', 1, Buffer.from('test')),
            ).rejects.toThrow('Audio bridge not connected');
        });

        it('should call getRedisConfig when Redis is configured', async () => {
            await service.connect();

            expect(configService.isRedisConfigured).toHaveBeenCalled();
            expect(configService.getRedisConfig).toHaveBeenCalled();
        });
    });

    describe('disconnect()', () => {
        it('should quit both Redis clients', async () => {
            await service.connect();
            await service.disconnect();

            expect(mockQuit).toHaveBeenCalledTimes(2);
        });

        it('should abort all active subscriptions', async () => {
            await service.connect();

            // Start a subscription (it will try to XREAD in background)
            const obs = service.subscribeToResults('s-1');
            const sub = obs.subscribe({ next: () => {} });

            await service.disconnect();

            // After disconnect, subscription should be cleaned up
            sub.unsubscribe();
        });

        it('should be safe to call when not connected', async () => {
            // Should not throw
            await service.disconnect();
            expect(mockQuit).not.toHaveBeenCalled();
        });

        it('should handle quit() errors gracefully', async () => {
            mockQuit.mockRejectedValueOnce(new Error('Connection lost'));
            mockQuit.mockRejectedValueOnce(new Error('Connection lost'));

            await service.connect();
            // Should not throw
            await service.disconnect();
        });
    });

    describe('onModuleDestroy()', () => {
        it('should call disconnect()', async () => {
            await service.connect();
            await service.onModuleDestroy();

            expect(mockQuit).toHaveBeenCalledTimes(2);
        });
    });

    // ===================================================================
    // writeAudioFrame
    // ===================================================================

    describe('writeAudioFrame()', () => {
        beforeEach(async () => {
            await service.connect();
        });

        it('should XADD to stt:audio:{sessionId}', async () => {
            const buffer = Buffer.from('pcm-audio-data');
            await service.writeAudioFrame('session-abc', 1, buffer);

            expect(mockXadd).toHaveBeenCalledWith(
                'stt:audio:session-abc',
                'MAXLEN', '~', '10000',
                '*',
                'seq', '1',
                'sr', '16000',
                'enc', 'pcm_s16le',
                'ch', '1',
                'data', buffer,
                'final', '0',
                'ts', expect.any(String),
            );
        });

        it('should use default sampleRate=16000 and encoding=pcm_s16le', async () => {
            await service.writeAudioFrame('s-1', 0, Buffer.alloc(0));

            expect(mockXadd).toHaveBeenCalledWith(
                expect.any(String),
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(),
                'seq', '0',
                'sr', '16000',
                'enc', 'pcm_s16le',
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
            );
        });

        it('should forward custom sampleRate', async () => {
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0), 44100);

            expect(mockXadd).toHaveBeenCalledWith(
                expect.any(String),
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(),
                'seq', '1',
                'sr', '44100',
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
            );
        });

        it('should forward custom encoding', async () => {
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0), 16000, 'opus');

            expect(mockXadd).toHaveBeenCalledWith(
                expect.any(String),
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                'enc', 'opus',
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
            );
        });

        it('should set final=1 when isFinal is true', async () => {
            await service.writeAudioFrame('s-1', 99, Buffer.alloc(0), 16000, 'pcm_s16le', true);

            expect(mockXadd).toHaveBeenCalledWith(
                expect.any(String),
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                'final', '1',
                expect.anything(), expect.anything(),
            );
        });

        it('should set final=0 when isFinal is false', async () => {
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0), 16000, 'pcm_s16le', false);

            expect(mockXadd).toHaveBeenCalledWith(
                expect.any(String),
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                'final', '0',
                expect.anything(), expect.anything(),
            );
        });

        it('should include a timestamp field', async () => {
            const before = Date.now() / 1000;
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0));
            const after = Date.now() / 1000;

            // Find the 'ts' key in the XADD args and get the next arg (value)
            const args = mockXadd.mock.calls[0];
            const tsIndex = args.indexOf('ts');
            expect(tsIndex).toBeGreaterThan(-1);
            const ts = parseFloat(args[tsIndex + 1]);
            expect(ts).toBeGreaterThanOrEqual(before);
            expect(ts).toBeLessThanOrEqual(after);
        });

        it('should cap stream at ~10000 entries via MAXLEN', async () => {
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0));

            const args = mockXadd.mock.calls[0];
            expect(args[1]).toBe('MAXLEN');
            expect(args[2]).toBe('~');
            expect(args[3]).toBe('10000');
        });

        it('should throw when not connected', async () => {
            const svc = new StreamingAudioBridgeService(configService);

            await expect(
                svc.writeAudioFrame('s-1', 1, Buffer.from('data')),
            ).rejects.toThrow('Audio bridge not connected');
        });

        it('should propagate XADD errors', async () => {
            mockXadd.mockRejectedValueOnce(new Error('READONLY'));

            await expect(
                service.writeAudioFrame('s-1', 1, Buffer.from('data')),
            ).rejects.toThrow('READONLY');
        });

        it('should use auto-generated entry ID (*)', async () => {
            await service.writeAudioFrame('s-1', 1, Buffer.alloc(0));

            const args = mockXadd.mock.calls[0];
            expect(args[4]).toBe('*');
        });

        it('should stringify seq number', async () => {
            await service.writeAudioFrame('s-1', 42, Buffer.alloc(0));

            expect(mockXadd).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(), expect.anything(), expect.anything(),
                expect.anything(),
                'seq', '42',
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
                expect.anything(), expect.anything(),
            );
        });
    });

    // ===================================================================
    // writeControlCommand
    // ===================================================================

    describe('writeControlCommand()', () => {
        beforeEach(async () => {
            await service.connect();
        });

        it('should XADD finalize command to stt:control:{sessionId}', async () => {
            await service.writeControlCommand('session-xyz', 'finalize');

            expect(mockXadd).toHaveBeenCalledWith(
                'stt:control:session-xyz',
                '*',
                'action', 'finalize',
            );
        });

        it('should XADD pause command', async () => {
            await service.writeControlCommand('s-1', 'pause');

            expect(mockXadd).toHaveBeenCalledWith(
                'stt:control:s-1',
                '*',
                'action', 'pause',
            );
        });

        it('should XADD resume command', async () => {
            await service.writeControlCommand('s-1', 'resume');

            expect(mockXadd).toHaveBeenCalledWith(
                'stt:control:s-1',
                '*',
                'action', 'resume',
            );
        });

        it('should XADD cancel command', async () => {
            await service.writeControlCommand('s-1', 'cancel');

            expect(mockXadd).toHaveBeenCalledWith(
                'stt:control:s-1',
                '*',
                'action', 'cancel',
            );
        });

        it('should throw when not connected', async () => {
            const svc = new StreamingAudioBridgeService(configService);

            await expect(
                svc.writeControlCommand('s-1', 'finalize'),
            ).rejects.toThrow('Audio bridge not connected');
        });

        it('should propagate XADD errors', async () => {
            mockXadd.mockRejectedValueOnce(new Error('NOSCRIPT'));

            await expect(
                service.writeControlCommand('s-1', 'finalize'),
            ).rejects.toThrow('NOSCRIPT');
        });
    });

    // ===================================================================
    // subscribeToResults
    // ===================================================================

    describe('subscribeToResults()', () => {
        beforeEach(async () => {
            await service.connect();
        });

        it('should return an Observable', () => {
            const obs = service.subscribeToResults('s-1');
            expect(obs.subscribe).toBeTypeOf('function');
        });

        it('should emit parsed transcript segments', async () => {
            // Simulate XREAD returning a transcript entry
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['text', 'hello world', 'start_time', '0.5', 'end_time', '1.2', 'is_final', '1']],
                    ]],
                ])
                // Then return null to let the loop continue, then abort
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result).toEqual({
                type: 'transcript',
                text: 'hello world',
                startTime: 0.5,
                endTime: 1.2,
                isFinal: true,
            });
        });

        it('should map speaker metadata when present', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', [
                            'text', 'hello world',
                            'speaker_id', 'speaker-1',
                            'speaker_confidence', '0.87',
                            'start_time', '0.5',
                            'end_time', '1.2',
                            'is_final', '1',
                        ]],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result).toEqual({
                type: 'transcript',
                text: 'hello world',
                speakerId: 'speaker-1',
                speakerConfidence: 0.87,
                startTime: 0.5,
                endTime: 1.2,
                isFinal: true,
            });
        });

        it('should map english_text when code-switch translation is present', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', [
                            'text', 'வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்',
                            'english_text', 'Will not call ...',
                            'start_time', '74.784',
                            'end_time', '82.88',
                            'is_final', '1',
                        ]],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result).toEqual({
                type: 'transcript',
                text: 'வில் நாட் கால விலிக்கில்லா தீரித்து விலிக்கியும்',
                englishText: 'Will not call ...',
                startTime: 74.784,
                endTime: 82.88,
                isFinal: true,
            });
        });

        // TASK-351 P1-1 — additive stable_chars relay (committed-prefix length
        // emitted by stt-v2 on partial results). Absent field must leave the
        // message exactly as today.
        it('maps stable_chars to stableChars when present (TASK-351 P1-1)', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', [
                            'text', 'hello tentative tail',
                            'stable_chars', '5',
                            'start_time', '0',
                            'end_time', '1.5',
                            'is_final', '0',
                        ]],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result.stableChars).toBe(5);
            expect(result.isFinal).toBe(false);
        });

        it('omits stableChars when stable_chars is absent (older stt-v2 unchanged)', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['text', 'plain partial', 'start_time', '0', 'end_time', '1', 'is_final', '0']],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect('stableChars' in result).toBe(false);
        });

        it('omits stableChars when stable_chars is not a valid non-negative integer', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['text', 'junk field', 'stable_chars', 'not-a-number', 'start_time', '0', 'end_time', '1', 'is_final', '0']],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect('stableChars' in result).toBe(false);
        });

        // TASK-351 P1-1 follow-up — utterance_index + type ('segment'|'gloss')
        // are additive wire fields; gloss results carry the final's
        // utterance_index plus english_text.
        it('maps a gloss result (type/utterance_index/english_text) onto the transcript message', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', [
                            'type', 'gloss',
                            'text', 'xin chào',
                            'english_text', 'hello',
                            'utterance_index', '3',
                            'start_time', '0',
                            'end_time', '1.5',
                            'is_final', '1',
                        ]],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result).toEqual({
                type: 'transcript',
                text: 'xin chào',
                englishText: 'hello',
                utteranceIndex: 3,
                resultType: 'gloss',
                startTime: 0,
                endTime: 1.5,
                isFinal: true,
            });
        });

        it('maps type=segment and utterance_index on ordinary partials', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', [
                            'type', 'segment',
                            'text', 'partial words',
                            'utterance_index', '0',
                            'start_time', '0',
                            'end_time', '0.8',
                            'is_final', '0',
                        ]],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result.resultType).toBe('segment');
            expect(result.utteranceIndex).toBe(0);
        });

        it('omits utteranceIndex and resultType when the wire fields are absent (older stt-v2 unchanged)', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['text', 'legacy entry', 'start_time', '0', 'end_time', '1', 'is_final', '1']],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect('utteranceIndex' in result).toBe(false);
            expect('resultType' in result).toBe(false);
        });

        it('ignores malformed utterance_index and unknown type values', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', [
                            'type', 'banana',
                            'text', 'junk wire fields',
                            'utterance_index', 'not-a-number',
                            'start_time', '0',
                            'end_time', '1',
                            'is_final', '0',
                        ]],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect('utteranceIndex' in result).toBe(false);
            expect('resultType' in result).toBe(false);
        });

        it('should handle isFinal=0 as false', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['text', 'partial', 'start_time', '0', 'end_time', '0.5', 'is_final', '0']],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result.isFinal).toBe(false);
        });

        it('should handle missing fields with defaults', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['is_final', '1']],
                    ]],
                ])
                .mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const result = await firstValueFrom(obs.pipe(take(1)));

            expect(result.text).toBe('');
            expect(result.startTime).toBe(0);
            expect(result.endTime).toBe(0);
        });

        it('should complete when status=closed is received', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['type', 'status', 'status', 'closed']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            const results = await lastValueFrom(obs.pipe(toArray()));

            // No transcript segments emitted, just completed
            expect(results).toHaveLength(0);
        });

        it('should complete when status=finalizing is received', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['type', 'status', 'status', 'finalizing']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            const results = await lastValueFrom(obs.pipe(toArray()));

            expect(results).toHaveLength(0);
        });

        it('should skip non-terminal status entries', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['type', 'status', 'status', 'processing']],
                        ['2-0', ['text', 'hello', 'start_time', '0', 'end_time', '1', 'is_final', '1']],
                    ]],
                ])
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['3-0', ['type', 'status', 'status', 'closed']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            const results = await lastValueFrom(obs.pipe(toArray()));

            expect(results).toHaveLength(1);
            expect(results[0].text).toBe('hello');
        });

        // TASK-457 C3-01 — the reader is a CONSUMER GROUP now. It creates the
        // group (MKSTREAM) and reads via XREADGROUP; it NEVER re-reads the whole
        // stream from '0-0' (the old duplicate-flood bug). BLOCK stays 500ms
        // (TASK-351 P1-3) so an unsubscribe/abort is honored within ≤500ms.
        it('creates a consumer group and reads via XREADGROUP — never XREAD from 0-0 (TASK-457 C3-01)', async () => {
            mockXreadgroup.mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const sub = obs.subscribe({ next: () => {} });

            await vi.waitFor(() => {
                expect(mockXgroup).toHaveBeenCalled();
                expect(mockXreadgroup).toHaveBeenCalled();
            });

            // Group created (MKSTREAM) at '0' on the per-session result stream.
            expect(mockXgroup).toHaveBeenCalledWith('CREATE', 'stt:result:s-1', expect.any(String), '0', 'MKSTREAM');

            // First read drains our own pending (PEL, id '0'); COUNT before BLOCK.
            expect(mockXreadgroup).toHaveBeenCalledWith(
                'GROUP',
                expect.stringContaining('stt-bridge'),
                expect.stringContaining('reader-'),
                'COUNT',
                100,
                'BLOCK',
                500,
                'STREAMS',
                'stt:result:s-1',
                '0',
            );
            // The bug is gone: no read ever seeds from the legacy '0-0' full re-read.
            const reReadsFromZero = mockXreadgroup.mock.calls.some((c) => c[c.length - 1] === '0-0');
            expect(reReadsFromZero).toBe(false);

            sub.unsubscribe();
        });

        it('advances via the group cursor: reads live (">") after the PEL and XACKs processed results (TASK-457)', async () => {
            mockXreadgroup
                .mockResolvedValueOnce([
                    // PEL drain (id '0') delivers one buffered result …
                    ['stt:result:s-1', [
                        ['100-1', ['text', 'first', 'start_time', '0', 'end_time', '1', 'is_final', '1']],
                    ]],
                ])
                .mockResolvedValueOnce(null) // … PEL now empty → switch to '>'
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['200-1', ['type', 'status', 'status', 'closed']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            await lastValueFrom(obs.pipe(toArray()));

            // At-least-once: the processed entry is XACK'd (the group cursor —
            // Redis-owned — is the persisted seed, replacing per-read lastId).
            expect(mockXack).toHaveBeenCalledWith('stt:result:s-1', expect.any(String), '100-1');
            // Subsequent reads are LIVE ('>'), not a per-entry id re-read.
            expect(mockXreadgroup).toHaveBeenCalledWith(
                'GROUP',
                expect.any(String),
                expect.any(String),
                'COUNT',
                100,
                'BLOCK',
                500,
                'STREAMS',
                'stt:result:s-1',
                '>',
            );
        });

        it('reclaims a dead reader\'s idle pending results via XAUTOCLAIM (TASK-457 dead-consumer hand-off)', async () => {
            // A prior reader crashed holding one unacked result; XAUTOCLAIM
            // hands it to this reader, which emits + acks it.
            mockXautoclaim.mockResolvedValueOnce([
                '0-0',
                [['50-0', ['text', 'orphaned', 'start_time', '0', 'end_time', '1', 'is_final', '1']]],
                [],
            ]);
            mockXreadgroup.mockResolvedValue(null);

            const obs = service.subscribeToResults('s-1');
            const first = await firstValueFrom(obs.pipe(take(1)));

            expect(first.text).toBe('orphaned');
            expect(mockXautoclaim).toHaveBeenCalled();
            expect(mockXack).toHaveBeenCalledWith('stt:result:s-1', expect.any(String), '50-0');
        });

        it('resumes from the persisted group cursor when a stable consumerGroup is reused (no 0-0 re-read)', async () => {
            mockXreadgroup.mockResolvedValue(null);

            // First subscription (captions role) creates the group.
            const sub1 = service.subscribeToResults('s-1', { consumerGroup: 'captions' }).subscribe({ next: () => {} });
            await vi.waitFor(() => expect(mockXgroup).toHaveBeenCalled());
            expect(mockXgroup).toHaveBeenCalledWith('CREATE', 'stt:result:s-1', 'captions', '0', 'MKSTREAM');
            sub1.unsubscribe();

            mockXreadgroup.mockClear();
            // A reconnect reuses the SAME stable group → resumes from its cursor
            // via '>' (Redis returns BUSYGROUP on create; no full re-read).
            const sub2 = service.subscribeToResults('s-1', { consumerGroup: 'captions' }).subscribe({ next: () => {} });
            await vi.waitFor(() => expect(mockXreadgroup).toHaveBeenCalled());
            expect(mockXreadgroup.mock.calls.every((c) => c[1] === 'captions')).toBe(true);
            const reReadsFromZero = mockXreadgroup.mock.calls.some((c) => c[c.length - 1] === '0-0');
            expect(reReadsFromZero).toBe(false);
            sub2.unsubscribe();
        });
    });

    // ===================================================================
    // TASK-351 P1-3 (H5) — per-subscriber reader connections
    //
    // The old implementation funneled every session's blocking XREAD
    // through ONE shared ioredis connection, serializing all result reads
    // behind whichever session blocked first (up to BLOCK ms each cycle).
    // Each subscriber now gets its own reader connection, quit on teardown.
    // ===================================================================

    describe('TASK-351 P1-3 (H5) — per-subscriber reader connections', () => {
        beforeEach(async () => {
            await service.connect();
        });

        afterEach(() => {
            mockXreadgroup.mockReset();
            mockXreadgroup.mockResolvedValue(null);
        });

        it('issues concurrent XREADs on distinct connections (no serialization on one blocked read)', async () => {
            // Block every XREAD until the test releases it — on a single
            // shared connection a real Redis would serialize the second
            // session's read behind the first blocked one.
            const resolvers: Array<(v: null) => void> = [];
            mockXreadgroup.mockImplementation(() => new Promise<null>((resolve) => resolvers.push(resolve)));

            const subA = service.subscribeToResults('s-A').subscribe({ next: () => {} });
            const subB = service.subscribeToResults('s-B').subscribe({ next: () => {} });

            await vi.waitFor(() => {
                const readers = mockRedisInstances.filter((i) => i.xreadgroup.mock.calls.length > 0);
                expect(readers.length).toBeGreaterThanOrEqual(2);
            });

            service.unsubscribeFromResults('s-A');
            service.unsubscribeFromResults('s-B');
            resolvers.forEach((resolve) => resolve(null));
            subA.unsubscribe();
            subB.unsubscribe();
        });

        it('quits the per-subscriber reader connection on teardown (no connection leak)', async () => {
            mockXreadgroup.mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 5)));

            const sub = service.subscribeToResults('s-leak').subscribe({ next: () => {} });
            await vi.waitFor(() => {
                expect(mockRedisInstances.some((i) => i.xreadgroup.mock.calls.length > 0)).toBe(true);
            });
            const reader = mockRedisInstances.find((i) => i.xreadgroup.mock.calls.length > 0)!;

            service.unsubscribeFromResults('s-leak');

            await vi.waitFor(() => {
                expect(reader.quit).toHaveBeenCalled();
            });
            sub.unsubscribe();
        });

        it('TASK-457 C1 — disconnects the reader IMMEDIATELY on unsubscribe (dead reader stops consuming the shared group at once)', async () => {
            // A read that never resolves — only a forced disconnect interrupts it.
            mockXreadgroup.mockImplementation(() => new Promise<null>(() => {}));

            const sub = service.subscribeToResults('s-c1', { consumerGroup: 'captions' }).subscribe({ next: () => {} });
            await vi.waitFor(() => {
                expect(mockRedisInstances.some((i) => i.xreadgroup.mock.calls.length > 0)).toBe(true);
            });
            const reader = mockRedisInstances.find((i) => i.xreadgroup.mock.calls.length > 0)!;

            expect(reader.disconnect).not.toHaveBeenCalled();
            sub.unsubscribe();
            // Not after a BLOCK window — right now, so it can't drain-and-ACK the
            // shared captions group for a dead client.
            expect(reader.disconnect).toHaveBeenCalled();
        });

        it('honors unsubscribe within one BLOCK window (abort ≤ 500ms)', async () => {
            // Each blocked read returns after 50ms — the abort must take
            // effect right after the in-flight read returns, never later.
            mockXreadgroup.mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 50)));
            let completed = false;
            const sub = service.subscribeToResults('s-abort').subscribe({
                complete: () => {
                    completed = true;
                },
            });

            await vi.waitFor(() => {
                expect(mockXreadgroup).toHaveBeenCalled();
            });
            service.unsubscribeFromResults('s-abort');

            await new Promise((r) => setTimeout(r, 120));
            expect(completed).toBe(true);

            const callsAfter = mockXreadgroup.mock.calls.length;
            await new Promise((r) => setTimeout(r, 120));
            expect(mockXreadgroup.mock.calls.length).toBe(callsAfter);
            sub.unsubscribe();
        });
    });

    // ===================================================================
    // unsubscribeFromResults
    // ===================================================================

    describe('unsubscribeFromResults()', () => {
        beforeEach(async () => {
            await service.connect();
        });

        it('should abort the subscription for the given sessionId', () => {
            const obs = service.subscribeToResults('s-1');
            const sub = obs.subscribe({ next: () => {} });

            service.unsubscribeFromResults('s-1');

            // Subscription should be cleaned up
            sub.unsubscribe();
        });

        it('should be safe to call for non-existent sessionId', () => {
            // Should not throw
            service.unsubscribeFromResults('non-existent');
        });

        it('should not affect other sessions', () => {
            const obs1 = service.subscribeToResults('s-1');
            const obs2 = service.subscribeToResults('s-2');
            const sub1 = obs1.subscribe({ next: () => {} });
            const sub2 = obs2.subscribe({ next: () => {} });

            service.unsubscribeFromResults('s-1');

            // s-2 should still be active (no error on unsubscribe)
            sub1.unsubscribe();
            sub2.unsubscribe();
        });
    });

    // ===================================================================
    // Shared-session teardown (TASK-340 P1-B)
    //
    // The captions WS gateway AND LiveDocumentationService both subscribe to
    // the SAME stt:result:{sessionId}. The old impl keyed activeSubscriptions
    // by sessionId, so the 2nd subscribe overwrote the 1st and a single
    // teardown aborted only one reader loop — leaking the other.
    // ===================================================================

    describe('shared-session teardown (two subscribers, one sessionId)', () => {
        beforeEach(async () => {
            await service.connect();
            // Both readers block on XREAD (null = timeout); the delay yields a
            // macrotask each loop so the abort + assertions can interleave.
            mockXreadgroup.mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 5)));
        });

        afterEach(() => {
            mockXreadgroup.mockReset();
            mockXreadgroup.mockResolvedValue(null);
        });

        it('aborts every reader for a session on unsubscribeFromResults (no leaked reader)', async () => {
            const completed = { a: false, b: false };
            const subA = service.subscribeToResults('shared').subscribe({ complete: () => { completed.a = true; } });
            const subB = service.subscribeToResults('shared').subscribe({ complete: () => { completed.b = true; } });

            // A single session-level teardown must abort BOTH readers.
            service.unsubscribeFromResults('shared');
            await new Promise((r) => setTimeout(r, 60));

            expect(completed.a).toBe(true);
            expect(completed.b).toBe(true);

            subA.unsubscribe();
            subB.unsubscribe();
        });

        it('explicit teardown still reaches remaining readers after one subscriber self-unsubscribes', async () => {
            const completed = { b: false };
            const subA = service.subscribeToResults('shared').subscribe({ next: () => {} });
            const subB = service.subscribeToResults('shared').subscribe({ complete: () => { completed.b = true; } });

            // A leaves on its own first; this must NOT orphan B from a later
            // session-level teardown (old impl deleted the shared map entry here).
            subA.unsubscribe();
            await new Promise((r) => setTimeout(r, 20));

            service.unsubscribeFromResults('shared');
            await new Promise((r) => setTimeout(r, 60));

            expect(completed.b).toBe(true);
        });
    });

    // ===================================================================
    // Error handling
    // ===================================================================

    describe('error handling', () => {
        beforeEach(async () => {
            await service.connect();
        });

        it('should retry XREAD on transient errors', async () => {
            mockXreadgroup
                .mockRejectedValueOnce(new Error('ECONNRESET'))
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['text', 'recovered', 'start_time', '0', 'end_time', '1', 'is_final', '1']],
                    ]],
                ])
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['2-0', ['type', 'status', 'status', 'closed']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            const results = await lastValueFrom(obs.pipe(toArray()));

            expect(results).toHaveLength(1);
            expect(results[0].text).toBe('recovered');
        });

        it('should not emit on XREAD null result (timeout)', async () => {
            let emitCount = 0;

            mockXreadgroup
                .mockResolvedValueOnce(null) // timeout
                .mockResolvedValueOnce(null) // timeout
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['1-0', ['type', 'status', 'status', 'closed']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            const results = await lastValueFrom(obs.pipe(toArray()));

            expect(results).toHaveLength(0);
        });
    });
});
