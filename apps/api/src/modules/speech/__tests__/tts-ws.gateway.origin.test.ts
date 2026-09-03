// CSWSH guard for the TTS WebSocket handshake.
//
// Browsers do not apply CORS to WebSocket handshakes, so `tts-ws.gateway.ts`
// must consult the SAME origin registry the CORS callback uses
// (`cors.config.ts`) before accepting a connection. Ported verbatim in posture
// from `stt-ws.gateway.origin.task610.test.ts` — separate leaf file, colocated
// with but distinct from the pre-existing `tts-ws.gateway.test.ts`.
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setOriginEnforcementResolver } from '../../../cors.config';
import { TTS_WS_CLOSE_CODES, TTS_WS_GENERIC_AUTH_REASON, TtsWsGateway } from '../tts-ws.gateway';

type Handler = (...args: unknown[]) => void;

const makeSocket = () => {
  const handlers: Record<string, Handler[]> = {};
  return {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: vi.fn(),
    close: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    bufferedAmount: 0,
    on: vi.fn((ev: string, cb: Handler) => {
      (handlers[ev] ||= []).push(cb);
    }),
    emit: (ev: string, ...args: unknown[]) => {
      (handlers[ev] || []).forEach((cb) => cb(...args));
    },
  };
};

const createMockTicketService = () => ({
  issueTicket: vi.fn(),
  consumeTicket: vi.fn(async (ticket: string) => {
    if (!ticket || ticket === 'invalid') return null;
    return { userId: 'u1', tenantId: 't1', scope: 'tts_session:sess-1', exp: Date.now() + 30_000, impersonatedBy: null };
  }),
});

const createMockConfig = () => ({
  getConfigValue: vi.fn((k: string) => (k === 'TTS_URL' ? 'http://tts:8865' : '')),
});

// The gateway only ever calls `has()` and `size()` — it does no tenant
// binding, so `tenantsFor`/`allows` exist here only to satisfy the shape of
// the real interface and are never asserted on.
const createMockOriginRegistry = (registered: Set<string> = new Set(['https://arcaai-u2204.bcmch.org'])) => ({
  tenantsFor: vi.fn((origin: string) => (registered.has(origin) ? new Set(['SYSTEM']) : new Set())),
  has: vi.fn((origin: string) => registered.has(origin)),
  allows: vi.fn((origin: string) => registered.has(origin)),
  refresh: vi.fn().mockResolvedValue(undefined),
  size: vi.fn(() => registered.size),
});

const buildReq = (origin?: string, qs = '?sessionId=sess-1&ticket=valid') => ({
  url: `/ws/tts/stream${qs}`,
  headers: origin === undefined ? {} : { origin },
});

describe('TtsWsGateway — origin registry CSWSH guard (G-1)', () => {
  let ticketService: ReturnType<typeof createMockTicketService>;
  let config: ReturnType<typeof createMockConfig>;
  let originRegistry: ReturnType<typeof createMockOriginRegistry>;
  let upstream: ReturnType<typeof makeSocket>;

  const buildGateway = (registry?: ReturnType<typeof createMockOriginRegistry>): TtsWsGateway => {
    const gateway = new TtsWsGateway(
      ticketService as never,
      config as never,
      undefined, // secretsService
      undefined, // tenantTtsConfig
      undefined, // providerConnectionService
      undefined, // usageLedger
      undefined, // entitlementsService
      registry as never,
    );
    upstream = makeSocket();
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
    return gateway;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // The CSWSH check is dormant unless `origin.enforcementEnabled` is on.
    // Enforcement ships ON (descriptor default `true`), but `cors.config.ts`
    // has no resolver installed in a unit test — the descriptor default
    // reaches it only through `PlatformKnobsBinder` — so arm it explicitly.
    setOriginEnforcementResolver(() => true);
    ticketService = createMockTicketService();
    config = createMockConfig();
    originRegistry = createMockOriginRegistry();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setOriginEnforcementResolver(null);
  });

  it('accepts the handshake when the Origin header is registered', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq('https://arcaai-u2204.bcmch.org') as never);

    expect(originRegistry.has).toHaveBeenCalledWith('https://arcaai-u2204.bcmch.org');
    expect(ticketService.consumeTicket).toHaveBeenCalledWith('valid');
    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.createUpstreamSocket).toHaveBeenCalled();
  });

  it('refuses an unregistered Origin with the gateway generic 4401, burning no ticket and opening no upstream socket', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq('https://evil.example.com') as never);

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, TTS_WS_GENERIC_AUTH_REASON);
    expect(ticketService.consumeTicket).not.toHaveBeenCalled();
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('runs the origin check BEFORE ticket consumption (ordering, not just outcome)', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq('https://arcaai-u2204.bcmch.org') as never);

    const hasOrder = originRegistry.has.mock.invocationCallOrder[0];
    const consumeOrder = ticketService.consumeTicket.mock.invocationCallOrder[0];
    expect(hasOrder).toBeDefined();
    expect(consumeOrder).toBeDefined();
    expect(hasOrder).toBeLessThan(consumeOrder);
  });

  it('rejects an unregistered origin even when sessionId and ticket are absent (check is first, not last)', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq('https://evil.example.com', '') as never);

    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, TTS_WS_GENERIC_AUTH_REASON);
    expect(originRegistry.has).toHaveBeenCalledWith('https://evil.example.com');
  });

  it('denies fail-closed when the registry is absent (@Optional() not provided)', async () => {
    const gateway = buildGateway(undefined);
    const client = makeSocket();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();

    await gateway.handleConnection(client as never, buildReq('https://arcaai-u2204.bcmch.org') as never);

    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, TTS_WS_GENERIC_AUTH_REASON);
    expect(ticketService.consumeTicket).not.toHaveBeenCalled();
    const unavailable = warnSpy.mock.calls
      .map((args) => args[0])
      .find((m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_unavailable');
    expect(unavailable).toBeDefined();
  });

  it('denies fail-closed when the registry is present but EMPTY (size === 0), under the "unavailable" reason', async () => {
    const empty = createMockOriginRegistry(new Set());
    const gateway = buildGateway(empty);
    const client = makeSocket();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();

    await gateway.handleConnection(client as never, buildReq('https://arcaai-u2204.bcmch.org') as never);

    expect(empty.size).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, TTS_WS_GENERIC_AUTH_REASON);
    const unavailable = warnSpy.mock.calls
      .map((args) => args[0])
      .find((m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_unavailable');
    expect(unavailable).toBeDefined();
  });

  it('denies fail-closed when the registry lookup THROWS, with no unhandled rejection', async () => {
    originRegistry.has.mockImplementationOnce(() => {
      throw new Error('malformed input');
    });
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await expect(gateway.handleConnection(client as never, buildReq('not a valid origin!!') as never)).resolves.not.toThrow();

    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, TTS_WS_GENERIC_AUTH_REASON);
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('logs the ordinary per-origin "miss" reason (not "unavailable") when a populated registry says no', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    warnSpy.mockClear();

    await gateway.handleConnection(client as never, buildReq('https://evil.example.com') as never);

    const messages = warnSpy.mock.calls.map((args) => args[0]);
    expect(
      messages.find((m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_miss'),
    ).toBeDefined();
    expect(
      messages.find((m) => typeof m === 'object' && m !== null && (m as { reason?: string }).reason === 'origin_registry_unavailable'),
    ).toBeUndefined();
    // The operator needs the offending origin itself, not just a reason.
    expect(
      messages.find((m) => typeof m === 'object' && m !== null && (m as { origin?: string }).origin === 'https://evil.example.com'),
    ).toBeDefined();
  });

  it('accepts a handshake with NO Origin header (non-browser caller — CSWSH rides an auto-attached header it never sent)', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq(undefined) as never);

    expect(originRegistry.has).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.createUpstreamSocket).toHaveBeenCalled();
  });

  it('accepts a handshake whose Origin header is an empty string (treated as absent, same guard)', async () => {
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq('') as never);

    expect(originRegistry.has).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it('admits every origin WITHOUT consulting the registry while enforcement is OFF', async () => {
    setOriginEnforcementResolver(() => false);
    const gateway = buildGateway(originRegistry);
    const client = makeSocket();

    await gateway.handleConnection(client as never, buildReq('https://evil.example.com') as never);

    expect(originRegistry.has).not.toHaveBeenCalled();
    expect(originRegistry.size).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.createUpstreamSocket).toHaveBeenCalled();
  });

  it('closes an origin rejection byte-identically to the missing-ticket and scope-mismatch rejections (no enumeration signal)', async () => {
    const originRejected = makeSocket();
    const missingTicket = makeSocket();
    const scopeMismatch = makeSocket();

    const g1 = buildGateway(originRegistry);
    await g1.handleConnection(originRejected as never, buildReq('https://evil.example.com') as never);

    const g2 = buildGateway(originRegistry);
    await g2.handleConnection(missingTicket as never, buildReq('https://arcaai-u2204.bcmch.org', '?sessionId=sess-1') as never);

    const g3 = buildGateway(originRegistry);
    await g3.handleConnection(scopeMismatch as never, buildReq('https://arcaai-u2204.bcmch.org', '?sessionId=OTHER&ticket=valid') as never);

    expect(originRejected.close.mock.calls).toEqual(missingTicket.close.mock.calls);
    expect(originRejected.close.mock.calls).toEqual(scopeMismatch.close.mock.calls);
  });
});
