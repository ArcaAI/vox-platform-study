import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttWsGateway } from '../stt-ws.gateway';

const createMockSocket = (overrides: Partial<WebSocket> = {}) => ({
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    readyState: 1,
    OPEN: 1,
    ...overrides,
});

const createMockSessionService = () => ({
    getSessionStatus: vi.fn(),
    removeSession: vi.fn().mockResolvedValue(undefined),
});

const createMockBridgeService = () => ({
    connect: vi.fn(),
    writeAudioFrame: vi.fn(),
    writeControlCommand: vi.fn(),
    subscribeToResults: vi.fn().mockReturnValue(new Subject().asObservable()),
    unsubscribeFromResults: vi.fn(),
});

describe('SttWsGateway', () => {
    let gateway: SttWsGateway;
    let mockSessionService: ReturnType<typeof createMockSessionService>;
    let mockBridgeService: ReturnType<typeof createMockBridgeService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSessionService = createMockSessionService();
        mockBridgeService = createMockBridgeService();
        gateway = new SttWsGateway(
            mockSessionService as any,
            mockBridgeService as any,
        );
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
        vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    });

    describe('handleConnection', () => {
        it('should accept connection with valid sessionId query param', () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-123' };

            gateway.handleConnection(client as any, req as any);

            expect(client.close).not.toHaveBeenCalled();
        });

        it('should reject connection without sessionId', () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream' };

            gateway.handleConnection(client as any, req as any);

            expect(client.close).toHaveBeenCalledWith(
                4001,
                expect.stringContaining('sessionId'),
            );
        });

        it('should reject connection with empty sessionId', () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=' };

            gateway.handleConnection(client as any, req as any);

            expect(client.close).toHaveBeenCalledWith(
                4001,
                expect.stringContaining('sessionId'),
            );
        });

        it('should subscribe to bridge results on connection', () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-sub' };

            gateway.handleConnection(client as any, req as any);

            expect(mockBridgeService.subscribeToResults).toHaveBeenCalledWith('sess-sub');
        });
    });

    describe('handleDisconnect', () => {
        it('should clean up session state on disconnect', () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-456' };

            gateway.handleConnection(client as any, req as any);
            gateway.handleDisconnect(client as any);

            expect(gateway.getActiveSessionCount()).toBe(0);
        });

        it('should unsubscribe from bridge results on disconnect', () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-789' };

            gateway.handleConnection(client as any, req as any);
            gateway.handleDisconnect(client as any);

            expect(mockBridgeService.unsubscribeFromResults).toHaveBeenCalledWith('sess-789');
        });
    });

    describe('handleMessage', () => {
        it('should forward JSON audio frame to bridge service', async () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-audio' };
            gateway.handleConnection(client as any, req as any);

            const audioMsg = JSON.stringify({
                type: 'audio',
                seq: 1,
                data: 'base64audiodata',
            });

            await gateway.handleMessage(client as any, audioMsg);

            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-audio',
                1,
                expect.any(Buffer),
                16000,
                'pcm_s16le',
                false,
            );
        });

        it('should handle stop message by sending finalize control command', async () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-stop' };
            gateway.handleConnection(client as any, req as any);

            await gateway.handleMessage(client as any, JSON.stringify({ type: 'stop' }));

            expect(mockBridgeService.writeControlCommand).toHaveBeenCalledWith(
                'sess-stop',
                'finalize',
            );
        });

        it('should handle close message by removing session and closing socket', async () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-close' };
            gateway.handleConnection(client as any, req as any);

            await gateway.handleMessage(client as any, JSON.stringify({ type: 'close' }));

            expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-close');
            expect(gateway.getActiveSessionCount()).toBe(0);
        });

        it('should send error to client for unknown message type', async () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-err' };
            gateway.handleConnection(client as any, req as any);

            await gateway.handleMessage(client as any, JSON.stringify({ type: 'unknown' }));

            expect(client.send).toHaveBeenCalledWith(
                expect.stringContaining('"type":"error"'),
            );
        });

        it('should send error for malformed JSON', async () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-json' };
            gateway.handleConnection(client as any, req as any);

            await gateway.handleMessage(client as any, 'not-json');

            expect(client.send).toHaveBeenCalledWith(
                expect.stringContaining('"type":"error"'),
            );
        });

        it('should forward binary audio frames to bridge service', async () => {
            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-bin' };
            gateway.handleConnection(client as any, req as any);

            const binaryData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
            await gateway.handleMessage(client as any, binaryData as any);

            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-bin',
                expect.any(Number),
                binaryData,
                16000,
                'pcm_s16le',
                false,
            );
        });
    });

    describe('getActiveSessionCount', () => {
        it('should return 0 when no sessions are active', () => {
            expect(gateway.getActiveSessionCount()).toBe(0);
        });

        it('should track multiple active sessions', () => {
            const client1 = createMockSocket();
            const client2 = createMockSocket();
            const req1 = { url: '/ws/stt-v2/stream?sessionId=sess-a' };
            const req2 = { url: '/ws/stt-v2/stream?sessionId=sess-b' };

            gateway.handleConnection(client1 as any, req1 as any);
            gateway.handleConnection(client2 as any, req2 as any);

            expect(gateway.getActiveSessionCount()).toBe(2);
        });
    });

    describe('result forwarding', () => {
        it('should subscribe to bridge results and forward transcripts to client', () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            const req = { url: '/ws/stt-v2/stream?sessionId=sess-fwd' };
            gateway.handleConnection(client as any, req as any);

            resultSubject.next({
                type: 'transcript',
                text: 'Hello world',
                startTime: 0.0,
                endTime: 1.5,
                isFinal: true,
            });

            expect(client.send).toHaveBeenCalledWith(
                expect.stringContaining('"text":"Hello world"'),
            );
        });
    });
});
