import { Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RESUME_BUFFER_SIZE, SttWsGateway, WS_CLOSE_CODES, WS_RESUME_GRACE_MS } from '../stt-ws.gateway';

/**
 * The 7th `writeAudioFrame` argument is the session's W3C trace carrier
 * . With no OTel SDK running in unit tests the gateway derives
 * an EMPTY carrier, so the Redis wire is byte-identical to the previous implementation — which
 * is the no-op guarantee these assertions now also pin.
 */
const TRACE_CARRIER_DISABLED = {};

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

// The gateway reads the session-negotiated sampleRate
// from the session meta written by `createStreamSession`. Default: no meta
// bound → gateway falls back to 16000.
const createMockSessionBinding = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  bindSessionMeta: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn().mockResolvedValue('tenant-abc'),
  lookupSessionMeta: vi.fn().mockResolvedValue(null),
  clear: vi.fn().mockResolvedValue(undefined),
});

// Parks session ids whose upstream removal
// failed on disconnect so they can be retried with backoff.
const createMockRemovalRetry = () => ({
  enqueue: vi.fn(),
});

// Helper — build a request URL with both sessionId and ticket so the new
// auth gate accepts the connection.
const buildReq = (sessionId: string, ticket = 'valid-ticket'): { url: string } => ({
  url: `/ws/stt/stream?sessionId=${sessionId}&ticket=${ticket}`,
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

    // These were updated from per-cause
    // (MISSING_PARAM / AUTH_FAILED with descriptive reasons) to the
    // single generic 4401 + "Authentication failed". The per-cause
    // truth table now lives in the describe block below.
    it('should reject connection without sessionId', async () => {
      const client = createMockSocket();
      await gateway.handleConnection(client as any, { url: '/ws/stt/stream' } as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
      expect(mockStreamTicketService.consumeTicket).not.toHaveBeenCalled();
    });

    it('should reject connection without ticket', async () => {
      const client = createMockSocket();
      await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=foo' } as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
      expect(mockStreamTicketService.consumeTicket).not.toHaveBeenCalled();
    });

    it('should reject connection with invalid ticket using close code 4401', async () => {
      const client = createMockSocket();
      mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);

      await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=sess-x&ticket=invalid' } as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
      expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
    });

    it('should reject connection when ticket scope does not match sessionId', async () => {
      const client = createMockSocket();
      mockStreamTicketService.consumeTicket.mockResolvedValueOnce({
        userId: 'u-1',
        tenantId: 't-1',
        scope: 'stt_session:OTHER_SESSION',
        exp: Date.now() + 30_000,
        impersonatedBy: null,
      });

      await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=sess-x&ticket=t' } as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
      expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
    });

    it('subscribes to bridge results only after ticket consumption succeeds', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-sub');
      await gateway.handleConnection(client as any, buildReq('sess-sub') as any);

      expect(mockStreamTicketService.consumeTicket).toHaveBeenCalledBefore(mockBridgeService.subscribeToResults as any);
      // Subscribes with the stable 'captions' consumer
      // group so the bridge resumes from the persisted cursor on a
      // re-subscription (never a 0-0 re-read).
      expect(mockBridgeService.subscribeToResults).toHaveBeenCalledWith('sess-sub', { consumerGroup: 'captions' });
    });

    // Every handshake-rejection
    // path must close with the SAME generic code (4401) and the same
    // constant reason, regardless of cause. Differentiating
    // `4001 missing param` from `4401 invalid ticket` lets a probing
    // client enumerate valid session ids. The real reason still
    // lives in the server-side warn log.
    describe('generic 4401 close code on EVERY handshake failure (audit)', () => {
      const GENERIC_CODE = 4401;
      const GENERIC_REASON_RE = /^Authentication failed$/;

      it('missing sessionId -> 4401 with the generic reason (no "sessionId" in the wire reason)', async () => {
        const client = createMockSocket();
        await gateway.handleConnection(client as any, { url: '/ws/stt/stream' } as any);

        const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
        expect(code).toBe(GENERIC_CODE);
        expect(String(reason)).toMatch(GENERIC_REASON_RE);
      });

      it('missing ticket -> 4401 with the generic reason (no "ticket" in the wire reason)', async () => {
        const client = createMockSocket();
        await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=sess-x' } as any);

        const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
        expect(code).toBe(GENERIC_CODE);
        expect(String(reason)).toMatch(GENERIC_REASON_RE);
      });

      it('invalid ticket -> 4401 (unchanged, but reason now generic, not "Invalid …")', async () => {
        const client = createMockSocket();
        mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);

        await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=sess-x&ticket=invalid' } as any);

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

        await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=sess-x&ticket=t' } as any);

        const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
        expect(code).toBe(GENERIC_CODE);
        expect(String(reason)).toMatch(GENERIC_REASON_RE);
      });

      it('all four rejection paths emit identical (code, reason) tuples (no enumeration signal)', async () => {
        const cases: Array<() => Promise<unknown>> = [
          // missing sessionId
          async () => {
            const c = createMockSocket();
            await gateway.handleConnection(c as any, { url: '/ws/stt/stream' } as any);
            return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
          },
          // missing ticket
          async () => {
            const c = createMockSocket();
            await gateway.handleConnection(c as any, { url: '/ws/stt/stream?sessionId=s' } as any);
            return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
          },
          // invalid ticket
          async () => {
            mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);
            const c = createMockSocket();
            await gateway.handleConnection(c as any, { url: '/ws/stt/stream?sessionId=s&ticket=invalid' } as any);
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
            await gateway.handleConnection(c as any, { url: '/ws/stt/stream?sessionId=s&ticket=t' } as any);
            return (c.close as ReturnType<typeof vi.fn>).mock.calls[0];
          },
        ];

        const tuples = await Promise.all(cases.map((fn) => fn()));
        const first = JSON.stringify(tuples[0]);
        for (const t of tuples) {
          expect(JSON.stringify(t)).toBe(first);
        }
      });

      // The binding-mismatch rejection joins the same
      // generic-close truth table (no fifth distinguishable signal).
      it('session tenant-binding mismatch -> 4401 with the generic reason (no tenant id on the wire)', async () => {
        const client = createMockSocket();
        setValidTicketFor('sess-x');
        mockSessionBinding.lookup.mockResolvedValueOnce('tenant-OTHER');

        await gateway.handleConnection(client as any, { url: '/ws/stt/stream?sessionId=sess-x&ticket=t' } as any);

        const [code, reason] = (client.close as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
        expect(code).toBe(GENERIC_CODE);
        expect(String(reason)).toMatch(GENERIC_REASON_RE);
        expect(String(reason)).not.toMatch(/tenant/i);
      });

      it('server-side warn log STILL records the REAL reason for ops (observability preserved)', async () => {
        const warnSpy = vi.spyOn(Logger.prototype, 'warn');
        warnSpy.mockClear();

        const c1 = createMockSocket();
        await gateway.handleConnection(c1 as any, { url: '/ws/stt/stream' } as any);

        mockStreamTicketService.consumeTicket.mockResolvedValueOnce(null);
        const c2 = createMockSocket();
        await gateway.handleConnection(c2 as any, { url: '/ws/stt/stream?sessionId=s&ticket=bad' } as any);

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

    // A ticket whose SCOPE matches the sessionId but whose
    // tenant is NOT the session's owning tenant used to pass the handshake
    // (the gateway trusted `stored.tenantId` and never consulted the
    // gateway-side sessionId → tenantId binding). The handshake now mirrors
    // the DELETE route's `assertStreamSessionOwnership`: missing binding OR
    // binding ≠ ticket tenant both close with the same generic 4401.
    describe('session tenant binding enforced at the WS handshake', () => {
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

        expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
        expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
        expect(gateway.getActiveSessionCount()).toBe(0);
      });

      it('fail-closed: rejects when NO binding exists for the session (not just on mismatch)', async () => {
        const client = createMockSocket();
        setValidTicketFor('sess-450');
        mockSessionBinding.lookup.mockResolvedValueOnce(null);

        await gateway.handleConnection(client as any, buildReq('sess-450') as any);

        expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
        expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
        expect(gateway.getActiveSessionCount()).toBe(0);
      });

      it('fail-closed: rejects when the binding lookup throws (Redis blip is not an auth bypass)', async () => {
        const client = createMockSocket();
        setValidTicketFor('sess-450');
        mockSessionBinding.lookup.mockRejectedValueOnce(new Error('redis down'));

        await gateway.handleConnection(client as any, buildReq('sess-450') as any);

        expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, 'Authentication failed');
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

  // A TRANSIENT disconnect must NOT finalize the upstream:
  // the session (buffer + seq + subscription) is kept alive for a grace
  // window so the SAME session can reconnect and continue. Only when the
  // window expires with no reconnect is the upstream finalized.
  describe('handleDisconnect (grace window)', () => {
    it('drops the socket from the active count but does NOT finalize during the grace window', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-456');
      await gateway.handleConnection(client as any, buildReq('sess-456') as any);
      gateway.handleDisconnect(client as any);

      // Socket count drops immediately …
      expect(gateway.getActiveSessionCount()).toBe(0);
      // … but the upstream is NOT torn down (may reconnect).
      expect(mockBridgeService.unsubscribeFromResults).not.toHaveBeenCalled();
      expect(mockSessionService.removeSession).not.toHaveBeenCalled();
    });

    it('unsubscribes and finalizes the upstream only AFTER the grace window expires', async () => {
      vi.useFakeTimers();
      try {
        const client = createMockSocket();
        setValidTicketFor('sess-789');
        await gateway.handleConnection(client as any, buildReq('sess-789') as any);

        gateway.handleDisconnect(client as any);
        expect(mockBridgeService.unsubscribeFromResults).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS + 5);

        expect(mockBridgeService.unsubscribeFromResults).toHaveBeenCalledWith('sess-789');
        // A grace-window expiry is an ABORT: no explicit
        // close was ever received, so the ledger row is marked interrupted.
        expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-789', true);
      } finally {
        vi.useRealTimers();
      }
    });

    // The abort test, written before the interrupted flag
    // existed anywhere on this path: an unreachable/dropped client (grace
    // expiry) must be distinguishable from a client-driven close at the
    // ledger. Both call removeSession with the SAME sessionId (same
    // idempotency key either way — ws-b-contract.md §4), but only the abort
    // carries interrupted:true.
    it('marks the ledger row interrupted on grace-window expiry, NOT on an explicit close', async () => {
      vi.useFakeTimers();
      try {
        const abortClient = createMockSocket();
        setValidTicketFor('sess-abort-flag');
        await gateway.handleConnection(abortClient as any, buildReq('sess-abort-flag') as any);
        gateway.handleDisconnect(abortClient as any);
        await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS + 5);

        expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-abort-flag', true);
      } finally {
        vi.useRealTimers();
      }

      const closeClient = createMockSocket();
      setValidTicketFor('sess-complete-flag');
      await gateway.handleConnection(closeClient as any, buildReq('sess-complete-flag') as any);
      await gateway.handleMessage(closeClient as any, JSON.stringify({ type: 'close' }));

      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-complete-flag', false);
    });

    // A failed fire-and-forget removeSession
    // used to leave the Python session leaked. The failure now parks the
    // session id on a retry queue — now at grace-window expiry.
    it('enqueues a removal retry when the upstream removeSession fails at grace expiry', async () => {
      vi.useFakeTimers();
      try {
        mockSessionService.removeSession.mockRejectedValueOnce(new Error('stt down'));
        const client = createMockSocket();
        setValidTicketFor('sess-leak');
        await gateway.handleConnection(client as any, buildReq('sess-leak') as any);

        gateway.handleDisconnect(client as any);
        await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS + 5);
        await vi.advanceTimersByTimeAsync(5); // settle the fire-and-forget .catch

        // Grace expiry is an abort — the enqueued retry carries interrupted:true.
        expect(mockRemovalRetry.enqueue).toHaveBeenCalledWith('sess-leak', true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not enqueue a removal retry when removeSession succeeds at grace expiry', async () => {
      vi.useFakeTimers();
      try {
        const client = createMockSocket();
        setValidTicketFor('sess-clean');
        await gateway.handleConnection(client as any, buildReq('sess-clean') as any);

        gateway.handleDisconnect(client as any);
        await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS + 5);
        await vi.advanceTimersByTimeAsync(5);

        expect(mockRemovalRetry.enqueue).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('a reconnect within the grace window CANCELS finalize — the upstream is never torn down', async () => {
      vi.useFakeTimers();
      try {
        const client1 = createMockSocket();
        setValidTicketFor('sess-reconn');
        await gateway.handleConnection(client1 as any, buildReq('sess-reconn') as any);
        gateway.handleDisconnect(client1 as any);

        // Reconnect (same sessionId) BEFORE the window expires.
        await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS / 3);
        const client2 = createMockSocket();
        setValidTicketFor('sess-reconn');
        await gateway.handleConnection(client2 as any, buildReq('sess-reconn') as any);

        // Advance well past the ORIGINAL window — finalize must have been cancelled.
        await vi.advanceTimersByTimeAsync(WS_RESUME_GRACE_MS + 5);
        // The upstream STT-v2 session was NEVER torn down (no removeSession,
        // and never the session-wide unsubscribeFromResults that would kill
        // LiveDoc). C1: the transient disconnect only dropped the gateway's
        // OWN captions reader, which the reconnect re-establishes — so
        // subscribeToResults is called twice (fresh + re-establish), always
        // with the stable 'captions' group (cursor resume, no 0-0 flood).
        expect(mockSessionService.removeSession).not.toHaveBeenCalled();
        expect(mockBridgeService.unsubscribeFromResults).not.toHaveBeenCalled();
        expect(mockBridgeService.subscribeToResults).toHaveBeenCalledTimes(2);
        expect(mockBridgeService.subscribeToResults.mock.calls.every((c: any[]) => c[1]?.consumerGroup === 'captions')).toBe(true);
        expect(gateway.getActiveSessionCount()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
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

      expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith('sess-audio', 1, expect.any(Buffer), 16000, 'pcm_s16le', false, TRACE_CARRIER_DISABLED);
    });

    it('should handle stop message by sending finalize control command', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-stop');
      await gateway.handleConnection(client as any, buildReq('sess-stop') as any);

      await gateway.handleMessage(client as any, JSON.stringify({ type: 'stop' }));

      expect(mockBridgeService.writeControlCommand).toHaveBeenCalledWith('sess-stop', 'finalize');
    });

    it('should handle close message by removing session and closing socket', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-close');
      await gateway.handleConnection(client as any, buildReq('sess-close') as any);

      await gateway.handleMessage(client as any, JSON.stringify({ type: 'close' }));

      // Explicit close — not an abort.
      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-close', false);
      expect(gateway.getActiveSessionCount()).toBe(0);
    });

    it('should send error to client for unknown message type', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-err');
      await gateway.handleConnection(client as any, buildReq('sess-err') as any);

      await gateway.handleMessage(client as any, JSON.stringify({ type: 'unknown' }));

      expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"type":"error"'));
    });

    it('should send error for malformed JSON', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-json');
      await gateway.handleConnection(client as any, buildReq('sess-json') as any);

      await gateway.handleMessage(client as any, 'not-json');

      expect(client.send).toHaveBeenCalledWith(expect.stringContaining('"type":"error"'));
    });

    it('should forward binary audio frames to bridge service', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-bin');
      await gateway.handleConnection(client as any, buildReq('sess-bin') as any);

      const binaryData = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      await gateway.handleMessage(client as any, binaryData as any, true);

      expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith('sess-bin', expect.any(Number), binaryData, 16000, 'pcm_s16le', false, TRACE_CARRIER_DISABLED);
    });
  });

  // =========================================================================
  // Session-negotiated sampleRate + non-blocking audio
  // ingestion.
  // =========================================================================
  describe('negotiated sampleRate + non-blocking ingestion', () => {
    it('forwards the session-negotiated sampleRate on binary frames (C5)', async () => {
      mockSessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 48000 });
      const client = createMockSocket();
      setValidTicketFor('sess-sr-bin');
      await gateway.handleConnection(client as any, buildReq('sess-sr-bin') as any);

      const binaryData = Buffer.from([0x01, 0x02]);
      await gateway.handleMessage(client as any, binaryData as any, true);

      expect(mockSessionBinding.lookupSessionMeta).toHaveBeenCalledWith('sess-sr-bin');
      expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith('sess-sr-bin', expect.any(Number), binaryData, 48000, 'pcm_s16le', false, TRACE_CARRIER_DISABLED);
    });

    it('forwards the session-negotiated sampleRate on JSON audio frames (C5)', async () => {
      mockSessionBinding.lookupSessionMeta.mockResolvedValueOnce({ sampleRate: 44100 });
      const client = createMockSocket();
      setValidTicketFor('sess-sr-json');
      await gateway.handleConnection(client as any, buildReq('sess-sr-json') as any);

      await gateway.handleMessage(client as any, JSON.stringify({ type: 'audio', seq: 7, data: 'YWJjZA==' }));

      expect(mockBridgeService.writeAudioFrame).toHaveBeenCalledWith('sess-sr-json', 7, expect.any(Buffer), 44100, 'pcm_s16le', false, TRACE_CARRIER_DISABLED);
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
        TRACE_CARRIER_DISABLED,
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
        TRACE_CARRIER_DISABLED,
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

  describe('result forwarding + sequencing', () => {
    it('subscribes to bridge results and forwards transcripts to client, tagged with server seq', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-fwd');
      await gateway.handleConnection(client as any, buildReq('sess-fwd') as any);
      // Drop the readiness ack so we assert the transcript.
      (client.send as any).mockClear();

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

    // Apps/stt publishes a `status`/`provider_switched` result on
    // the session's result stream when the ASR engine is swapped to the
    // fallback (auto or user-triggered). The gateway relays non-transcript
    // results verbatim (no seq tag), so the switch notification reaches the
    // client on the existing `status` frame — zero WS protocol change.
    it('forwards a provider_switched status result to the client verbatim (no seq tag)', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-switch');
      await gateway.handleConnection(client as any, buildReq('sess-switch') as any);
      // Drop the readiness ack so we assert the status message alone.
      (client.send as any).mockClear();

      resultSubject.next({
        type: 'status',
        status: 'provider_switched',
        from_pipeline: 'azure_speech_transcription',
        to_pipeline: 'sarvam_transcription',
        reason: 'auto',
        utterance_index: 4,
      });

      expect(client.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse((client.send as any).mock.calls[0][0]);
      expect(sent.type).toBe('status');
      expect(sent.status).toBe('provider_switched');
      expect(sent.from_pipeline).toBe('azure_speech_transcription');
      expect(sent.to_pipeline).toBe('sarvam_transcription');
      expect(sent.reason).toBe('auto');
      expect(sent.utterance_index).toBe(4);
      // Status frames are not transcript results, so they carry no server seq.
      expect('seq' in sent).toBe(false);
    });

    // Follow-up #1: apps/stt publishes `finalizing` before it flushes
    // the tail utterance; the bridge now relays it as a non-terminal status.
    // The frame must reach the socket in exactly the shape
    // `SttWebSocketClient.isValidStatus` accepts (`status` a string, `message`
    // absent or a string) — that is what opens the SDK stop-drain quiet window.
    // Tail transcripts published AFTER it must still be forwarded.
    it('forwards a finalizing status to the client and keeps forwarding the tail final after it', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-finalizing');
      await gateway.handleConnection(client as any, buildReq('sess-finalizing') as any);
      (client.send as any).mockClear();

      resultSubject.next({ type: 'status', status: 'finalizing' });
      resultSubject.next({ type: 'transcript', text: 'the closing utterance', startTime: 5, endTime: 7, isFinal: true });

      expect(client.send).toHaveBeenCalledTimes(2);
      const status = JSON.parse((client.send as any).mock.calls[0][0]);
      expect(status).toEqual({ type: 'status', status: 'finalizing' });
      // The SDK guard: `status` string, `message` absent-or-string.
      expect(typeof status.status).toBe('string');
      expect(status.message).toBeUndefined();

      const tail = JSON.parse((client.send as any).mock.calls[1][0]);
      expect(tail.text).toBe('the closing utterance');
      expect(tail.isFinal).toBe(true);
    });

    // stableChars (committed-prefix length) is an
    // additive bridge field; the gateway must forward it untouched on
    // the WS transcript message and omit it when absent.
    it('forwards stableChars on the relayed transcript when present', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-stable');
      await gateway.handleConnection(client as any, buildReq('sess-stable') as any);
      // Drop the readiness ack so we assert the transcript.
      (client.send as any).mockClear();

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

    // PipelineId (the ASR engine that produced THIS
    // utterance, B1) is an additive bridge field; the gateway
    // relays it verbatim like stableChars/englishText and omits it when
    // the bridge didn't set one.
    it('forwards pipelineId on the relayed transcript when present', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-pipeline-id');
      await gateway.handleConnection(client as any, buildReq('sess-pipeline-id') as any);
      (client.send as any).mockClear();

      resultSubject.next({
        type: 'transcript',
        text: 'hello world',
        startTime: 0,
        endTime: 1,
        isFinal: true,
        pipelineId: 'sarvam_transcription',
      });

      const sent = JSON.parse((client.send as any).mock.calls[0][0]);
      expect(sent.pipelineId).toBe('sarvam_transcription');
    });

    it('omits pipelineId from the relayed transcript when absent', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-no-pipeline-id');
      await gateway.handleConnection(client as any, buildReq('sess-no-pipeline-id') as any);
      (client.send as any).mockClear();

      resultSubject.next({
        type: 'transcript',
        text: 'hello world',
        startTime: 0,
        endTime: 1,
        isFinal: true,
      });

      const sent = JSON.parse((client.send as any).mock.calls[0][0]);
      expect('pipelineId' in sent).toBe(false);
    });

    // Gloss results (post-final English
    // translations) ride the same relay; their additive fields must
    // survive the `{ ...msg, seq }` spread untouched.
    it('forwards gloss results with resultType/englishText/utteranceIndex intact', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client = createMockSocket();
      setValidTicketFor('sess-gloss');
      await gateway.handleConnection(client as any, buildReq('sess-gloss') as any);
      // Drop the readiness ack so we assert the transcript.
      (client.send as any).mockClear();

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
      // Drop the readiness ack so we assert the transcript.
      (client.send as any).mockClear();

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
      // Drop the readiness ack so we assert the transcript.
      (client.send as any).mockClear();

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
      await gateway.handleMessage(client as any, JSON.stringify({ type: 'resume', sessionId: 'sess-resume', lastSeq: 1 }));

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
      await gateway.handleMessage(client as any, JSON.stringify({ type: 'resume', sessionId: 'sess-overflow', lastSeq: 2 }));

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

      await gateway.handleMessage(client as any, JSON.stringify({ type: 'resume', sessionId: 'OTHER', lastSeq: 0 }));

      const replyCalls = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const failed = replyCalls.find((c: any) => c.type === 'resume_failed');
      expect(failed).toBeDefined();
      expect(failed.reason).toBe('unknown_session');
    });
  });

  // =========================================================================
  // The folded-in WS-control fix. ws@8 delivers TEXT frames as a
  // Buffer with isBinary=false; the gateway used to split audio-vs-JSON on
  // Buffer.isBuffer(), so JSON control frames ({resume|stop|close}) were
  // misclassified as binary audio and the JSON path never ran. It now routes
  // on the isBinary flag: binary → audio, text (Buffer, isBinary=false) → JSON.
  // =========================================================================
  describe('WS control channel over Buffer text frames (isBinary)', () => {
    it('routes a stop control frame delivered as a Buffer (isBinary=false) to the JSON path — NOT audio', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-ctrl-stop');
      await gateway.handleConnection(client as any, buildReq('sess-ctrl-stop') as any);

      const stopFrame = Buffer.from(JSON.stringify({ type: 'stop' }));
      await gateway.handleMessage(client as any, stopFrame as any, false);

      expect(mockBridgeService.writeControlCommand).toHaveBeenCalledWith('sess-ctrl-stop', 'finalize');
      expect(mockBridgeService.writeAudioFrame).not.toHaveBeenCalled();
    });

    it('answers a resume handshake delivered as a Buffer text frame (isBinary=false)', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-ctrl-resume');
      await gateway.handleConnection(client as any, buildReq('sess-ctrl-resume') as any);

      const resumeFrame = Buffer.from(JSON.stringify({ type: 'resume', sessionId: 'sess-ctrl-resume', lastSeq: 0 }));
      await gateway.handleMessage(client as any, resumeFrame as any, false);

      const sent = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      expect(sent.some((m: any) => m.type === 'resumed')).toBe(true);
      expect(mockBridgeService.writeAudioFrame).not.toHaveBeenCalled();
    });

    it('routes a close control frame delivered as a Buffer (isBinary=false) to finalize', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-ctrl-close');
      await gateway.handleConnection(client as any, buildReq('sess-ctrl-close') as any);

      const closeFrame = Buffer.from(JSON.stringify({ type: 'close' }));
      await gateway.handleMessage(client as any, closeFrame as any, false);

      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-ctrl-close', false);
      expect(mockBridgeService.writeAudioFrame).not.toHaveBeenCalled();
    });

    it('still treats a binary frame (isBinary=true) as audio', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-ctrl-bin');
      await gateway.handleConnection(client as any, buildReq('sess-ctrl-bin') as any);

      // A Buffer that HAPPENS to be valid JSON but arrives as a binary
      // frame is audio — the flag, not the bytes, decides.
      const jsonyAudio = Buffer.from(JSON.stringify({ type: 'stop' }));
      await gateway.handleMessage(client as any, jsonyAudio as any, true);

      expect(mockBridgeService.writeAudioFrame).toHaveBeenCalled();
      expect(mockBridgeService.writeControlCommand).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Reconnect-after-drop target (the unit-level mirror of
  // the resume-after-drop e2e gate): resume from lastSeq+1, no
  // duplicate flood, no silent freeze.
  // =========================================================================
  describe('reconnect-after-drop resume', () => {
    it('rebinds on reconnect and resumes from lastSeq+1 with no duplicate flood and no freeze', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client1 = createMockSocket();
      setValidTicketFor('sess-rad');
      await gateway.handleConnection(client1 as any, buildReq('sess-rad') as any);

      // Bank 3 transcripts (seq 1..3); the client saw up to seq 3.
      for (let i = 1; i <= 3; i++) {
        resultSubject.next({ type: 'transcript', text: `t${i}`, startTime: i, endTime: i + 1, isFinal: true });
      }

      // Transient drop (no close frame) — the session must survive. C1: the
      // gateway's captions reader is dropped so it can't split the shared
      // group cross-instance; a reconnect re-establishes it from the cursor.
      // (Grace-window results accumulate in Redis and are re-read on
      // reconnect — a real-Redis behavior the live e2e covers; a bare
      // Subject mock can't buffer while unsubscribed, so we don't assert it
      // here.)
      gateway.handleDisconnect(client1 as any);
      expect(mockSessionService.removeSession).not.toHaveBeenCalled();

      // Reconnect on a NEW socket, SAME sessionId, fresh ticket.
      const client2 = createMockSocket();
      setValidTicketFor('sess-rad');
      await gateway.handleConnection(client2 as any, buildReq('sess-rad') as any);
      // Re-establishes the reader (fresh + re-subscribe), always on the
      // stable 'captions' group → resumes from the cursor, no 0-0 flood.
      expect(mockBridgeService.subscribeToResults).toHaveBeenCalledTimes(2);
      expect(mockBridgeService.subscribeToResults.mock.calls.every((c: any[]) => c[1]?.consumerGroup === 'captions')).toBe(true);

      // The client drives the resume from the last seq it saw (3).
      await gateway.handleMessage(client2 as any, Buffer.from(JSON.stringify({ type: 'resume', sessionId: 'sess-rad', lastSeq: 3 })) as any, false);

      const sent = (client2.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const resumed = sent.find((m: any) => m.type === 'resumed');
      expect(resumed).toBeDefined();
      // (1) continuation from the next unseen seq.
      expect(resumed.fromSeq).toBe(4);
      // (2) no duplicate flood: nothing with seq <= 3 re-delivered.
      expect(sent.filter((m: any) => typeof m.seq === 'number' && m.seq <= 3)).toHaveLength(0);

      // (3) no silent freeze: new transcripts flow to the NEW socket, with
      // seq CONTINUING from the preserved counter (4, not reset to 1).
      (client2.send as any).mockClear();
      resultSubject.next({ type: 'transcript', text: 't4', startTime: 4, endTime: 5, isFinal: true });
      const after = (client2.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const t4 = after.find((m: any) => m.text === 't4');
      expect(t4).toBeDefined();
      expect(t4.seq).toBe(4);
    });
  });

  // =========================================================================
  // F-06 / F-36: after the grace window EXPIRES the session is finalized and
  // its upstream STT-v2 session is gone. A later reconnect on the same id
  // builds a FRESH SessionInfo (empty resume buffer). The old code answered a
  // resume on it with a vacuous `resumed` (empty buffer trivially passes the
  // length guard) — the client believed it resumed while the mic captured into
  // a dead session with no error. It must now reply `resume_failed`. finalize
  // must also clear the sessionId→tenant binding so no ticket can be minted
  // against the dead session (F-36).
  // =========================================================================
  describe('false-resume prevention after grace expiry (F-06) + binding cleanup (F-36)', () => {
    it('replies resume_failed (not a vacuous resumed) when a freshly-created session is resumed after grace expiry', async () => {
      vi.useFakeTimers();
      try {
        const resultSubject = new Subject();
        mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

        const client1 = createMockSocket();
        setValidTicketFor('sess-grace-resume');
        await gateway.handleConnection(client1 as any, buildReq('sess-grace-resume') as any);
        for (let i = 1; i <= 3; i++) {
          resultSubject.next({ type: 'transcript', text: `t${i}`, startTime: i, endTime: i + 1, isFinal: true });
        }

        // Transient drop → grace window, then let the window EXPIRE so the
        // session is finalized and deleted (upstream gone).
        gateway.handleDisconnect(client1 as any);
        vi.advanceTimersByTime(WS_RESUME_GRACE_MS + 1);
        expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-grace-resume', true);
        // F-36: finalize dropped the tenant binding too.
        expect(mockSessionBinding.clear).toHaveBeenCalledWith('sess-grace-resume');

        // Reconnect same id → a FRESH SessionInfo (empty buffer, resultSeq 0).
        const client2 = createMockSocket();
        setValidTicketFor('sess-grace-resume');
        await gateway.handleConnection(client2 as any, buildReq('sess-grace-resume') as any);

        (client2.send as any).mockClear();
        await gateway.handleMessage(
          client2 as any,
          Buffer.from(JSON.stringify({ type: 'resume', sessionId: 'sess-grace-resume', lastSeq: 3 })) as any,
          false,
        );

        const sent = (client2.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
        expect(sent.some((m: any) => m.type === 'resumed')).toBe(false);
        const failed = sent.find((m: any) => m.type === 'resume_failed');
        expect(failed).toBeDefined();
        expect(failed.reason).toBe('unknown_session');
      } finally {
        vi.useRealTimers();
      }
    });

    it('still honors a resume on a genuine within-grace rebind (fresh flag cleared)', async () => {
      const resultSubject = new Subject();
      mockBridgeService.subscribeToResults.mockReturnValue(resultSubject.asObservable());

      const client1 = createMockSocket();
      setValidTicketFor('sess-rebind-ok');
      await gateway.handleConnection(client1 as any, buildReq('sess-rebind-ok') as any);
      for (let i = 1; i <= 2; i++) {
        resultSubject.next({ type: 'transcript', text: `t${i}`, startTime: i, endTime: i + 1, isFinal: true });
      }

      // Within-grace drop (NOT expired) then reconnect → rebindSession
      // continues the SAME session and clears the freshly-created flag.
      gateway.handleDisconnect(client1 as any);
      const client2 = createMockSocket();
      setValidTicketFor('sess-rebind-ok');
      await gateway.handleConnection(client2 as any, buildReq('sess-rebind-ok') as any);

      (client2.send as any).mockClear();
      await gateway.handleMessage(
        client2 as any,
        Buffer.from(JSON.stringify({ type: 'resume', sessionId: 'sess-rebind-ok', lastSeq: 2 })) as any,
        false,
      );

      const sent = (client2.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      expect(sent.some((m: any) => m.type === 'resumed')).toBe(true);
      expect(sent.some((m: any) => m.type === 'resume_failed')).toBe(false);
    });

    it('F-36: an explicit close finalize clears the sessionId→tenant binding', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-clear-bind');
      await gateway.handleConnection(client as any, buildReq('sess-clear-bind') as any);

      // Explicit close → real finalize (no grace window).
      await gateway.handleMessage(client as any, JSON.stringify({ type: 'close' }));

      expect(mockSessionBinding.clear).toHaveBeenCalledWith('sess-clear-bind');
    });
  });

  // =========================================================================
  // Readiness ack. handleConnection registers the session
  // AFTER async auth/lookup awaits; a client that resumes/sends the instant
  // its socket opens would race registration → NO_SESSION → silent freeze.
  // The gateway now emits {type:'ready'} after registration so the client
  // gates its first send on it (deterministic, no timing guess).
  // =========================================================================
  describe('readiness ack', () => {
    it('sends a {type:"ready"} ack after a fresh connection is registered', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-ready');
      await gateway.handleConnection(client as any, buildReq('sess-ready') as any);

      const sent = (client.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const ready = sent.find((m: any) => m.type === 'ready');
      expect(ready).toBeDefined();
      expect(ready.sessionId).toBe('sess-ready');
      // fromSeq advertises the next seq the client should expect.
      expect(ready.fromSeq).toBe(1);
    });

    it('sends a {type:"ready"} ack again on a grace-window reconnect (before the client resumes)', async () => {
      const client1 = createMockSocket();
      setValidTicketFor('sess-ready2');
      await gateway.handleConnection(client1 as any, buildReq('sess-ready2') as any);
      gateway.handleDisconnect(client1 as any);

      const client2 = createMockSocket();
      setValidTicketFor('sess-ready2');
      await gateway.handleConnection(client2 as any, buildReq('sess-ready2') as any);

      const sent = (client2.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]));
      expect(sent.some((m: any) => m.type === 'ready')).toBe(true);
    });
  });

  // =========================================================================
  // Graceful shutdown. onModuleDestroy must FINALIZE live +
  // in-grace sessions so a SIGTERM / rolling deploy does not orphan STT-v2
  // sessions (and their capacity slots) until the STT-v2 reaper.
  // =========================================================================
  describe('onModuleDestroy finalizes sessions', () => {
    it('removes the upstream session for a LIVE connection on shutdown', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-shutdown');
      await gateway.handleConnection(client as any, buildReq('sess-shutdown') as any);

      await gateway.onModuleDestroy();

      // Shutdown is always an abort — no client-driven close was received.
      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-shutdown', true);
      // F-36: shutdown finalize also clears the tenant binding.
      expect(mockSessionBinding.clear).toHaveBeenCalledWith('sess-shutdown');
      expect(gateway.getActiveSessionCount()).toBe(0);
    });

    it('removes the upstream session for an IN-GRACE (disconnected) session on shutdown', async () => {
      const client = createMockSocket();
      setValidTicketFor('sess-grace-shutdown');
      await gateway.handleConnection(client as any, buildReq('sess-grace-shutdown') as any);
      // Transient disconnect → session parked in the grace window (not yet finalized).
      gateway.handleDisconnect(client as any);
      expect(mockSessionService.removeSession).not.toHaveBeenCalled();

      await gateway.onModuleDestroy();

      // The deploy tidies it up instead of orphaning the upstream session.
      expect(mockSessionService.removeSession).toHaveBeenCalledWith('sess-grace-shutdown', true);
    });
  });

  // =========================================================================
  // WS egress backpressure.
  //
  // Contract: when the client socket's `bufferedAmount` exceeds the 512 KiB
  // threshold, PARTIAL transcripts are dropped (per-session counter + log)
  // while FINAL transcripts are queued (bounded) and flushed IN ORDER once
  // the socket drains below the threshold. Normal delivery resumes after the
  // drain. Disconnect logs include the dropped-partial count (mirror of the
  // droppedAudioFrames pattern). Tests pin the spec values (512 KiB / 200),
  // not the exported constants, so a silent constant change fails loudly.
  // =========================================================================
  describe('WS egress backpressure', () => {
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
      const finals = sent.filter((m) => m.type === 'transcript');
      expect(finals).toHaveLength(FINAL_QUEUE_LIMIT);
      // The newest final survives; the oldest was the one dropped (loudly).
      expect(finals[finals.length - 1].text).toBe(`f${FINAL_QUEUE_LIMIT + 1}`);
      // The dropped final is signaled with an EXPLICIT gap
      // marker (never a silent loss); it is recoverable from the durable
      // transcript, NOT the resume buffer (which evicted it in lockstep).
      expect(sent.some((m) => m.type === 'gap' && m.reason === 'egress_overflow')).toBe(true);
      gateway.handleDisconnect(client as any);
    });

    // Gloss results arrive with isFinal: true,
    // so the egress policy must queue them like any final (never drop),
    // and their additive fields must survive the queue+flush round trip.
    it('treats gloss results as finals under backpressure — queued, never dropped', async () => {
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
      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ droppedPartialResults: 0 }));
    });

    // PipelineId must survive the bounded final-queue path
    // (tagAndBuffer + enqueueFinalResult), not just the immediate-send path
    // covered above.
    it('preserves pipelineId on a final queued and flushed under backpressure', async () => {
      const { client, resultSubject } = await connectWithSubject('sess-bp-pipeline-id');

      client.bufferedAmount = THRESHOLD_BYTES + 1;
      resultSubject.next({ ...finalMsg('xin chào'), pipelineId: 'sarvam_transcription' });

      expect(client.send).not.toHaveBeenCalled();

      client.bufferedAmount = 0;
      await new Promise((resolve) => setTimeout(resolve, FLUSH_WAIT_MS));

      const sent = sentMessages(client);
      expect(sent).toHaveLength(1);
      expect(sent[0].pipelineId).toBe('sarvam_transcription');
      gateway.handleDisconnect(client as any);
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
