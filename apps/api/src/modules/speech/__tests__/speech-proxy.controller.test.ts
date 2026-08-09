import { EventEmitter } from 'node:events';

import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SpeechProxyController } from '../speech-proxy.controller';

const createMockHttpService = () => ({ axiosRef: { post: vi.fn(), get: vi.fn() } });

const createMockConfigService = () => ({
  getConfigValue: vi.fn((key: string) => (key === 'TTS_URL' ? 'http://localhost:8865' : undefined)),
});

const createMockSecrets = (token?: string) => ({ getSecretSync: vi.fn(() => token) });

const createMockUsageLedger = () => ({ recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) });

const createMockCls = (tenantId: string | undefined = 't1') => ({
  get: vi.fn((key: string) => (key === 'tenantId' ? tenantId : undefined)),
});

function makeStream() {
  const stream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  stream.destroy = vi.fn();
  return stream;
}

function makeRes() {
  // `on` actually registers handlers (a real-ish EventEmitter) so tests can
  // drive `res.emit('close', ...)` to simulate a client disconnect — the
  // original bare `vi.fn()` couldn't be triggered from a test.
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const res: any = {
    headersSent: false,
    setHeader: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => emitter.on(event, cb)),
    emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args),
    status: vi.fn(() => res),
    json: vi.fn(),
  };
  return res;
}

describe('SpeechProxyController', () => {
  let controller: SpeechProxyController;
  let http: ReturnType<typeof createMockHttpService>;
  let config: ReturnType<typeof createMockConfigService>;

  beforeEach(() => {
    vi.clearAllMocks();
    http = createMockHttpService();
    config = createMockConfigService();
    controller = new SpeechProxyController(http as any, config as any, createMockSecrets('svc-token') as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GET /speech/voices', () => {
    it('proxies to TTS /api/v1/voices with the service token and returns data', async () => {
      http.axiosRef.get.mockResolvedValue({ data: { voices: [{ id: 'en-female-1' }] } });
      const result = await controller.voices();
      expect(result).toEqual({ voices: [{ id: 'en-female-1' }] });
      expect(http.axiosRef.get).toHaveBeenCalledWith(
        'http://localhost:8865/api/v1/voices',
        expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Token': 'svc-token' }) }),
      );
    });

    it('maps an upstream error to an HttpException with the upstream status', async () => {
      http.axiosRef.get.mockRejectedValue({ response: { status: 503, data: 'boom' } });
      await expect(controller.voices()).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('POST /speech/synthesize', () => {
    it('streams upstream audio to the response with the right headers and body', async () => {
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: stream });
      const res = makeRes();

      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      expect(http.axiosRef.post).toHaveBeenCalledWith(
        'http://localhost:8865/api/v1/audio/speech',
        { input: 'Hi.', voice: 'en-female-1' },
        expect.objectContaining({
          responseType: 'stream',
          headers: expect.objectContaining({ 'X-Service-Token': 'svc-token' }),
        }),
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/pcm');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, no-transform');
      expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
      expect(res.flushHeaders).toHaveBeenCalled();

      stream.emit('data', Buffer.from('AB'));
      stream.emit('end');
      expect(res.write).toHaveBeenCalledTimes(1);
      expect(res.end).toHaveBeenCalled();
    });

    it('omits X-Service-Token when no secret is available (dev fail-open)', async () => {
      controller = new SpeechProxyController(http as any, config as any, createMockSecrets(undefined) as any);
      http.axiosRef.post.mockResolvedValue({ headers: {}, data: makeStream() });
      const res = makeRes();
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      const callHeaders = http.axiosRef.post.mock.calls[0][2].headers;
      expect(callHeaders['X-Service-Token']).toBeUndefined();
    });

    it('returns a generic status and never forwards the upstream body (PHI safety)', async () => {
      http.axiosRef.post.mockRejectedValue({ response: { status: 503, data: { detail: 'internal prompt echo' } } });
      const res = makeRes();
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({ detail: 'TTS service unavailable' });
      expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ detail: 'internal prompt echo' }));
    });

    it('retries a connect-phase failure then streams on success', async () => {
      vi.useFakeTimers();
      const stream = makeStream();
      http.axiosRef.post
        .mockRejectedValueOnce({ code: 'ECONNREFUSED' })
        .mockResolvedValueOnce({ headers: { 'content-type': 'audio/pcm' }, data: stream });
      const res = makeRes();
      const pending = controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      await vi.runAllTimersAsync();
      await pending;
      expect(http.axiosRef.post).toHaveBeenCalledTimes(2);
      expect(res.flushHeaders).toHaveBeenCalled();
    });

    it('does NOT retry when the upstream responded (request was delivered)', async () => {
      http.axiosRef.post.mockRejectedValue({ response: { status: 500, data: '' } });
      const res = makeRes();
      await controller.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      expect(http.axiosRef.post).toHaveBeenCalledTimes(1);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // The resolved effective config's voiceBindings are injected
  // into the forwarded body as `voice_bindings` (tts falls back to its
  // built-in DEFAULT_VOICES when absent). Fail-open posture unchanged.
  describe('POST /speech/synthesize — tenant config voice_bindings injection', () => {
    const BINDINGS = { 'en-female-1': { azure: 'en-IN-NeerjaNeural' }, 'ml-male-1': { azure: 'ml-IN-MidhunNeural' } };

    const makeEffective = (voiceBindings: Record<string, Record<string, string>>) => ({
      tenantId: 't1',
      defaultFormat: 'pcm',
      defaultSpeed: 1.0,
      routingEn: ['azure'],
      routingMl: ['azure'],
      allowedProviders: ['azure'],
      voiceBindings,
    });

    const makeTenantTtsConfig = (voiceBindings: Record<string, Record<string, string>>) => ({
      getEffective: vi.fn().mockResolvedValue(makeEffective(voiceBindings)),
    });

    // TASK-643 — the resolver returns the two-tier result `{overrides, platformDefault?}`,
    // not a bare map; entries carry `funding`.
    const makeProviderConnectionService = (overrides: Record<string, unknown> = {}) => ({
      resolveTenantCloudOverrides: vi.fn().mockResolvedValue({ overrides }),
    });

    const makeCls = () => ({ get: vi.fn((key: string) => (key === 'tenantId' ? 't1' : undefined)) });

    const buildController = (tenantTtsConfig: unknown, providerConnectionService: unknown = makeProviderConnectionService()) =>
      new SpeechProxyController(
        http as any,
        config as any,
        createMockSecrets('svc-token') as any,
        tenantTtsConfig as any,
        providerConnectionService as any,
        makeCls() as any,
      );

    it('injects voice_bindings from the effective config when non-empty', async () => {
      const tenantTtsConfig = makeTenantTtsConfig(BINDINGS);
      const ctrl = buildController(tenantTtsConfig);
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      const body = http.axiosRef.post.mock.calls[0][1];
      expect(body.voice_bindings).toEqual(BINDINGS);
      // The rest of the tenant-config injection is preserved.
      expect(body.routing_en).toEqual(['azure']);
      expect(body.allowed_providers).toEqual(['azure']);
    });

    it('omits voice_bindings when the effective bindings map is empty', async () => {
      const ctrl = buildController(makeTenantTtsConfig({}));
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      const body = http.axiosRef.post.mock.calls[0][1];
      expect('voice_bindings' in body).toBe(false);
    });

    // TASK-570 — provider_overrides now resolves through the unified
    // IProviderConnectionService (`service='tts'`) instead of
    // TenantTtsConfigService.resolveProviderOverrides. The injected
    // provider_overrides SHAPE is unchanged (C4 — byte-identical body).
    it('injects provider_overrides via IProviderConnectionService.resolveTenantCloudOverrides("tts", tenantId)', async () => {
      const OVERRIDES = { azure: { api_key: 'THE-KEY', funding: 'tenant', region: 'eastus' } };
      const providerConnectionService = makeProviderConnectionService(OVERRIDES);
      const ctrl = buildController(makeTenantTtsConfig({}), providerConnectionService);
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      expect(providerConnectionService.resolveTenantCloudOverrides).toHaveBeenCalledWith('tts', 't1');
      const body = http.axiosRef.post.mock.calls[0][1];
      // Byte-identical shape to the pre-unification TtsProviderOverrides body.
      expect(body.provider_overrides).toEqual(OVERRIDES);
    });

    it('omits provider_overrides when the resolved map is empty', async () => {
      const ctrl = buildController(makeTenantTtsConfig({}), makeProviderConnectionService({}));
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      const body = http.axiosRef.post.mock.calls[0][1];
      expect('provider_overrides' in body).toBe(false);
    });

    it('falls back to no overrides when IProviderConnectionService is absent (positional/internal construction)', async () => {
      const ctrl = buildController(makeTenantTtsConfig({}), undefined);
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      const body = http.axiosRef.post.mock.calls[0][1];
      expect('provider_overrides' in body).toBe(false);
    });

    it('FAILS OPEN — a config resolve error forwards the body without bindings', async () => {
      const tenantTtsConfig = {
        getEffective: vi.fn().mockRejectedValue(new Error('config db down')),
      };
      const ctrl = buildController(tenantTtsConfig);
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);

      const body = http.axiosRef.post.mock.calls[0][1];
      expect(body).toEqual({ input: 'Hi.', voice: 'en-female-1' });
    });
  });

  // TASK-615 WS-E: gateway emits CHARACTER + AUDIO_SECOND usage rows using the
  // headers tts's /audio/speech endpoint surfaces (X-Tts-Characters,
  // X-Tts-Provider, X-Tts-Sample-Rate, X-Tts-Audio-Format, and — batch only —
  // X-Tts-Audio-Seconds). Streaming responses don't carry a final duration
  // header (unknowable before headers commit), so the gateway derives it from
  // the byte count it observes while proxying, using the SAME PCM/WAV byte
  // math tts uses internally.
  describe('POST /speech/synthesize — usage-ledger emission (TASK-615 WS-E)', () => {
    const buildController = (usageLedger: unknown = createMockUsageLedger(), cls: unknown = createMockCls()) =>
      new SpeechProxyController(http as any, config as any, createMockSecrets('svc-token') as any, undefined, undefined, cls as any, usageLedger as any);

    it('emits CHARACTER + the EXACT AUDIO_SECOND from the batch response header', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: {
          'content-type': 'audio/pcm',
          'x-tts-characters': '6',
          'x-tts-provider': 'kokoro',
          'x-tts-sample-rate': '24000',
          'x-tts-audio-format': 'pcm',
          'x-tts-audio-seconds': '0.29166666666666663',
        },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hello.', voice: 'en-female-1' } as any, res);
      stream.emit('data', Buffer.alloc(14));
      stream.emit('end');

      expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({
        tenantId: 't1',
        capability: 'TTS',
        operation: 'tts.synthesize',
        provider: 'kokoro',
        deployment: 'SELF_HOSTED',
      });
      expect(call.units).toEqual(
        expect.arrayContaining([
          { unit: 'CHARACTER', quantity: 6 },
          { unit: 'AUDIO_SECOND', quantity: 0.29166666666666663 },
        ]),
      );
    });

    it('derives AUDIO_SECOND from the proxied byte count when the header is absent (raw stream mode)', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: {
          'content-type': 'audio/pcm',
          'x-tts-characters': '3',
          'x-tts-provider': 'kokoro',
          'x-tts-sample-rate': '24000',
          'x-tts-audio-format': 'pcm',
          // NO x-tts-audio-seconds — streaming mode.
        },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1', stream_format: 'audio' } as any, res);
      stream.emit('data', Buffer.alloc(9600)); // 9600 / (2*24000) = 0.2s
      stream.emit('end');

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.units).toEqual(
        expect.arrayContaining([
          { unit: 'CHARACTER', quantity: 3 },
          { unit: 'AUDIO_SECOND', quantity: 0.2 },
        ]),
      );
    });

    it('omits AUDIO_SECOND for mp3 (not derivable from a byte count, streaming mode)', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: {
          'content-type': 'audio/mpeg',
          'x-tts-characters': '3',
          'x-tts-provider': 'kokoro',
          'x-tts-sample-rate': '24000',
          'x-tts-audio-format': 'mp3',
        },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1', stream_format: 'audio', response_format: 'mp3' } as any, res);
      stream.emit('data', Buffer.alloc(9600));
      stream.emit('end');

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.units).toEqual([{ unit: 'CHARACTER', quantity: 3 }]);
    });

    it('classifies a BYOK-served provider: deployment BYOK, costBasis BYOK_NOTIONAL', async () => {
      // No tenantTtsConfig injected — applyTenantConfig() returns the body
      // unchanged, so a caller-supplied provider_overrides (as the browser
      // client would forward it, or as applyTenantConfig injects it in
      // production) passes through verbatim to the classification below.
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: {
          'content-type': 'audio/pcm',
          'x-tts-characters': '3',
          'x-tts-provider': 'azure',
          'x-tts-sample-rate': '24000',
          'x-tts-audio-format': 'pcm',
        },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1', provider_overrides: { azure: { api_key: 'k' } } } as any, res);
      stream.emit('end');

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({ provider: 'azure', deployment: 'BYOK', costBasis: 'BYOK_NOTIONAL' });
    });

    it('TASK-643 R3: a PLATFORM-FUNDED override is deployment CLOUD, not BYOK', async () => {
      // The cascade injects the SYSTEM-tenant platform credential for a tenant
      // that has none of its own. An override IS present — but the platform is
      // paying, so this must meter exactly like any other platform-funded
      // cloud call (OD-2), NOT as BYOK/BYOK_NOTIONAL (which contributes zero
      // to the COGS rollups and is never invoiced).
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: { 'content-type': 'audio/pcm', 'x-tts-characters': '3', 'x-tts-provider': 'azure', 'x-tts-sample-rate': '24000', 'x-tts-audio-format': 'pcm' },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1', provider_overrides: { azure: { api_key: 'k', funding: 'platform' } } } as any, res);
      stream.emit('end');

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({ provider: 'azure', deployment: 'CLOUD' });
      expect(call.common.costBasis).toBeUndefined();
    });

    it('TASK-643 R3: an override for a DIFFERENT provider never marks this call BYOK', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: { 'content-type': 'audio/pcm', 'x-tts-characters': '3', 'x-tts-provider': 'azure', 'x-tts-sample-rate': '24000', 'x-tts-audio-format': 'pcm' },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1', provider_overrides: { sarvam: { api_key: 'k' } } } as any, res);
      stream.emit('end');

      expect(usageLedger.recordUsage.mock.calls[0][0].common).toMatchObject({ provider: 'azure', deployment: 'CLOUD' });
    });

    it('classifies a cloud provider NOT covered by a BYOK override as deployment CLOUD', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: { 'content-type': 'audio/pcm', 'x-tts-characters': '3', 'x-tts-provider': 'azure', 'x-tts-sample-rate': '24000', 'x-tts-audio-format': 'pcm' },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      stream.emit('end');

      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common).toMatchObject({ provider: 'azure', deployment: 'CLOUD' });
      expect(call.common.costBasis).toBeUndefined();
    });

    it('marks attributesJson.interrupted=true when the client disconnects mid-stream', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: { 'content-type': 'audio/pcm', 'x-tts-characters': '3', 'x-tts-provider': 'kokoro', 'x-tts-sample-rate': '24000', 'x-tts-audio-format': 'pcm' },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      stream.emit('data', Buffer.alloc(100));
      res.emit('close'); // client disconnected — never emits 'end'

      expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
      const call = usageLedger.recordUsage.mock.calls[0][0];
      expect(call.common.attributesJson).toEqual({ interrupted: true });
    });

    it('never double-emits when both an error/close teardown occurs', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: { 'content-type': 'audio/pcm', 'x-tts-characters': '3', 'x-tts-provider': 'kokoro', 'x-tts-sample-rate': '24000', 'x-tts-audio-format': 'pcm' },
        data: stream,
      });
      const res = makeRes();

      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      stream.emit('end');
      res.emit('close'); // fires after 'end' too, in real Node — must be a no-op here

      expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    });

    it('emits nothing when IUsageLedgerService is absent (fail-open, positional construction)', async () => {
      const ctrl = new SpeechProxyController(http as any, config as any, createMockSecrets('svc-token') as any);
      const stream = makeStream();
      http.axiosRef.post.mockResolvedValue({
        headers: { 'content-type': 'audio/pcm', 'x-tts-characters': '3', 'x-tts-provider': 'kokoro' },
        data: stream,
      });
      const res = makeRes();

      // Must not throw even though there's no ledger to call.
      await ctrl.synthesize({ input: 'Hi.', voice: 'en-female-1' } as any, res);
      stream.emit('end');
    });

    it('emits nothing on an upstream error (e.g. 413) — no stream was ever established', async () => {
      const usageLedger = createMockUsageLedger();
      const ctrl = buildController(usageLedger);
      http.axiosRef.post.mockRejectedValue({ response: { status: 413, data: { detail: 'too long' } } });
      const res = makeRes();

      await ctrl.synthesize({ input: 'x'.repeat(5000), voice: 'en-female-1' } as any, res);

      expect(usageLedger.recordUsage).not.toHaveBeenCalled();
    });
  });
});
