import { Logger } from '@nestjs/common';
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

const createMockConfig = () => ({
  getConfigValue: vi.fn((k: string) => (k === 'TTS_URL' ? 'http://tts:8865' : '')),
});

const createMockSecrets = () => ({
  getSecretSync: vi.fn((k: string) => (k === 'TTS_SERVICE_TOKEN' ? 'svc-token' : undefined)),
});

const req = (qs: string) => ({ url: `/ws/tts/stream${qs}` }) as never;

describe('TtsWsGateway', () => {
  let gateway: TtsWsGateway;
  let ticketService: ReturnType<typeof createMockTicketService>;
  let config: ReturnType<typeof createMockConfig>;
  let secrets: ReturnType<typeof createMockSecrets>;
  let upstream: ReturnType<typeof makeSocket>;

  beforeEach(() => {
    vi.clearAllMocks();
    ticketService = createMockTicketService();
    config = createMockConfig();
    secrets = createMockSecrets();
    gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never);
    upstream = makeSocket();
    gateway.createUpstreamSocket = vi.fn(() => upstream as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  it('rejects a handshake missing sessionId with a generic 4401', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?ticket=t'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('rejects a handshake missing ticket with a generic 4401', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
  });

  it('rejects an invalid ticket with a generic 4401', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=invalid'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
    expect(gateway.createUpstreamSocket).not.toHaveBeenCalled();
  });

  it('rejects a scope mismatch with a generic 4401', async () => {
    const client = makeSocket();
    ticketService.consumeTicket.mockResolvedValueOnce({
      userId: 'u1',
      tenantId: 't1',
      scope: 'tts_session:OTHER',
      exp: Date.now() + 30_000,
      impersonatedBy: null,
    } as never);
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.AUTH_FAILED, expect.any(String));
  });

  it('opens the upstream at the ws URL with the service token on a valid ticket', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    expect(gateway.createUpstreamSocket).toHaveBeenCalledWith('ws://tts:8865/api/v1/audio/stream', {
      'X-Service-Token': 'svc-token',
    });
    expect(client.close).not.toHaveBeenCalled();
  });

  it('buffers client control frames until the upstream opens, then flushes them', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    // Client sends init BEFORE the upstream socket opens.
    client.emit('message', Buffer.from('{"type":"init"}'), false);
    expect(upstream.send).not.toHaveBeenCalled();
    // Upstream opens → buffered frame is flushed.
    upstream.emit('open');
    expect(upstream.send).toHaveBeenCalledWith(Buffer.from('{"type":"init"}'), { binary: false });
    // A later frame forwards live.
    client.emit('message', Buffer.from('{"type":"end"}'), false);
    expect(upstream.send).toHaveBeenCalledWith(Buffer.from('{"type":"end"}'), { binary: false });
  });

  it('relays upstream binary audio frames to the browser verbatim', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    upstream.emit('open');
    const pcm = Buffer.from([1, 2, 3, 4]);
    upstream.emit('message', pcm, true);
    expect(client.send).toHaveBeenCalledWith(pcm, { binary: true });
  });

  it('closes the upstream when the browser disconnects', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    gateway.handleDisconnect(client as never);
    expect(upstream.close).toHaveBeenCalled();
  });

  it('closes the browser socket when the upstream errors', async () => {
    const client = makeSocket();
    await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
    upstream.emit('error', new Error('upstream boom'));
    expect(client.close).toHaveBeenCalledWith(TTS_WS_CLOSE_CODES.UPSTREAM_ERROR);
  });

  // The first `init` frame is additionally enriched with the
  // tenant's resolved `voice_bindings` (mirrors the batch speech proxy).
  describe('init-frame voice_bindings enrichment', () => {
    const BINDINGS = { 'en-female-1': { azure: 'en-IN-NeerjaNeural' } };

    const makeTenantTtsConfig = (voiceBindings: Record<string, Record<string, string>>) => ({
      getEffective: vi.fn().mockResolvedValue({
        tenantId: 't1',
        defaultFormat: 'pcm',
        defaultSpeed: 1.0,
        routingEn: ['azure'],
        routingMl: ['azure'],
        allowedProviders: ['azure'],
        voiceBindings,
      }),
    });

    // TASK-643 — the resolver returns `{overrides, platformDefault?}` (two
    // tiers merged per provider), not a bare map.
    const makeProviderConnectionService = (overrides: Record<string, unknown> = {}) => ({
      resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides }),
    });

    const lastUpstreamTextFrame = () => {
      const calls = (upstream.send as ReturnType<typeof vi.fn>).mock.calls;
      const call = calls[calls.length - 1];
      return JSON.parse(String(call?.[0]));
    };

    it('injects voice_bindings into the first init frame when non-empty', async () => {
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        makeTenantTtsConfig(BINDINGS) as never,
        makeProviderConnectionService() as never,
      );
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init","voice":"en-female-1"}'), false);

      const frame = lastUpstreamTextFrame();
      expect(frame.type).toBe('init');
      expect(frame.voice_bindings).toEqual(BINDINGS);
      expect(frame.routing_en).toEqual(['azure']);
    });

    it('omits voice_bindings when the resolved bindings map is empty', async () => {
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        makeTenantTtsConfig({}) as never,
        makeProviderConnectionService() as never,
      );
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init","voice":"en-female-1"}'), false);

      const frame = lastUpstreamTextFrame();
      expect(frame.type).toBe('init');
      expect('voice_bindings' in frame).toBe(false);
    });

    it('fails open — a config resolve error relays the init frame verbatim', async () => {
      const failing = {
        getEffective: vi.fn().mockRejectedValue(new Error('config db down')),
      };
      const failingProviders = { resolveTenantCloudOverrides: vi.fn().mockRejectedValue(new Error('config db down')) };
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, failing as never, failingProviders as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      const raw = Buffer.from('{"type":"init","voice":"en-female-1"}');
      client.emit('message', raw, false);

      expect(upstream.send).toHaveBeenCalledWith(raw, { binary: false });
    });

    // TASK-570 — provider_overrides now resolves through the unified
    // IProviderConnectionService (`service='tts'`). Shape unchanged (C4).
    it('injects provider_overrides into the first init frame via IProviderConnectionService', async () => {
      const OVERRIDES = { sarvam: { api_key: 'THE-KEY', funding: 'tenant', base_url: 'https://vpc.sarvam' } };
      const providerConnectionService = makeProviderConnectionService(OVERRIDES);
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        makeTenantTtsConfig({}) as never,
        providerConnectionService as never,
      );
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init","voice":"en-female-1"}'), false);

      expect(providerConnectionService.resolveTenantCloudOverrides).toHaveBeenCalledWith('tts', 't1');
      const frame = lastUpstreamTextFrame();
      expect(frame.provider_overrides).toEqual(OVERRIDES);
    });

    it('omits provider_overrides when the resolved map is empty', async () => {
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        makeTenantTtsConfig({}) as never,
        makeProviderConnectionService({}) as never,
      );
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init","voice":"en-female-1"}'), false);

      const frame = lastUpstreamTextFrame();
      expect('provider_overrides' in frame).toBe(false);
    });
  });

  // TASK-615 WS-E: tts sends a final {"type":"usage",...} control frame at
  // session teardown (success OR abort — see stream_ws.py). The gateway
  // consumes it to emit CHARACTER + AUDIO_SECOND ledger rows and — since the
  // browser client's protocol has no "usage" message type — strips it from
  // the upstream→client relay so the SDK never sees an unrecognized frame.
  describe('usage-frame consumption (TASK-615 WS-E)', () => {
    const createMockUsageLedger = () => ({ recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) });

    const buildGateway = (usageLedger: unknown) =>
      new TtsWsGateway(ticketService as never, config as never, secrets as never, undefined, undefined, usageLedger as never);

    it('emits CHARACTER + AUDIO_SECOND from the usage frame and does not relay it to the browser', async () => {
      const usageLedger = createMockUsageLedger();
      gateway = buildGateway(usageLedger);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      const usageFrame = Buffer.from(
        JSON.stringify({ type: 'usage', characters: 10, audioSeconds: 0.2, interrupted: false, provider: 'azure' }),
      );
      upstream.emit('message', usageFrame, false);

      expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({
        tenantId: 't1',
        capability: 'TTS',
        operation: 'tts.synthesize',
        provider: 'azure',
        deployment: 'CLOUD',
        sessionId: 'sess-1',
        attributesJson: { interrupted: false },
      });
      expect(call.units).toEqual(
        expect.arrayContaining([
          { unit: 'CHARACTER', quantity: 10 },
          { unit: 'AUDIO_SECOND', quantity: 0.2 },
        ]),
      );
      // Never forwarded to the browser — its protocol doesn't expect it.
      expect(client.send).not.toHaveBeenCalledWith(usageFrame, { binary: false });
    });

    it('omits AUDIO_SECOND when tts reports null (nothing was ever synthesized)', async () => {
      const usageLedger = createMockUsageLedger();
      gateway = buildGateway(usageLedger);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      upstream.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: null, interrupted: true, provider: null })),
        false,
      );

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.units).toEqual([{ unit: 'CHARACTER', quantity: 4 }]);
      expect(call.common.attributesJson).toEqual({ interrupted: true });
    });

    it('classifies a BYOK-resolved provider as deployment BYOK / costBasis BYOK_NOTIONAL', async () => {
      const usageLedger = createMockUsageLedger();
      // Both tenantTtsConfig AND providerConnectionService must be present —
      // openBridge() only resolves provider_overrides when the FIRST is set.
      const tenantTtsConfig = {
        getEffective: vi.fn().mockResolvedValue({
          tenantId: 't1',
          defaultFormat: 'pcm',
          defaultSpeed: 1.0,
          routingEn: ['azure'],
          routingMl: ['azure'],
          allowedProviders: ['azure'],
          voiceBindings: {},
        }),
      };
      const providerConnectionService = {
        resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides: { azure: { api_key: 'k', funding: 'tenant' } } }),
      };
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        tenantTtsConfig as never,
        providerConnectionService as never,
        usageLedger as never,
      );
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      upstream.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: 0.1, interrupted: false, provider: 'azure' })),
        false,
      );

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({ provider: 'azure', deployment: 'BYOK', costBasis: 'BYOK_NOTIONAL' });
    });

    it('TASK-643 R3: a PLATFORM-FUNDED override resolves to deployment CLOUD, not BYOK', async () => {
      // Same bridge, same injected init frame — the only difference is WHOSE
      // credential the resolver supplied. A SYSTEM-tenant (platform) key is
      // platform vendor spend, so it must reach the COGS rollups (OD-2).
      const usageLedger = createMockUsageLedger();
      const tenantTtsConfig = {
        getEffective: vi.fn().mockResolvedValue({
          tenantId: 't1',
          defaultFormat: 'pcm',
          defaultSpeed: 1.0,
          routingEn: ['azure'],
          routingMl: ['azure'],
          allowedProviders: ['azure'],
          voiceBindings: {},
        }),
      };
      const providerConnectionService = {
        resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides: { azure: { api_key: 'k', funding: 'platform' } } }),
      };
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        tenantTtsConfig as never,
        providerConnectionService as never,
        usageLedger as never,
      );
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      upstream.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: 0.1, interrupted: false, provider: 'azure' })),
        false,
      );

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({ provider: 'azure', deployment: 'CLOUD' });
      expect(call.common.costBasis).toBeUndefined();
    });

    it('classifies a self-hosted engine as deployment SELF_HOSTED with no costBasis', async () => {
      const usageLedger = createMockUsageLedger();
      gateway = buildGateway(usageLedger);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      upstream.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: 0.1, interrupted: false, provider: 'kokoro' })),
        false,
      );

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({ provider: 'kokoro', deployment: 'SELF_HOSTED' });
      expect(call.common.costBasis).toBeUndefined();
    });

    it('does nothing when IUsageLedgerService is absent (fail-open, positional construction)', async () => {
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      const usageFrame = Buffer.from(JSON.stringify({ type: 'usage', characters: 4, audioSeconds: 0.1, interrupted: false, provider: 'kokoro' }));
      // Must not throw even though there's no ledger to call.
      upstream.emit('message', usageFrame, false);
      expect(client.send).not.toHaveBeenCalledWith(usageFrame, { binary: false });
    });

    it('still relays binary audio frames and other JSON control frames normally', async () => {
      const usageLedger = createMockUsageLedger();
      gateway = buildGateway(usageLedger);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      const pcm = Buffer.from([1, 2, 3, 4]);
      upstream.emit('message', pcm, true);
      const doneFrame = Buffer.from('{"type":"done"}');
      upstream.emit('message', doneFrame, false);

      expect(client.send).toHaveBeenCalledWith(pcm, { binary: true });
      expect(client.send).toHaveBeenCalledWith(doneFrame, { binary: false });
    });
  });
});
