// TASK-610 §4C — the WS CSWSH check is DORMANT while origin enforcement is off.
//
// `stt-ws.gateway.origin.task610.test.ts` pins the ENFORCING behaviour (and
// installs `setOriginEnforcementResolver(() => true)` to get it). This file pins
// the OFF state: an unregistered `Origin` completes the handshake, and the
// registry is never consulted.
//
// The off state is NO LONGER THE DEFAULT — TASK-641 FR-6 flipped
// `origin.enforcementEnabled` to default `true`. Every case below sets the
// resolver explicitly, so none of them changed; `null` here is this process's
// pre-boot state, not the platform posture.
//
// §4C.3 flags this as the surface that would concern us most if `credentials`
// were ever set back to `true` — browsers exempt WebSockets from CORS entirely,
// so nothing upstream checks `Origin` for a WS handshake. That is exactly why
// `credentials: false` (see `cors.config.enforcement.task610.test.ts`) is part
// of the same change: with no ambient cookies, a hostile page's socket carries
// no credentials to hijack.
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setOriginEnforcementResolver } from '../../../cors.config';
import { SttWsGateway } from '../stt-ws.gateway';

const createMockSocket = () => ({
  send: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  readyState: 1,
  OPEN: 1,
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
    return { userId: 'user-123', tenantId: 'tenant-abc', scope: 'stt_session:sess-origin', exp: Date.now() + 30_000, impersonatedBy: null };
  }),
});

const createMockSessionBinding = () => ({
  bind: vi.fn().mockResolvedValue(undefined),
  bindSessionMeta: vi.fn().mockResolvedValue(undefined),
  lookup: vi.fn().mockResolvedValue('tenant-abc'),
  lookupSessionMeta: vi.fn().mockResolvedValue(null),
  clear: vi.fn().mockResolvedValue(undefined),
});

const createMockRemovalRetry = () => ({ enqueue: vi.fn() });

/** Registers nothing — so any acceptance below can only come from the switch. */
const createEmptyOriginRegistry = () => ({
  tenantsFor: vi.fn(() => new Set<string>()),
  has: vi.fn(() => false),
  allows: vi.fn(() => false),
  refresh: vi.fn().mockResolvedValue(undefined),
  size: vi.fn(() => 0),
});

const buildReq = (sessionId: string, origin?: string) => ({
  url: `/ws/stt/stream?sessionId=${sessionId}&ticket=valid-ticket`,
  headers: origin === undefined ? {} : { origin },
});

describe('SttWsGateway — origin enforcement disabled (TASK-610 §4C)', () => {
  let originRegistry: ReturnType<typeof createEmptyOriginRegistry>;

  const buildGateway = (): SttWsGateway =>
    new SttWsGateway(
      createMockSessionService() as never,
      createMockBridgeService() as never,
      createMockStreamTicketService() as never,
      createMockSessionBinding() as never,
      createMockRemovalRetry() as never,
      undefined,
      originRegistry as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    setOriginEnforcementResolver(null);
    originRegistry = createEmptyOriginRegistry();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    setOriginEnforcementResolver(null);
    vi.restoreAllMocks();
  });

  it('accepts a handshake from an UNREGISTERED origin', async () => {
    const gateway = buildGateway();
    const client = createMockSocket();

    await gateway.handleConnection(client as never, buildReq('sess-origin', 'https://evil.example.com') as never);

    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(1);
  });

  it('never consults the origin registry', async () => {
    const gateway = buildGateway();

    await gateway.handleConnection(createMockSocket() as never, buildReq('sess-origin', 'https://evil.example.com') as never);

    expect(originRegistry.has).not.toHaveBeenCalled();
    expect(originRegistry.size).not.toHaveBeenCalled();
  });

  it('accepts when the enforcement resolver THROWS — a broken settings cache must not sever transcription', async () => {
    setOriginEnforcementResolver(() => {
      throw new Error('settings cache exploded');
    });
    const gateway = buildGateway();
    const client = createMockSocket();

    await gateway.handleConnection(client as never, buildReq('sess-origin', 'https://evil.example.com') as never);

    expect(client.close).not.toHaveBeenCalled();
    expect(gateway.getActiveSessionCount()).toBe(1);
  });

  it('rejects again the moment the switch flips on — no restart', async () => {
    setOriginEnforcementResolver(() => true);
    const gateway = buildGateway();
    const client = createMockSocket();

    await gateway.handleConnection(client as never, buildReq('sess-origin', 'https://evil.example.com') as never);

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(gateway.getActiveSessionCount()).toBe(0);
  });
});
