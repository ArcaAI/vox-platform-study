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

const createMockOriginRegistry = (registered: Set<string> = new Set(['https://arcaai-u2204.bcmch.org'])) => ({
  ownerOf: vi.fn((origin: string) => (registered.has(origin) ? 'SYSTEM' : null)),
  has: vi.fn((origin: string) => registered.has(origin)),
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

  it('does not throw when the registry lookup throws on a malformed Origin — fails open with a loud log, matching the bootstrap-fallback posture (FR-6)', async () => {
    mockOriginRegistry.has.mockImplementationOnce(() => {
      throw new Error('malformed input');
    });
    const gateway = buildGateway(mockOriginRegistry);
    const client = createMockSocket();

    await expect(gateway.handleConnection(client as any, buildReq('sess-origin', 'not a valid origin!!') as any)).resolves.not.toThrow();

    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(1);
  });

  it('does not sever the connection when the registry is unavailable (undefined — not wired / DB blip) — allows and logs loudly', async () => {
    const gateway = buildGateway(undefined);
    const client = createMockSocket();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();

    await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(1);
    const messages = warnSpy.mock.calls.map((args) => args[0]);
    const fallbackLog = messages.find(
      (m) => typeof m === 'object' && m !== null && String((m as { message?: string }).message).includes('registry unavailable'),
    );
    expect(fallbackLog).toBeDefined();
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

  // W4-R (adversarial review) confirmed a divergence: `platform-knobs.binder.ts`
  // collapses an empty registry to `null` for `cors.config.ts`, which falls
  // back to `CORS_ALLOWED_ORIGINS` — so an unseeded/emptied table keeps HTTP
  // serving. The WS predicate called `has()` directly on a present-but-empty
  // registry, got `false` for every origin, and rejected — severing every
  // live transcription session on exactly the DB-blip scenario the gateway's
  // own bootstrap-fallback comment claims to protect against.
  describe('present-but-empty registry (size() === 0) falls back like an absent one (TASK-610 W4-R)', () => {
    const ENV_KEY = 'CORS_ALLOWED_ORIGINS';
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env[ENV_KEY];
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = originalEnv;
      }
    });

    it('ACCEPTS when the registry is empty but the origin is in the CORS_ALLOWED_ORIGINS bootstrap fallback', async () => {
      process.env[ENV_KEY] = 'https://arcaai-u2204.bcmch.org,https://mi-preproduction.bcmch.org:4433';
      const emptyRegistry = createMockOriginRegistry(new Set());
      const gateway = buildGateway(emptyRegistry);
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      expect(emptyRegistry.size).toHaveBeenCalled();
      // The empty registry's `has()` would have said no — the bootstrap
      // fallback is what must decide here, not a direct `has()` call.
      expect(client.close).not.toHaveBeenCalled();
      expect(gateway.getActiveSessionCount()).toBe(1);
    });

    it('REJECTS when the registry is empty and the origin is NOT in the CORS_ALLOWED_ORIGINS bootstrap fallback', async () => {
      process.env[ENV_KEY] = 'https://arcaai-u2204.bcmch.org';
      const emptyRegistry = createMockOriginRegistry(new Set());
      const gateway = buildGateway(emptyRegistry);
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://evil.example.com') as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
      expect(gateway.getActiveSessionCount()).toBe(0);
    });

    it('REJECTS when the registry is empty and CORS_ALLOWED_ORIGINS is unset entirely', async () => {
      delete process.env[ENV_KEY];
      const emptyRegistry = createMockOriginRegistry(new Set());
      const gateway = buildGateway(emptyRegistry);
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
    });

    it('logs loudly when falling back on an empty registry (operator visibility)', async () => {
      process.env[ENV_KEY] = 'https://arcaai-u2204.bcmch.org';
      const emptyRegistry = createMockOriginRegistry(new Set());
      const gateway = buildGateway(emptyRegistry);
      const client = createMockSocket();
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      const messages = warnSpy.mock.calls.map((args) => args[0]);
      const fallbackLog = messages.find(
        (m) => typeof m === 'object' && m !== null && String((m as { message?: string }).message).includes('registry empty'),
      );
      expect(fallbackLog).toBeDefined();
    });

    it('a NON-EMPTY registry is unchanged: still accepts a registered origin regardless of CORS_ALLOWED_ORIGINS content', async () => {
      process.env[ENV_KEY] = ''; // deliberately not covering the origin
      const gateway = buildGateway(mockOriginRegistry); // pre-seeded with the SYSTEM origin
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://arcaai-u2204.bcmch.org') as any);

      expect(mockOriginRegistry.size).toHaveBeenCalled();
      expect(mockOriginRegistry.has).toHaveBeenCalledWith('https://arcaai-u2204.bcmch.org');
      expect(client.close).not.toHaveBeenCalled();
    });

    it('a NON-EMPTY registry is unchanged: still rejects an unregistered origin even when it IS in CORS_ALLOWED_ORIGINS', async () => {
      // A non-empty registry legitimately answering "no" must NOT fall
      // through to the env allow-list — only size() === 0 triggers the
      // bootstrap fallback.
      process.env[ENV_KEY] = 'https://evil.example.com';
      const gateway = buildGateway(mockOriginRegistry); // non-empty, does not contain evil.example.com
      const client = createMockSocket();

      await gateway.handleConnection(client as any, buildReq('sess-origin', 'https://evil.example.com') as any);

      expect(client.close).toHaveBeenCalledWith(WS_CLOSE_CODES.AUTH_FAILED, WS_GENERIC_AUTH_REASON);
    });
  });
});
