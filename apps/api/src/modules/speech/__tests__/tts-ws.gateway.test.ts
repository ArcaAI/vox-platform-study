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
  describe('init-frame agent enrichment', () => {
    const SPEC = {
      schemaVersion: 1,
      agent: { slug: 'platform-tts', versionId: 'a1', versionNumber: 1, tenantId: '00000000-0000-0000-0000-000000000000', source: 'platform-default' },
      primary: {
        kind: 'primary',
        runtimeKey: 'a1',
        agent: { slug: 'platform-tts', versionId: 'a1', versionNumber: 1, tenantId: '00000000-0000-0000-0000-000000000000', source: 'platform-default' },
        model: {
          role: 'primary',
          slug: 'kokoro',
          taskType: 'TEXT_TO_SPEECH',
          format: 'PYTORCH',
          sourceUri: 'hexgrad/Kokoro-82M',
          sourceRevision: null,
          localPath: null,
          checksum: null,
          computeType: null,
          provider: 'kokoro',
          tenantId: '00000000-0000-0000-0000-000000000000',
          artifacts: {},
          voices: [{ id: 'af_heart', locale: 'en-US', providerVoice: null, refAudioPath: null, refText: null }],
        },
        parameters: { voice: 'af_heart', language: 'en', speed: 1.25, format: 'pcm', sampleRate: 24000, ssml: false },
        voice: { id: 'af_heart', locale: 'en-US', providerVoice: null, refAudioPath: null, refText: null },
        connection: { provider: 'kokoro', baseUrl: null, region: null, timeoutS: null, funding: 'platform' },
        fundingTier: 'platform',
      },
      fallback: { autoSwitch: true, chain: [] },
    };

    const makeResolver = (overrides: Record<string, unknown> = {}) => ({
      resolve: vi.fn().mockResolvedValue({ spec: SPEC, ...(Object.keys(overrides).length > 0 ? { providerOverrides: overrides } : {}) }),
    });

    const lastUpstreamTextFrame = () => {
      const calls = (upstream.send as ReturnType<typeof vi.fn>).mock.calls;
      const call = calls[calls.length - 1];
      return JSON.parse(String(call?.[0]));
    };

    it('injects the resolved TEXT_TO_SPEECH agent into the first init frame', async () => {
      const resolver = makeResolver();
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, resolver as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init"}'), false);

      expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: 't1', agentSlug: null, departmentId: null });
      const frame = lastUpstreamTextFrame();
      expect(frame.type).toBe('init');
      expect(frame.resolved_spec).toEqual(SPEC);
      // …and the agent's own speed becomes the session default.
      expect(frame.speed).toBe(1.25);
      // The `TenantTtsConfig` fold is GONE, not merely unused: an injected routing chain would
      // be a second authority over which engine speaks.
      expect('routing_en' in frame).toBe(false);
      expect('voice_bindings' in frame).toBe(false);
      expect('allowed_providers' in frame).toBe(false);
    });

    it('lets a client-supplied speed win over the agent`s', async () => {
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, makeResolver() as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init","speed":0.8}'), false);

      expect(lastUpstreamTextFrame().speed).toBe(0.8);
    });

    it('opens the socket anyway when the agent will not resolve — the session ends in an error frame, not a 4401', async () => {
      // Refusing the handshake would report an agent-configuration problem as an AUTH failure:
      // every rejection on this socket is deliberately byte-identical, so the cause would be
      // invisible to the operator and to the user. `apps/tts` refuses an init frame with no spec,
      // which the browser client renders as `provider_unavailable`.
      const failing = { resolve: vi.fn().mockRejectedValue(new Error('no published TEXT_TO_SPEECH agent')) };
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, failing as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      const raw = Buffer.from('{"type":"init","voice":"en-female-1"}');
      client.emit('message', raw, false);

      expect(client.close).not.toHaveBeenCalled();
      expect(upstream.send).toHaveBeenCalledWith(raw, { binary: false });
    });

    it('injects provider_overrides beside the spec, never on it', async () => {
      const OVERRIDES = { sarvam: { api_key: 'THE-KEY', funding: 'tenant', base_url: 'https://vpc.sarvam' } };
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, makeResolver(OVERRIDES) as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init"}'), false);

      const frame = lastUpstreamTextFrame();
      expect(frame.provider_overrides).toEqual(OVERRIDES);
      // A credential must not travel on a document anything downstream might persist or log.
      expect(JSON.stringify(frame.resolved_spec)).not.toContain('THE-KEY');
    });

    it('omits provider_overrides when the resolved map is empty', async () => {
      gateway = new TtsWsGateway(ticketService as never, config as never, secrets as never, makeResolver() as never);
      gateway.createUpstreamSocket = vi.fn(() => upstream as never);
      const client = makeSocket();
      await gateway.handleConnection(client as never, req('?sessionId=sess-1&ticket=t'));
      upstream.emit('open');

      client.emit('message', Buffer.from('{"type":"init"}'), false);

      expect('provider_overrides' in lastUpstreamTextFrame()).toBe(false);
    });
  });

  // Tts sends a final {"type":"usage",...} control frame at
  // session teardown (success OR abort — see stream_ws.py). The gateway
  // consumes it to emit CHARACTER + AUDIO_SECOND ledger rows and — since the
  // browser client's protocol has no "usage" message type — strips it from
  // the upstream→client relay so the SDK never sees an unrecognized frame.
  describe('usage-frame consumption', () => {
    const createMockUsageLedger = () => ({ recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) });

    const buildGateway = (usageLedger: unknown) =>
      new TtsWsGateway(ticketService as never, config as never, secrets as never, undefined, usageLedger as never);

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

    const resolverWith = (overrides: Record<string, unknown>) => ({
      resolve: vi.fn().mockResolvedValue({
        spec: {
          schemaVersion: 1,
          agent: { slug: 'tenant-tts', versionId: 'a1', versionNumber: 1, tenantId: 't1', source: 'tenant' },
          primary: {
            kind: 'primary',
            runtimeKey: 'a1',
            agent: { slug: 'tenant-tts', versionId: 'a1', versionNumber: 1, tenantId: 't1', source: 'tenant' },
            model: {
              role: 'primary',
              slug: 'azure-neural-voices',
              taskType: 'TEXT_TO_SPEECH',
              format: 'AZURE_SPEECH',
              sourceUri: 'azure://neural-voices',
              sourceRevision: null,
              localPath: null,
              checksum: null,
              computeType: null,
              provider: 'azure',
              tenantId: '00000000-0000-0000-0000-000000000000',
              artifacts: {},
              voices: [{ id: 'en-IN-NeerjaNeural', locale: 'en-IN', providerVoice: null, refAudioPath: null, refText: null }],
            },
            parameters: { voice: 'en-IN-NeerjaNeural', language: 'en', speed: null, format: null, sampleRate: null, ssml: false },
            voice: { id: 'en-IN-NeerjaNeural', locale: 'en-IN', providerVoice: null, refAudioPath: null, refText: null },
            connection: { provider: 'azure', baseUrl: null, region: 'eastus', timeoutS: null, funding: 'platform' },
            fundingTier: 'platform',
          },
          fallback: { autoSwitch: true, chain: [] },
        },
        providerOverrides: overrides,
      }),
    });

    it('classifies a BYOK-resolved provider as deployment BYOK / costBasis BYOK_NOTIONAL', async () => {
      const usageLedger = createMockUsageLedger();
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        resolverWith({ azure: { api_key: 'k', funding: 'tenant' } }) as never,
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

    it('A PLATFORM-FUNDED override resolves to deployment CLOUD, not BYOK', async () => {
      // Same bridge, same resolved agent — the only difference is WHOSE credential the resolver
      // supplied. A SYSTEM-tenant (platform) key is platform vendor spend, so it must reach the
      // COGS rollups.
      const usageLedger = createMockUsageLedger();
      gateway = new TtsWsGateway(
        ticketService as never,
        config as never,
        secrets as never,
        resolverWith({ azure: { api_key: 'k', funding: 'platform' } }) as never,
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
