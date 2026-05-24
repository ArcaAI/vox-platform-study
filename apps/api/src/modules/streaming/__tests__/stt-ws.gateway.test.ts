import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESUME_BUFFER_SIZE, SttWsGateway, WS_CLOSE_CODES } from '../stt-ws.gateway';

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

const createMockStreamTicketService = () => ({
    issueTicket: vi.fn(),
    consumeTicket: vi.fn().mockImplementation(async (ticket: string) => {
        // Default: any non-empty ticket consumes successfully with the
        // session-scoped scope. Tests override this behaviour as needed.
        if (!ticket) return null;
        return {
            userId: 'user-123',
            tenantId: 'tenant-abc',
            scope: 'stt_session:default',
            exp: Date.now() + 30_000,
            impersonatedBy: null,
        };
    }),
});

// Helper — build a request URL with both sessionId and ticket so the new
// auth gate accepts the connection.
const buildReq = (sessionId: string, ticket = 'valid-ticket'): { url: string } => ({
    url: `/ws/stt-v2/stream?sessionId=${sessionId}&ticket=${ticket}`,
});

describe('SttWsGateway', () => {
    let gateway: SttWsGateway;
    let mockSessionService: ReturnType<typeof createMockSessionService>;
    let mockBridgeService: ReturnType<typeof createMockBridgeService>;
    let mockStreamTicketService: ReturnType<typeof createMockStreamTicketService>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSessionService = createMockSessionService();
        mockBridgeService = createMockBridgeService();
        mockStreamTicketService = createMockStreamTicketService();
        // Make consumeTicket return a scope matching whatever sessionId the
        // caller used — see `buildReq` above. By default we look at the URL
        // the calling test built and synthesize a matching scope.
        mockStreamTicketService.consumeTicket.mockImplementation(async (ticket: string) => {
            if (!ticket || ticket === 'invalid') return null;
            return {
                userId: 'user-123',
                tenantId: 'tenant-abc',
                // Stored scope is filled by the per-test override; default
                // here matches any session id used by tests below.
                scope: (ticket as string).startsWith('scope:') ? (ticket as string).slice('scope:'.length) : 'stt_session:__any__',
                exp: Date.now() + 30_000,
                impersonatedBy: null,
            };
        });

        gateway = new SttWsGateway(
            mockSessionService as any,
            mockBridgeService as any,
            mockStreamTicketService as any,
        );
        vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
        vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    });

    /**
     * Helper that wires the ticket service to return a scope that exactly
     * matches the sessionId the test uses, so the gateway accepts the
     * connection. Tests that want to test auth failures should NOT call this.
     */
    const setValidTicketFor = (sessionId: string) => {
        mockStreamTicketService.consumeTicket.mockImplementationOnce(async () => ({
            userId: 'user-123',
            tenantId: 'tenant-abc',
            scope: `stt_session:${sessionId}`,
            exp: Date.now() + 30_000,
            impersonatedBy: null,
        }));
    };

    describe('handleConnection', () => {
        it('should accept connection with valid sessionId AND ticket query params', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-123');
            await gateway.handleConnection(client as any, buildReq('sess-123') as any);

            expect(client.close).not.toHaveBeenCalled();
            expect(mockStreamTicketService.consumeTicket).toHaveBeenCalledWith('valid-ticket');
        });

        it('should reject connection without sessionId (TASK-298 D-1)', async () => {
            const client = createMockSocket();
            await gateway.handleConnection(client as any, { url: '/ws/stt-v2/stream' } as any);

            expect(client.close).toHaveBeenCalledWith(
                WS_CLOSE_CODES.MISSING_PARAM,
                expect.stringContaining('sessionId'),
            );
            expect(mockStreamTicketService.consumeTicket).not.toHaveBeenCalled();
        });

        it('should reject connection without ticket (TASK-298 D-1)', async () => {
            const client = createMockSocket();
            await gateway.handleConnection(client as any, { url: '/ws/stt-v2/stream?sessionId=foo' } as any);

            expect(client.close).toHaveBeenCalledWith(
                WS_CLOSE_CODES.MISSING_PARAM,
                expect.stringContaining('ticket'),
            );
            expect(mockStreamTicketService.consumeTicket).not.toHaveBeenCalled();
        });

        it('should reject connection with invalid ticket using close code 4401 (TASK-298 D-1)', async () => {
            const client = createMockSocket();
            mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);

            await gateway.handleConnection(
                client as any,
                { url: '/ws/stt-v2/stream?sessionId=sess-x&ticket=invalid' } as any,
            );

            expect(client.close).toHaveBeenCalledWith(
                WS_CLOSE_CODES.AUTH_FAILED,
                expect.stringContaining('Invalid'),
            );
            expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
        });

        it('should reject connection when ticket scope does not match sessionId (TASK-298 D-1)', async () => {
            const client = createMockSocket();
            mockStreamTicketService.consumeTicket.mockResolvedValueOnce({
                userId: 'u-1',
                tenantId: 't-1',
                scope: 'stt_session:OTHER_SESSION',
                exp: Date.now() + 30_000,
                impersonatedBy: null,
            });

            await gateway.handleConnection(
                client as any,
                { url: '/ws/stt-v2/stream?sessionId=sess-x&ticket=t' } as any,
            );

            expect(client.close).toHaveBeenCalledWith(
                WS_CLOSE_CODES.AUTH_FAILED,
                expect.stringContaining('scope'),
            );
            expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
        });

        it('subscribes to bridge results only after ticket consumption succeeds (TASK-298 D-1)', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-sub');
            await gateway.handleConnection(client as any, buildReq('sess-sub') as any);

            expect(mockStreamTicketService.consumeTicket).toHaveBeenCalledBefore(
                mockBridgeService.subscribeToResults as any,
            );
            expect(mockBridgeService.subscribeToResults).toHaveBeenCalledWith('sess-sub');
        });
    });

    describe('handleDisconnect', () => {
        it('should clean up session state on disconnect', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-456');
            await gateway.handleConnection(client as any, buildReq('sess-456') as any);
            gateway.handleDisconnect(client as any);

            expect(gateway.getActiveSessionCount()).toBe(0);
        });

        it('should unsubscribe from bridge results on disconnect', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-789');
            await gateway.handleConnection(client as any, buildReq('sess-789') as any);
            gateway.handleDisconnect(client as any);

            expect(mockBridgeService.unsubscribeFromResults).toHaveBeenCalledWith('sess-789');
        });
    });

    describe('handleMessage', () => {
        it('should forward JSON audio frame to bridge service', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-audio');
            await gateway.handleConnection(client as any, buildReq('sess-audio') as any);

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
            setValidTicketFor('sess-stop');
            await gateway.handleConnection(client as any, buildReq('sess-stop') as any);

            await gateway.handleMessage(client as any, JSON.stringify({ type: 'stop' }));

            expect(mockBridgeService.writeControlCommand).toHaveBeenCalledWith(
                'sess-stop',
                'finalize',
            );
        });

        it('should handle close message by removing session and closing socket', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-close');
            await gateway.handleConnection(client as any, buildReq('sess-close') as any);

            await gateway.handleMessage(client as any, JSON.stringify({ type: 'close' }));

            expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-close');
            expect(gateway.getActiveSessionCount()).toBe(0);
        });

        it('should send error to client for unknown message type', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-err');
            await gateway.handleConnection(client as any, buildReq('sess-err') as any);

            await gateway.handleMessage(client as any, JSON.stringify({ type: 'unknown' }));

            expect(client.send).toHaveBeenCalledWith(
                expect.stringContaining('"type":"error"'),
            );
        });

        it('should send error for malformed JSON', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-json');
            await gateway.handleConnection(client as any, buildReq('sess-json') as any);

            await gateway.handleMessage(client as any, 'not-json');

            expect(client.send).toHaveBeenCalledWith(
                expect.stringContaining('"type":"error"'),
            );
        });

        it('should forward binary audio frames to bridge service', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-bin');
            await gateway.handleConnection(client as any, buildReq('sess-bin') as any);

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

        it('should track multiple active sessions', async () => {
            const client1 = createMockSocket();
            const client2 = createMockSocket();
            setValidTicketFor('sess-a');
            setValidTicketFor('sess-b');

            await gateway.handleConnection(client1 as any, buildReq('sess-a') as any);
            await gateway.handleConnection(client2 as any, buildReq('sess-b') as any);

            expect(gateway.getActiveSessionCount()).toBe(2);
        });
    });

    describe('result forwarding + sequencing (TASK-298 D-17)', () => {
        it('subscribes to bridge results and forwards transcripts to client, tagged with server seq', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-fwd');
            await gateway.handleConnection(client as any, buildReq('sess-fwd') as any);

            resultSubject.next({
                type: 'transcript',
                text: 'Hello world',
                startTime: 0.0,
                endTime: 1.5,
                isFinal: true,
            });
            resultSubject.next({
                type: 'transcript',
                text: 'Second',
                startTime: 1.5,
                endTime: 3.0,
                isFinal: true,
            });

            expect(client.send).toHaveBeenCalledTimes(2);
            const first = JSON.parse((client.send as any).mock.calls[0][0]);
            const second = JSON.parse((client.send as any).mock.calls[1][0]);
            expect(first.text).toBe('Hello world');
            expect(first.seq).toBe(1);
            expect(second.seq).toBe(2);
        });

        it('handles resume handshake by replaying buffered transcripts after lastSeq', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-resume');
            await gateway.handleConnection(client as any, buildReq('sess-resume') as any);

            // Emit 3 transcripts (seq 1, 2, 3).
            for (let i = 1; i <= 3; i++) {
                resultSubject.next({
                    type: 'transcript',
                    text: `t${i}`,
                    startTime: i,
                    endTime: i + 1,
                    isFinal: true,
                });
            }
            (client.send as any).mockClear();

            // Client resumes with lastSeq=1 → replay seq 2 and 3 only.
            await gateway.handleMessage(
                client as any,
                JSON.stringify({ type: 'resume', sessionId: 'sess-resume', lastSeq: 1 }),
            );

            const calls = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
            expect(calls[0].type).toBe('resumed');
            expect(calls.slice(1).map((c: any) => c.text)).toEqual(['t2', 't3']);
            expect(calls.slice(1).map((c: any) => c.seq)).toEqual([2, 3]);
        });

        it('responds with resume_failed when lastSeq falls outside the bounded buffer', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-overflow');
            await gateway.handleConnection(client as any, buildReq('sess-overflow') as any);

            // Push RESUME_BUFFER_SIZE + 5 transcripts so the oldest fall out.
            for (let i = 1; i <= RESUME_BUFFER_SIZE + 5; i++) {
                resultSubject.next({
                    type: 'transcript',
                    text: `t${i}`,
                    startTime: i,
                    endTime: i + 1,
                    isFinal: true,
                });
            }
            (client.send as any).mockClear();

            // lastSeq=2 is before the oldest still-buffered seq.
            await gateway.handleMessage(
                client as any,
                JSON.stringify({ type: 'resume', sessionId: 'sess-overflow', lastSeq: 2 }),
            );

            const replyCalls = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
            expect(replyCalls[0].type).toBe('resume_failed');
            expect(replyCalls[0].reason).toBe('buffer_overflow');
            expect(typeof replyCalls[0].minAvailableSeq).toBe('number');
        });

        it('responds with resume_failed when sessionId mismatches', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-mismatch');
            await gateway.handleConnection(client as any, buildReq('sess-mismatch') as any);

            await gateway.handleMessage(
                client as any,
                JSON.stringify({ type: 'resume', sessionId: 'OTHER', lastSeq: 0 }),
            );

            const replyCalls = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
            const failed = replyCalls.find((c: any) => c.type === 'resume_failed');
            expect(failed).toBeDefined();
            expect(failed.reason).toBe('unknown_session');
        });
    });
});
