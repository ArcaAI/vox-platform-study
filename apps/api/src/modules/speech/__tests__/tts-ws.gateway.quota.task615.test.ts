/**
 * TTS character-allowance PRE-FLIGHT on the WS-duplex gateway.
 *
 * Unlike the REST `synthesize` endpoint (the whole `input` string is known
 * upfront — see `speech-proxy.controller.quota.task615.test.ts`), a WS
 * session streams text incrementally (`init` → `text`* → `flush`/`end`) with
 * no fixed total known before the bridge opens. The check therefore uses
 * `increment: 0` — "is the tenant ALREADY over its allowance" — rather than
 * trying to predict an unbounded session's eventual character count. This
 * runs at `handleConnection`, BEFORE the upstream tts socket is ever opened
 * (before any synthesis can start), using the ticket's own `tenantId` (no
 * extra round-trip).
 */
import { Logger } from '@nestjs/common';
import { QuotaExceededException } from '@arcaai/exceptions';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TTS_WS_CLOSE_CODES, TtsWsGateway } from '../tts-ws.gateway';

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

const createMockConfig = () => ({ getConfigValue: vi.fn((k: string) => (k === 'TTS_URL' ? 'http://tts:8865' : '')) });
const createMockSecrets = () => ({ getSecretSync: vi.fn(() => undefined) });
const req = (qs: string) => ({ url: `/ws/tts/stream${qs}` }) as never;

describe('TtsWsGateway — TTS character quota pre-flight', () => {
  let ticketService: ReturnType<typeof createMockTicketService>;
  let config: ReturnType<typeof createMockConfig>;
  let secrets: ReturnType<typeof createMockSecrets>;

  beforeEach(() => {
    vi.clearAllMocks();
    ticketService = createMockTicketService();
    config = createMockConfig();
    secrets = createMockSecrets();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  function buildGateway(entitlements: unknown) {
    const gateway = new TtsWsGateway(
      ticketService as never,
      config as never,
      secrets as never,
      undefined, // ttsAgentResolver
      undefined, // usageLedger
      entitlements as never,
    );
    const upstream = makeSocket();
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
    return { gateway, upstream };
  }

  it('checks monthlyTtsCharacters with increment 0 (already-over check — a stream has no known total) using the TICKET tenantId', async () => {
    const entitlements = { assertMeterQuota: vi.fn().mockResolvedValue(undefined) };
    const { gateway, upstream } = buildGateway(entitlements);
    const client = makeSocket();

    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));

    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('t1', 'monthlyTtsCharacters', 0);
    expect(gateway.createUpstreamSocket).toHaveBeenCalled();
    void upstream;
  });

  it('REJECTS the handshake with a distinct close code when the allowance is already exhausted, and never opens the upstream socket', async () => {
    const entitlements = {
      assertMeterQuota: vi
        .fn()
        .mockRejectedValue(
          new QuotaExceededException('over allowance', { capability: 'monthlyTtsCharacters', limit: 1000, used: 1000, requested: 0, tenantId: 't1' }),
        ),
    };
    const { gateway } = buildGateway(entitlements);
    const client = makeSocket();

    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));

    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.QUOTA_EXCEEDED, expect.any(String));
    // Distinct from the generic auth-failure code — the ticket WAS valid and
    // the tenant IS identified; this is a capacity block, not an auth failure.
    expect(client.close).not.toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
  });

  it('proceeds normally (no-op) when entitlements is not wired (legacy positional fixtures)', async () => {
    const { gateway } = buildGateway(undefined);
    const client = makeSocket();

    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));

    expect(gateway.createUpstreamSocket).toHaveBeenCalled();
  });

  it('propagates an unexpected (non-quota) error rather than silently allowing the session', async () => {
    const entitlements = { assertMeterQuota: vi.fn().mockRejectedValue(new Error('db down')) };
    const { gateway } = buildGateway(entitlements);
    const client = makeSocket();

    await expect(gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'))).rejects.toThrow('db down');
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });
});
