// TASK-610 D-6 / FR-5 / T-7 — CSWSH guard for the STT WebSocket handshake.
//
// Browsers do not apply CORS to WebSocket handshakes, so `stt-ws.gateway.ts`
// must consult the SAME origin registry the CORS callback uses
// (`cors.config.ts`, lane W3-A) before accepting a connection. This is the
// lane W3-C leaf test — colocated with, but separate from, the pre-existing
// `stt-ws.gateway.test.ts` (per §4.4: "Test files are never shared ... each
// lane creates its own `*.task610.test.ts`").
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOriginEnforcementResolver } from '../../../cors.config';
import { SttWsGateway, WS_CLOSE_CODES, WS_GENERIC_AUTH_REASON } from '../stt-ws.gateway';

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
  writeAudioFrame: vi.fn().mockResolvedValue(undefined),
  writeControlCommand: vi.fn().mockResolvedValue(undefined),
  subscribeToResults: vi.fn().mockReturnValue({ subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })) }),
  unsubscribeFromResults: vi.fn(),
});

const createMockStreamTicketService = () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn().mockImplementation(async (ticket: string) => {
    if (!ticket || ticket === 'invalid') return null;
    return {
      userId: 'user-123',
      tenantId: 'tenant-abc',
      scope: 'stt_session:sess-origin',
      exp: Date.now() + 30_000,
      impersonatedBy: null,
    };
  }),
});

const createMockSessionBinding = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  bindSessionMeta: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn().mockResolvedValue('tenant-abc'),
  lookupSessionMeta: vi.fn().mockResolvedValue(null),
  clear: vi.fn().mockResolvedValue(undefined),
});

const createMockRemovalRetry = () => ({
  enqueue: vi.fn(),
});

// TASK-610 §4B.4 — `IOriginRegistry` dropped `ownerOf` for `tenantsFor`/
// `allows`. The gateway (`stt-ws.gateway.ts`) only ever calls `has()` and
// `size()` for its CORS-equivalent admission check (D-6) — it does not do
// tenant binding, so `tenantsFor`/`allows` are stubbed here only to satisfy
// the shape of the real interface, never asserted on.
const createMockOriginRegistry = (registered: Set<string> = new Set(['https://arcaai-u2204.bcmch.org'])) => ({
  tenantsFor: vi.fn((origin: string) => (registered.has(origin) ? new Set(['SYSTEM']) : new Set())),
  has: vi.fn((origin: string) => registered.has(origin)),
  allows: vi.fn((origin: string) => registered.has(origin)),
  refresh: vi.fn().mockResolvedValue(undefined),
  size: vi.fn(() => registered.size),
});

// Build a handshake request carrying sessionId + ticket (so the pre-existing
// auth gate accepts the connection once the origin check passes) plus an
// optional `Origin` header.
const buildReq = (sessionId: string, origin?: string): { url: string; headers: Record<string, string> } => ({
  url: `/ws/stt/stream?sessionId=${sessionId}&ticket=valid-ticket`,
  headers: origin === undefined ? {} : { origin },
});

describe('SttWsGateway — origin registry CSWSH guard (TASK-610 D-6, T-7)', () => {
  let mockSessionService: ReturnType<typeof createMockSessionService>;
  let mockBridgeService: ReturnType<typeof createMockBridgeService>;
  let mockStreamTicketService: ReturnType<typeof createMockStreamTicketService>;
  let mockSessionBinding: ReturnType<typeof createMockSessionBinding>;
  let mockRemovalRetry: ReturnType<typeof createMockRemovalRetry>;
  let mockOriginRegistry: ReturnType<typeof createMockOriginRegistry>;

  const buildGateway = (originRegistry?: ReturnType<typeof createMockOriginRegistry>): SttWsGateway =>
    new SttWsGateway(
      mockSessionService as any,
      mockBridgeService as any,
      mockStreamTicketService as any,
      mockSessionBinding as any,
      mockRemovalRetry as any,
      undefined, // socketRegistry — not under test here
      originRegistry as any,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    // TASK-610 §4C — the CSWSH check is dormant unless `origin.enforcementEnabled`
    // is on. Since TASK-641 FR-6 it ships ON (descriptor default `true`), so
    // arming the switch here reproduces the shipped posture rather than
    // overriding it; the dormant/off state is pinned in
    // `stt-ws.gateway.enforcement.task610.test.ts`. It is still set explicitly
    // because `cors.config.ts` has no resolver installed in a unit test — the
    // descriptor default reaches it only through `PlatformKnobsBinder`.
    setOriginEnforcementResolver(() => true);
    mockSessionService = createMockSessionService();
    mockBridgeService = createMockBridgeService();
    mockStreamTicketService = createMockStreamTicketService();
    mockSessionBinding = createMockSessionBinding();
    mockRemovalRetry = createMockRemovalRetry();
    mockOriginRegistry = createMockOriginRegistry();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    setOriginEnforcementResolver(null);
  });

  it('accepts the handshake when the Origin header is registered', async () => {
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

    expect(mockOriginRegistry.has).toHaveBeenCalledWith('https://arcaai-u2204.bcmch.org');
    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(1);
  });

  it('refuses the handshake when the Origin header is NOT registered, closing cleanly with the gateway generic close code', async () => {
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://evil.example.com') as any);

    // The refusal actually runs the established close path — same (code,
    // reason) tuple the file already uses for every other handshake
    // rejection (no new enumeration signal introduced).
    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
    // Nothing downstream of the origin gate ran.
    expect(mockStreamTicketService.consumeTicket).not.toHaveBeenCalled();
    expect(mockBridgeService.subscribeToResults).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(0);
  });

  it('logs the offending origin on refusal (operator needs it for the §4.8 rollout)', async () => {
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();

    await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://evil.example.com') as any);

    const messages = warnSpy.mock.calls.map((args) => args[0]);
    const rejection = messages.find(
      (m) => typeof m === 'object' && m !== null && (m as { origin?: string }).origin === 'https://evil.example.com',
    );
    expect(rejection).toBeDefined();
  });

  it('accepts the handshake when NO Origin header is present (non-browser callers — CSWSH cannot ride ambient credentials it never sent)', async () => {
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-origin', undefined) as any);

    expect(mockOriginRegistry.has).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(1);
  });

  it('accepts the handshake when the Origin header is an empty string (treated as absent)', async () => {
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await gateway.handleConnection(client as any, buildReq('sess-origin', '') as any);

    expect(mockOriginRegistry.has).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('does not throw when the registry lookup throws on a malformed Origin — fails CLOSED with a loud, distinctly-reasoned log (aligned with the HTTP CORS path)', async () => {
    mockOriginRegistry.has.mockImplementationOnce(() => {
      throw new Error('malformed input');
    });
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await expect(gateway.handleConnection(client as any, buildReq('sess-origin', 'not a valid origin!!') as any)).resolves.not.toThrow();

    expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
    expect(gateway.getActiveSessionCount()).toBe(0);
  });

  it('severs the connection when the registry is unavailable (undefined — not wired / DB blip) — denies and logs loudly under the "unavailable" reason', async () => {
    const gateway = buildGateway(undefined);
    const client = createMockSocket();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();

    await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

    expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
    expect(gateway.getActiveSessionCount()).toBe(0);
    const messages = warnSpy.mock.calls.map((args) => args[0]);
    const unavailableLog = messages.find(
      (m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_unavailable',
    );
    expect(unavailableLog).toBeDefined();
  });

  it('still enforces existing sessionId/ticket auth AFTER an origin passes (no regression to the pre-existing gate)', async () => {
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await gateway.handleConnection(
      client as any,
      { url: '/ws/stt/stream?sessionId=sess-origin&ticket=invalid', headers: { origin: 'https://arcaai-u2204.bcmch.org' } } as any,
    );

    expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
  });

  // Coordinator review reversed the original W5-C call here: `size() === 0`
  // now DENIES, matching an absent registry, and matching `cors.config.ts`.
  // The original fail-open reasoning (don't sever a live transcription
  // session on a DB blip) does not survive contact with how a WS connection
  // is actually obtained — `handleConnection` requires a single-use `ticket`
  // minted by a prior HTTP call to THIS gateway (`POST .../stream/session` or
  // `.../refresh-ticket`), which the HTTP CORS gate already denies during the
  // same outage. No legitimate browser client can reach this handshake
  // during a registry outage regardless of what this check does, so
  // fail-open bought nothing while leaving open the one surface CORS cannot
  // cover (browsers exempt WS from CORS — D-6, the actual CSWSH vector).
  // Established sockets are unaffected: this check runs only in
  // `handleConnection`, never against a live session.
  describe('present-but-empty registry (size() === 0) behaves exactly like an absent one — DENY (TASK-610 §4A.1, aligned with cors.config.ts)', () => {
    it('REJECTS when the registry is empty, with no env var involved at all', async () => {
      const emptyRegistry = createMockOriginRegistry(new Set());
      const gateway = buildGateway(emptyRegistry);
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      expect(emptyRegistry.size).toHaveBeenCalled();
      // The empty registry's `has()` would also have said no — asserting the
      // empty-registry branch decided this (not a direct `has()` call) matters
      // because it is what carries the distinct `origin_registry_unavailable`
      // log reason rather than an ordinary miss.
      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      expect(gateway.getActiveSessionCount()).toBe(0);
    });

    it('logs loudly under the "unavailable" reason when denying on an empty registry (operator visibility)', async () => {
      const emptyRegistry = createMockOriginRegistry(new Set());
      const gateway = buildGateway(emptyRegistry);
      const client = createMockSocket();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      const messages = warnSpy.mock.calls.map((args) => args[0]);
      const unavailableLog = messages.find(
        (m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_unavailable',
      );
      expect(unavailableLog).toBeDefined();
    });

    it('a NON-EMPTY registry is unchanged: still accepts a registered origin', async () => {
      const gateway = buildGateway(mockOriginRegistry); // pre-seeded with the SYSTEM origin
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      expect(mockOriginRegistry.size).toHaveBeenCalled();
      expect(mockOriginRegistry.has).toHaveBeenCalledWith('https://arcaai-u2204.bcmch.org');
      expect(client.close).not.toHaveBeenCalled();
    });

    it('a NON-EMPTY registry is unchanged: still rejects an unregistered origin, under the ordinary "miss" reason (not "unavailable")', async () => {
      const gateway = buildGateway(mockOriginRegistry); // non-empty, does not contain evil.example.com
      const client = createMockSocket();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://evil.example.com') as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      const messages = warnSpy.mock.calls.map((args) => args[0]);
      const missLog = messages.find((m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_miss');
      expect(missLog).toBeDefined();
    });
  });
});
