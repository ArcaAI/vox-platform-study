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
    // The real methods are async — the mocks must return promises because the
    // gateway chains `.catch()` on the (fire-and-forget) frame writes.
    writeAudioFrame: vi.fn().mockResolvedValue(undefined),
    writeControlCommand: vi.fn().mockResolvedValue(undefined),
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

// TASK-351 P0-2 (C5) — the gateway reads the session-negotiated sampleRate
// from the session meta written by `createStreamSession`. Default: no meta
// bound → gateway falls back to 16000.
const createMockSessionBinding = () => ({
    bind: vi.fn().mockResolvedValue(undefined),
    bindSessionMeta: vi.fn().mockResolvedValue(undefined),
    lookup: vi.fn().mockResolvedValue('tenant-abc'),
    lookupSessionMeta: vi.fn().mockResolvedValue(null),
    clear: vi.fn().mockResolvedValue(undefined),
});

// TASK-351 P1-3 (M6 part 2) — parks session ids whose upstream removal
// failed on disconnect so they can be retried with backoff.
const createMockRemovalRetry = () => ({
    enqueue: vi.fn(),
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
    let mockSessionBinding: ReturnType<typeof createMockSessionBinding>;
    let mockRemovalRetry: ReturnType<typeof createMockRemovalRetry>;

    beforeEach(() => {
        vi.clearAllMocks();
        mockSessionService = createMockSessionService();
        mockBridgeService = createMockBridgeService();
        mockStreamTicketService = createMockStreamTicketService();
        mockSessionBinding = createMockSessionBinding();
        mockRemovalRetry = createMockRemovalRetry();
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
            mockSessionBinding as any,
            mockRemovalRetry as any,
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

        // TASK-307 W5.8 (AC-22, audit D-8) updated these from per-cause
        // (MISSING_PARAM / AUTH_FAILED with descriptive reasons) to the
        // single generic 4401 + "Authentication failed". The per-cause
        // truth table now lives in the W5.8 describe block below.
        it('should reject connection without sessionId (TASK-298 D-1, retuned by W5.8)', async () => {
            const client = createMockSocket();
            await gateway.handleConnection(client as any, { url: '/ws/stt-v2/stream' } as any);

            expect(client.close).toHaveBeenCalledWith(
                WS_CLOSE_CODES.AUTH_FAILED,
                'Authentication failed',
            );
            expect(mockStreamTicketService.consumeTicket).not.toHaveBeenCalled();
        });

        it('should reject connection without ticket (TASK-298 D-1, retuned by W5.8)', async () => {
            const client = createMockSocket();
            await gateway.handleConnection(client as any, { url: '/ws/stt-v2/stream?sessionId=foo' } as any);

            expect(client.close).toHaveBeenCalledWith(
                WS_CLOSE_CODES.AUTH_FAILED,
                'Authentication failed',
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
                'Authentication failed',
            );
            expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
        });

        it('should reject connection when ticket scope does not match sessionId (TASK-298 D-1, retuned by W5.8)', async () => {
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
                'Authentication failed',
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

        // TASK-307 W5.8 (AC-22, audit D-8) — every handshake-rejection
        // path must close with the SAME generic code (4401) and the same
        // constant reason, regardless of cause. Differentiating
        // `4001 missing param` from `4401 invalid ticket` lets a probing
        // client enumerate valid session ids. The real reason still
        // lives in the server-side warn log.
        describe('TASK-307 W5.8 — generic 4401 close code on EVERY handshake failure (AC-22, audit D-8)', () => {
            const GENERIC_CODE = 4401;
            const GENERIC_REASON_RE = /^Authentication failed$/;

            it('missing sessionId -> 4401 with the generic reason (no "sessionId" in the wire reason)', async () => {
                const client = createMockSocket();
                await gateway.handleConnection(client as any, { url: '/ws/stt-v2/stream' } as any);

                const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
                expect(code).toBe(GENERIC_CODE);
                expect(String(reason)).toMatch(GENERIC_REASON_RE);
            });

            it('missing ticket -> 4401 with the generic reason (no "ticket" in the wire reason)', async () => {
                const client = createMockSocket();
                await gateway.handleConnection(
                    client as any,
                    { url: '/ws/stt-v2/stream?sessionId=sess-x' } as any,
                );

                const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
                expect(code).toBe(GENERIC_CODE);
                expect(String(reason)).toMatch(GENERIC_REASON_RE);
            });

            it('invalid ticket -> 4401 (unchanged, but reason now generic, not "Invalid …")', async () => {
                const client = createMockSocket();
                mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);

                await gateway.handleConnection(
                    client as any,
                    { url: '/ws/stt-v2/stream?sessionId=sess-x&ticket=invalid' } as any,
                );

                const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
                expect(code).toBe(GENERIC_CODE);
                expect(String(reason)).toMatch(GENERIC_REASON_RE);
            });

            it('scope mismatch -> 4401 (unchanged code, but reason now generic, not "… scope …")', async () => {
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

                const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
                expect(code).toBe(GENERIC_CODE);
                expect(String(reason)).toMatch(GENERIC_REASON_RE);
            });

            it('all four rejection paths emit identical (code, reason) tuples (no enumeration signal)', async () => {
                const cases: Array<() => Promise<unknown>> = [
                    // missing sessionId
                    async () => {
                        const c = createMockSocket();
                        await gateway.handleConnection(c as any, { url: '/ws/stt-v2/stream' } as any);
                        return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
                    },
                    // missing ticket
                    async () => {
                        const c = createMockSocket();
                        await gateway.handleConnection(
                            c as any,
                            { url: '/ws/stt-v2/stream?sessionId=s' } as any,
                        );
                        return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
                    },
                    // invalid ticket
                    async () => {
                        mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);
                        const c = createMockSocket();
                        await gateway.handleConnection(
                            c as any,
                            { url: '/ws/stt-v2/stream?sessionId=s&ticket=invalid' } as any,
                        );
                        return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
                    },
                    // scope mismatch
                    async () => {
                        mockStreamTicketService.consumeTicket.mockResolvedValueOnce({
                            userId: 'u-1',
                            tenantId: 't-1',
                            scope: 'stt_session:OTHER',
                            exp: Date.now() + 30_000,
                            impersonatedBy: null,
                        });
                        const c = createMockSocket();
                        await gateway.handleConnection(
                            c as any,
                            { url: '/ws/stt-v2/stream?sessionId=s&ticket=t' } as any,
                        );
                        return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
                    },
                ];

                const tuples = await Promise.all(cases.map((fn) => fn()));
                const first = JSON.stringify(tuples[0]);
                for (const t of tuples) {
                    expect(JSON.stringify(t)).toBe(first);
                }
            });

            // TASK-450 C4-01 — the binding-mismatch rejection joins the same
            // generic-close truth table (no fifth distinguishable signal).
            it('session tenant-binding mismatch -> 4401 with the generic reason (no tenant id on the wire)', async () => {
                const client = createMockSocket();
                setValidTicketFor('sess-x');
                mockSessionBinding.lookup.mockResolvedValueOnce('tenant-OTHER');

                await gateway.handleConnection(
                    client as any,
                    { url: '/ws/stt-v2/stream?sessionId=sess-x&ticket=t' } as any,
                );

                const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
                expect(code).toBe(GENERIC_CODE);
                expect(String(reason)).toMatch(GENERIC_REASON_RE);
                expect(String(reason)).not.toMatch(/tenant/i);
            });

            it('server-side warn log STILL records the REAL reason for ops (observability preserved)', async () => {
                const warnSpy = vi.spyOn(Logger.prototype, 'warn');
                warnSpy.mockClear();

                const c1 = createMockSocket();
                await gateway.handleConnection(c1 as any, { url: '/ws/stt-v2/stream' } as any);

                mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);
                const c2 = createMockSocket();
                await gateway.handleConnection(
                    c2 as any,
                    { url: '/ws/stt-v2/stream?sessionId=s&ticket=bad' } as any,
                );

                // At least two distinct warn logs — one per cause — so SRE
                // dashboards can still tell apart "missing sessionId" from
                // "invalid ticket" even though the wire close is identical.
                const messages = warnSpy.mock.calls
                    .map((args) => (typeof args[0] === 'object' && args[0] !== null ? (args[0] as { message?: string }).message : String(args[0])))
                    .filter(Boolean);
                expect(messages.length).toBeGreaterThanOrEqual(2);
                expect(new Set(messages).size).toBeGreaterThanOrEqual(2);
            });
        });

        // TASK-450 C4-01 — a ticket whose SCOPE matches the sessionId but whose
        // tenant is NOT the session's owning tenant used to pass the handshake
        // (the gateway trusted `stored.tenantId` and never consulted the
        // gateway-side sessionId → tenantId binding). The handshake now mirrors
        // the DELETE route's `assertStreamSessionOwnership`: missing binding OR
        // binding ≠ ticket tenant both close with the same generic 4401.
        describe('TASK-450 C4-01 — session tenant binding enforced at the WS handshake', () => {
            it('consults the tenant binding for the sessionId and accepts when it matches the ticket tenant', async () => {
                const client = createMockSocket();
                setValidTicketFor('sess-450'); // ticket tenant: tenant-abc
                mockSessionBinding.lookup.mockResolvedValueOnce('tenant-abc');

                await gateway.handleConnection(client as any, buildReq('sess-450') as any);

                expect(mockSessionBinding.lookup).toHaveBeenCalledWith('sess-450');
                expect(client.close).not.toHaveBeenCalled();
                expect(gateway.getActiveSessionCount()).toBe(1);
            });

            it('rejects a matching-scope ticket carrying a FOREIGN tenant with the generic 4401 close', async () => {
                const client = createMockSocket();
                setValidTicketFor('sess-450'); // ticket tenant: tenant-abc
                mockSessionBinding.lookup.mockResolvedValueOnce('tenant-OTHER');

                await gateway.handleConnection(client as any, buildReq('sess-450') as any);

                expect(client.close).toHaveBeenCalledWith(
                    WS_CLOSE_CODES.AUTH_FAILED,
                    'Authentication failed',
                );
                expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
                expect(gateway.getActiveSessionCount()).toBe(0);
            });

            it('fail-closed: rejects when NO binding exists for the session (not just on mismatch)', async () => {
                const client = createMockSocket();
                setValidTicketFor('sess-450');
                mockSessionBinding.lookup.mockResolvedValueOnce(null);

                await gateway.handleConnection(client as any, buildReq('sess-450') as any);

                expect(client.close).toHaveBeenCalledWith(
                    WS_CLOSE_CODES.AUTH_FAILED,
                    'Authentication failed',
                );
                expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
                expect(gateway.getActiveSessionCount()).toBe(0);
            });

            it('fail-closed: rejects when the binding lookup throws (Redis blip is not an auth bypass)', async () => {
                const client = createMockSocket();
                setValidTicketFor('sess-450');
                mockSessionBinding.lookup.mockRejectedValueOnce(new Error('redis down'));

                await gateway.handleConnection(client as any, buildReq('sess-450') as any);

                expect(client.close).toHaveBeenCalledWith(
                    WS_CLOSE_CODES.AUTH_FAILED,
                    'Authentication failed',
                );
                expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
                expect(gateway.getActiveSessionCount()).toBe(0);
            });

            it('does not leak tenant values in the rejection warn log', async () => {
                const warnSpy = vi.spyOn(Logger.prototype, 'warn');
                warnSpy.mockClear();
                const client = createMockSocket();
                setValidTicketFor('sess-450');
                mockSessionBinding.lookup.mockResolvedValueOnce('tenant-OTHER');

                await gateway.handleConnection(client as any, buildReq('sess-450') as any);

                const serialized = JSON.stringify(warnSpy.mock.calls);
                expect(serialized).not.toContain('tenant-OTHER');
                expect(serialized).not.toContain('tenant-abc');
            });
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

        // TASK-351 P1-3 (M6 part 2) — a failed fire-and-forget removeSession
        // used to leave the Python session leaked until the 60s inactivity
        // reaper. The failure now parks the session id on a retry queue.
        it('enqueues a removal retry when the upstream removeSession fails on disconnect (TASK-351 P1-3 / M6)', async () => {
            mockSessionService.removeSession.mockRejectedValueOnce(new Error('stt-v2 down'));
            const client = createMockSocket();
            setValidTicketFor('sess-leak');
            await gateway.handleConnection(client as any, buildReq('sess-leak') as any);

            gateway.handleDisconnect(client as any);
            await new Promise((resolve) => setImmediate(resolve));

            expect(mockRemovalRetry.enqueue).toHaveBeenCalledWith('sess-leak');
        });

        it('does not enqueue a removal retry when removeSession succeeds on disconnect', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-clean');
            await gateway.handleConnection(client as any, buildReq('sess-clean') as any);

            gateway.handleDisconnect(client as any);
            await new Promise((resolve) => setImmediate(resolve));

            expect(mockRemovalRetry.enqueue).not.toHaveBeenCalled();
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
            await gateway.handleMessage(client as any, binaryData as any, true);

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

    // =========================================================================
    // TASK-467 — ws@8 control-channel frame classification.
    //
    // REGRESSION GUARD. ws@8 (breaking change from v7) hands the `message`
    // event BOTH text and binary frames as a Buffer, distinguished ONLY by its
    // second `isBinary` arg. The gateway previously split frames with
    // `Buffer.isBuffer(rawData)`, so every `{type:'stop'|'resume'|'close'}` TEXT
    // control frame was misclassified as binary audio and the JSON switch never
    // ran — client-driven finalize + the D-17 resume handshake were silent
    // no-ops over a real socket. These feed a control frame in its REAL wire
    // representation (a Buffer with isBinary=false) and assert the JSON control
    // path runs; the binary case (isBinary=true) still forwards audio.
    // =========================================================================
    describe('TASK-467 — ws@8 text control frames arrive as Buffer + isBinary=false', () => {
        /** ws@8 delivers a TEXT frame as a Buffer of its UTF-8 bytes. */
        const textFrame = (obj: unknown) => Buffer.from(JSON.stringify(obj));

        it('routes a stop TEXT frame (Buffer, isBinary=false) to finalize — not the audio path', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-txt-stop');
            await gateway.handleConnection(client as any, buildReq('sess-txt-stop') as any);

            await gateway.handleMessage(client as any, textFrame({ type: 'stop' }), false);

            expect(mockBridgeService.writeControlCommand).toHaveBeenCalledWith('sess-txt-stop', 'finalize');
            expect(mockBridgeService.writeAudioFrame).not.toHaveBeenCalled();
        });

        it('answers a resume TEXT frame (Buffer, isBinary=false) with resumed/resume_failed', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-txt-resume');
            await gateway.handleConnection(client as any, buildReq('sess-txt-resume') as any);

            await gateway.handleMessage(
                client as any,
                textFrame({ type: 'resume', sessionId: 'sess-txt-resume', lastSeq: 0 }),
                false,
            );

            const replies = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
            expect(replies.some((r: any) => r.type === 'resumed' || r.type === 'resume_failed')).toBe(true);
            expect(mockBridgeService.writeAudioFrame).not.toHaveBeenCalled();
        });

        it('routes a close TEXT frame (Buffer, isBinary=false) to session removal + socket close', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-txt-close');
            await gateway.handleConnection(client as any, buildReq('sess-txt-close') as any);

            await gateway.handleMessage(client as any, textFrame({ type: 'close' }), false);

            expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-txt-close');
            expect(client.close).toHaveBeenCalledWith(1000, 'Session closed by client');
        });

        it('reaches the JSON switch for an unknown TEXT frame → UNKNOWN_TYPE error', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-txt-unknown');
            await gateway.handleConnection(client as any, buildReq('sess-txt-unknown') as any);

            await gateway.handleMessage(client as any, textFrame({ type: '__probe__' }), false);

            expect(client.send).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN_TYPE'));
        });

        it('still forwards a binary audio frame (Buffer, isBinary=true) as audio, not JSON', async () => {
            const client = createMockSocket();
            setValidTicketFor('sess-txt-bin');
            await gateway.handleConnection(client as any, buildReq('sess-txt-bin') as any);

            const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
            await gateway.handleMessage(client as any, pcm, true);

            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-txt-bin',
                expect.any(Number),
                pcm,
                16000,
                'pcm_s16le',
                false,
            );
            expect(client.send).not.toHaveBeenCalledWith(expect.stringContaining('INVALID_JSON'));
        });
    });

    // =========================================================================
    // TASK-351 P0-2 — session-negotiated sampleRate (C5) + non-blocking audio
    // ingestion (C1).
    // =========================================================================
    describe('TASK-351 P0-2 — negotiated sampleRate + non-blocking ingestion', () => {
        it('forwards the session-negotiated sampleRate on binary frames (C5)', async () => {
            mockSessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 48000 });
            const client = createMockSocket();
            setValidTicketFor('sess-sr-bin');
            await gateway.handleConnection(client as any, buildReq('sess-sr-bin') as any);

            const binaryData = Buffer.from([0x01, 0x02]);
            await gateway.handleMessage(client as any, binaryData as any, true);

            expect(mockSessionBinding.lookupSessionMeta).toHaveBeenCalledWith('sess-sr-bin');
            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-sr-bin',
                expect.any(Number),
                binaryData,
                48000,
                'pcm_s16le',
                false,
            );
        });

        it('forwards the session-negotiated sampleRate on JSON audio frames (C5)', async () => {
            mockSessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 44100 });
            const client = createMockSocket();
            setValidTicketFor('sess-sr-json');
            await gateway.handleConnection(client as any, buildReq('sess-sr-json') as any);

            await gateway.handleMessage(
                client as any,
                JSON.stringify({ type: 'audio', seq: 7, data: 'YWJjZA==' }),
            );

            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-sr-json',
                7,
                expect.any(Buffer),
                44100,
                'pcm_s16le',
                false,
            );
        });

        it('defaults the sampleRate to 16000 when no session meta is bound', async () => {
            // Default mock: lookupSessionMeta → null.
            const client = createMockSocket();
            setValidTicketFor('sess-sr-default');
            await gateway.handleConnection(client as any, buildReq('sess-sr-default') as any);

            await gateway.handleMessage(client as any, Buffer.from([0x01]) as any, true);

            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-sr-default',
                expect.any(Number),
                expect.any(Buffer),
                16000,
                'pcm_s16le',
                false,
            );
        });

        it('still accepts the connection (sampleRate 16000) when the meta lookup throws', async () => {
            mockSessionBinding.lookupSessionMeta.mockRejectedValueOnce(new Error('redis blip'));
            const client = createMockSocket();
            setValidTicketFor('sess-sr-err');
            await gateway.handleConnection(client as any, buildReq('sess-sr-err') as any);

            expect(client.close).not.toHaveBeenCalled();

            await gateway.handleMessage(client as any, Buffer.from([0x01]) as any, true);

            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith(
                'sess-sr-err',
                expect.any(Number),
                expect.any(Buffer),
                16000,
                'pcm_s16le',
                false,
            );
        });

        it('does not block frame ingestion on the Redis ack (C1)', async () => {
            // The XADD never resolves — ingestion must complete regardless.
            mockBridgeService.writeAudioFrame.mockReturnValue(new Promise(() => {}));
            const client = createMockSocket();
            setValidTicketFor('sess-noblock');
            await gateway.handleConnection(client as any, buildReq('sess-noblock') as any);

            const outcome = await Promise.race([
                gateway.handleMessage(client as any, Buffer.from([0x01]) as any, true).then(() => 'resolved'),
                new Promise((resolve) => setTimeout(() => resolve('pending'), 25)),
            ]);

            expect(outcome).toBe('resolved');
            expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledTimes(1);
        });

        it('reports BRIDGE_ERROR to the client when the async frame write fails', async () => {
            mockBridgeService.writeAudioFrame.mockRejectedValue(new Error('redis down'));
            const client = createMockSocket();
            setValidTicketFor('sess-drop');
            await gateway.handleConnection(client as any, buildReq('sess-drop') as any);

            await gateway.handleMessage(client as any, Buffer.from([0x01]) as any, true);
            // Let the fire-and-forget rejection handler run.
            await new Promise((resolve) => setImmediate(resolve));

            expect(client.send).toHaveBeenCalledWith(expect.stringContaining('BRIDGE_ERROR'));
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

        // TASK-351 P1-1 — stableChars (committed-prefix length) is an
        // additive bridge field; the gateway must forward it untouched on
        // the WS transcript message and omit it when absent.
        it('forwards stableChars on the relayed transcript when present (TASK-351 P1-1)', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-stable');
            await gateway.handleConnection(client as any, buildReq('sess-stable') as any);

            resultSubject.next({
                type: 'transcript',
                text: 'hello tentative',
                startTime: 0,
                endTime: 1,
                isFinal: false,
                stableChars: 5,
            });

            const sent = JSON.parse((client.send as any).mock.calls[0][0]);
            expect(sent.stableChars).toBe(5);
        });

        // TASK-351 P1-1 follow-up — gloss results (post-final English
        // translations) ride the same relay; their additive fields must
        // survive the `{ ...msg, seq }` spread untouched.
        it('forwards gloss results with resultType/englishText/utteranceIndex intact (TASK-351 follow-up)', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-gloss');
            await gateway.handleConnection(client as any, buildReq('sess-gloss') as any);

            resultSubject.next({
                type: 'transcript',
                text: 'xin chào',
                startTime: 0,
                endTime: 1.5,
                isFinal: true,
                resultType: 'gloss',
                englishText: 'hello',
                utteranceIndex: 3,
            });

            const sent = JSON.parse((client.send as any).mock.calls[0][0]);
            expect(sent.resultType).toBe('gloss');
            expect(sent.englishText).toBe('hello');
            expect(sent.utteranceIndex).toBe(3);
            expect(sent.isFinal).toBe(true);
            expect(sent.seq).toBe(1);
        });

        it('omits utteranceIndex and resultType from the relayed transcript when absent', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-no-utt');
            await gateway.handleConnection(client as any, buildReq('sess-no-utt') as any);

            resultSubject.next({
                type: 'transcript',
                text: 'legacy result',
                startTime: 0,
                endTime: 1,
                isFinal: true,
            });

            const sent = JSON.parse((client.send as any).mock.calls[0][0]);
            expect('utteranceIndex' in sent).toBe(false);
            expect('resultType' in sent).toBe(false);
        });

        it('omits stableChars from the relayed transcript when absent', async () => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

            const client = createMockSocket();
            setValidTicketFor('sess-no-stable');
            await gateway.handleConnection(client as any, buildReq('sess-no-stable') as any);

            resultSubject.next({
                type: 'transcript',
                text: 'plain partial',
                startTime: 0,
                endTime: 1,
                isFinal: false,
            });

            const sent = JSON.parse((client.send as any).mock.calls[0][0]);
            expect('stableChars' in sent).toBe(false);
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

    // =========================================================================
    // TASK-351 P1-4 — WS egress backpressure (H6).
    //
    // Contract: when the client socket's `bufferedAmount` exceeds the 512 KiB
    // threshold, PARTIAL transcripts are dropped (per-session counter + log)
    // while FINAL transcripts are queued (bounded) and flushed IN ORDER once
    // the socket drains below the threshold. Normal delivery resumes after the
    // drain. Disconnect logs include the dropped-partial count (mirror of the
    // droppedAudioFrames pattern). Tests pin the spec values (512 KiB / 200),
    // not the exported constants, so a silent constant change fails loudly.
    // =========================================================================
    describe('TASK-351 P1-4 — WS egress backpressure (H6)', () => {
        const THRESHOLD_BYTES = 512 * 1024;
        const FINAL_QUEUE_LIMIT = 200;
        /** Generous wait for the drain-poll flush (poll cadence is sub-100ms). */
        const FLUSH_WAIT_MS = 150;

        const partialMsg = (text: string) => ({ type: 'transcript', text, startTime: 0, endTime: 1, isFinal: false });
        const finalMsg = (text: string) => ({ type: 'transcript', text, startTime: 0, endTime: 1, isFinal: true });

        const sentMessages = (client: ReturnType<typeof createMockSocket>) =>
            (client.send as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(c[0] as string));

        const connectWithSubject = async (sessionId: string) => {
            const resultSubject = new Subject();
            mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());
            const client = createMockSocket() as ReturnType<typeof createMockSocket> & { bufferedAmount: number };
            client.bufferedAmount = 0;
            setValidTicketFor(sessionId);
            await gateway.handleConnection(client as any, buildReq(sessionId) as any);
            (client.send as ReturnType<typeof vi.fn>).mockClear();
            return { client, resultSubject };
        };

        it('drops partial transcripts while bufferedAmount exceeds the 512 KiB threshold', async () => {
            const { client, resultSubject } = await connectWithSubject('sess-bp-partial');

            client.bufferedAmount = THRESHOLD_BYTES + 1;
            resultSubject.next(partialMsg('p1'));
            resultSubject.next(partialMsg('p2'));

            expect(client.send).not.toHaveBeenCalled();
            gateway.handleDisconnect(client as any);
        });

        it('records the dropped-partial count in the disconnect log (mirrors droppedAudioFrames)', async () => {
            const logSpy = vi.spyOn(Logger.prototype, 'log');
            const { client, resultSubject } = await connectWithSubject('sess-bp-count');

            client.bufferedAmount = THRESHOLD_BYTES + 1;
            resultSubject.next(partialMsg('p1'));
            resultSubject.next(partialMsg('p2'));
            resultSubject.next(partialMsg('p3'));

            logSpy.mockClear();
            gateway.handleDisconnect(client as any);

            expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: 'WebSocket client disconnected',
                    droppedPartialResults: 3,
                }),
            );
        });

        it('queues finals while over threshold and flushes them in order after the socket drains', async () => {
            const { client, resultSubject } = await connectWithSubject('sess-bp-final');

            client.bufferedAmount = THRESHOLD_BYTES + 1;
            resultSubject.next(finalMsg('f1'));
            resultSubject.next(finalMsg('f2'));

            // Over threshold: nothing goes out yet — finals are NEVER dropped.
            expect(client.send).not.toHaveBeenCalled();

            client.bufferedAmount = 0;
            await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

            const sent = sentMessages(client);
            expect(sent.map((m) => m.text)).toEqual(['f1', 'f2']);
            expect(sent.map((m) => m.seq)).toEqual([1, 2]);
            gateway.handleDisconnect(client as any);
        });

        it('resumes normal delivery once drained and the queued finals are flushed', async () => {
            const { client, resultSubject } = await connectWithSubject('sess-bp-resume');

            client.bufferedAmount = THRESHOLD_BYTES + 1;
            resultSubject.next(finalMsg('f1'));
            expect(client.send).not.toHaveBeenCalled();

            client.bufferedAmount = 0;
            await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

            resultSubject.next(partialMsg('p-after'));
            resultSubject.next(finalMsg('f-after'));

            const sent = sentMessages(client);
            expect(sent.map((m) => m.text)).toEqual(['f1', 'p-after', 'f-after']);
            gateway.handleDisconnect(client as any);
        });

        it('bounds the final queue at 200 and logs an error on overflow (never silent)', async () => {
            const errorSpy = vi.spyOn(Logger.prototype, 'error');
            errorSpy.mockClear();
            const { client, resultSubject } = await connectWithSubject('sess-bp-overflow');

            client.bufferedAmount = THRESHOLD_BYTES + 1;
            for (let i = 1; i <= FINAL_QUEUE_LIMIT + 1; i++) {
                resultSubject.next(finalMsg(`f${i}`));
            }

            expect(errorSpy).toHaveBeenCalled();

            client.bufferedAmount = 0;
            await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

            const sent = sentMessages(client);
            expect(sent).toHaveLength(FINAL_QUEUE_LIMIT);
            // The newest final survives; the oldest was the one dropped (loudly).
            expect(sent[sent.length - 1].text).toBe(`f${FINAL_QUEUE_LIMIT + 1}`);
            gateway.handleDisconnect(client as any);
        });

        // TASK-351 P1-1 follow-up — gloss results arrive with isFinal: true,
        // so the egress policy must queue them like any final (never drop),
        // and their additive fields must survive the queue+flush round trip.
        it('treats gloss results as finals under backpressure — queued, never dropped (TASK-351 follow-up)', async () => {
            const { client, resultSubject } = await connectWithSubject('sess-bp-gloss');

            client.bufferedAmount = THRESHOLD_BYTES + 1;
            resultSubject.next({ ...finalMsg('xin chào'), resultType: 'gloss', englishText: 'hello', utteranceIndex: 2 });

            // Queued, not dropped: nothing sent yet, but nothing lost either.
            expect(client.send).not.toHaveBeenCalled();

            client.bufferedAmount = 0;
            await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

            const sent = sentMessages(client);
            expect(sent).toHaveLength(1);
            expect(sent[0].text).toBe('xin chào');
            expect(sent[0].resultType).toBe('gloss');
            expect(sent[0].englishText).toBe('hello');
            expect(sent[0].utteranceIndex).toBe(2);

            // And the dropped-partial counter is untouched by gloss traffic.
            const logSpy = vi.spyOn(Logger.prototype, 'log');
            logSpy.mockClear();
            gateway.handleDisconnect(client as any);
            expect(logSpy).toHaveBeenCalledWith(
                expect.objectContaining({ droppedPartialResults: 0 }),
            );
        });

        it('delivers partials and finals immediately when bufferedAmount is below the threshold', async () => {
            const { client, resultSubject } = await connectWithSubject('sess-bp-normal');

            client.bufferedAmount = 1024;
            resultSubject.next(partialMsg('p1'));
            resultSubject.next(finalMsg('f1'));

            const sent = sentMessages(client);
            expect(sent.map((m) => m.text)).toEqual(['p1', 'f1']);
            gateway.handleDisconnect(client as any);
        });
    });
});
