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
const mockXread = vi.fn().mockResolvedValue(null);
const mockQuit = vi.fn().mockResolvedValue('OK');

/**
 * Create a mock Redis constructor that returns an object with our mock methods.
 * We need a real constructor function (not an arrow function) so `new Redis()`
 * works correctly in both threads and forks pool modes.
 */
function MockRedis() {
    return {
        xadd: mockXadd,
        xread: mockXread,
        quit: mockQuit,
    };
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
            mockXread
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
            mockXread
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
            mockXread
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

        it('should handle isFinal=0 as false', async () => {
            mockXread
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
            mockXread
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
            mockXread
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
            mockXread
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
            mockXread
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

        it('should use XREAD with COUNT 100 and BLOCK 2000 (COUNT before BLOCK per ioredis types)', async () => {
            mockXread.mockResolvedValueOnce(null);

            const obs = service.subscribeToResults('s-1');
            const sub = obs.subscribe({ next: () => {} });

            // Wait for the first XREAD call
            await vi.waitFor(() => {
                expect(mockXread).toHaveBeenCalled();
            });

            expect(mockXread).toHaveBeenCalledWith(
                'COUNT', 100,
                'BLOCK', 2000,
                'STREAMS', 'stt:result:s-1', '0-0',
            );

            sub.unsubscribe();
        });

        it('should track lastId for subsequent reads', async () => {
            mockXread
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['100-1', ['text', 'first', 'start_time', '0', 'end_time', '1', 'is_final', '1']],
                    ]],
                ])
                .mockResolvedValueOnce([
                    ['stt:result:s-1', [
                        ['200-1', ['type', 'status', 'status', 'closed']],
                    ]],
                ]);

            const obs = service.subscribeToResults('s-1');
            await lastValueFrom(obs.pipe(toArray()));

            // Second XREAD should use lastId from first result
            expect(mockXread).toHaveBeenCalledWith(
                'COUNT', 100,
                'BLOCK', 2000,
                'STREAMS', 'stt:result:s-1', '100-1',
            );
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
            mockXread.mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 5)));
        });

        afterEach(() => {
            mockXread.mockReset();
            mockXread.mockResolvedValue(null);
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
            mockXread
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

            mockXread
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
