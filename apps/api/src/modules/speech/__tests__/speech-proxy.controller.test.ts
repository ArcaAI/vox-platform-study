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

  // TASK-879 — the resolved TEXT_TO_SPEECH agent replaces the `TenantTtsConfig` fold. The
  // forwarded body carries `resolved_spec` (engine chain, model, voices, connections, governance)
  // and, beside it, the decrypted credentials — never on it.
  describe('POST /speech/synthesize — resolved-agent injection', () => {
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
        parameters: { voice: 'af_heart', language: 'en', speed: 0.9, format: 'wav', sampleRate: 24000, ssml: false },
        voice: { id: 'af_heart', locale: 'en-US', providerVoice: null, refAudioPath: null, refText: null },
        connection: { provider: 'kokoro', baseUrl: null, region: null, timeoutS: null, funding: 'platform' },
        fundingTier: 'platform',
      },
      fallback: { autoSwitch: true, chain: [] },
    };

    const makeResolver = (overrides?: Record<string, unknown>) => ({
      resolve: vi.fn().mockResolvedValue({ spec: SPEC, ...(overrides ? { providerOverrides: overrides } : {}) }),
    });

    const makeCls = () => ({ get: vi.fn((key: string) => (key === 'tenantId' ? 't1' : undefined)) });

    const buildController = (resolver: unknown) =>
      new SpeechProxyController(http as any, config as any, createMockSecrets('svc-token') as any, resolver as any, makeCls() as any);

    it('forwards the resolved spec and drops the retired TenantTtsConfig fold', async () => {
      const resolver = makeResolver();
      const ctrl = buildController(resolver);
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });

      await ctrl.synthesize({ input: 'Hi.' } as any, makeRes());

      expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: 't1', agentSlug: null, departmentId: null });
      const body = http.axiosRef.post.mock.calls[0][1];
      expect(body.resolved_spec).toEqual(SPEC);
      for (const gone of ['routing_en', 'routing_ml', 'allowed_providers', 'voice_bindings']) {
        expect(gone in body).toBe(false);
      }
    });

    it('passes an explicit agentSlug to the resolver and strips it from the forwarded body', async () => {
      // It is a SELECTOR for this gateway; what `apps/tts` receives is the RESOLUTION.
      const resolver = makeResolver();
      const ctrl = buildController(resolver);
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });

      await ctrl.synthesize({ input: 'Hi.', agentSlug: 'clinic-voice' } as any, makeRes());

      expect(resolver.resolve).toHaveBeenCalledWith({ tenantId: 't1', agentSlug: 'clinic-voice', departmentId: null });
      expect('agentSlug' in http.axiosRef.post.mock.calls[0][1]).toBe(false);
    });

    it('fills format and speed from the agent, and lets a caller-supplied value win', async () => {
      const ctrl = buildController(makeResolver());
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });

      await ctrl.synthesize({ input: 'Hi.' } as any, makeRes());
      expect(http.axiosRef.post.mock.calls[0][1]).toMatchObject({ response_format: 'wav', speed: 0.9 });

      http.axiosRef.post.mockClear();
      await ctrl.synthesize({ input: 'Hi.', response_format: 'mp3', speed: 1.5 } as any, makeRes());
      expect(http.axiosRef.post.mock.calls[0][1]).toMatchObject({ response_format: 'mp3', speed: 1.5 });
    });

    it('injects provider_overrides BESIDE the spec, never on it', async () => {
      const OVERRIDES = { azure: { api_key: 'THE-KEY', funding: 'tenant', region: 'eastus' } };
      const ctrl = buildController(makeResolver(OVERRIDES));
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });

      await ctrl.synthesize({ input: 'Hi.' } as any, makeRes());

      const body = http.axiosRef.post.mock.calls[0][1];
      expect(body.provider_overrides).toEqual(OVERRIDES);
      expect(JSON.stringify(body.resolved_spec)).not.toContain('THE-KEY');
    });

    it('omits provider_overrides when the resolved map is empty', async () => {
      const ctrl = buildController(makeResolver());
      http.axiosRef.post.mockResolvedValue({ headers: { 'content-type': 'audio/pcm' }, data: makeStream() });

      await ctrl.synthesize({ input: 'Hi.' } as any, makeRes());

      expect('provider_overrides' in http.axiosRef.post.mock.calls[0][1]).toBe(false);
    });

    it('FAILS CLOSED — an unresolvable agent propagates instead of degrading to a service default', async () => {
      // There is no service-side default left: `apps/tts` refuses a request with no spec. Swallowing
      // this would turn an attributable 404 (unknown or foreign agent) into an opaque downstream
      // 503, which is the diagnosis the agent-first path exists to make possible.
      const failing = { resolve: vi.fn().mockRejectedValue(new Error('Agent not found')) };
      const ctrl = buildController(failing);

      await expect(ctrl.synthesize({ input: 'Hi.' } as any, makeRes())).rejects.toThrow('Agent not found');
      expect(http.axiosRef.post).not.toHaveBeenCalled();
    });
  });

  // Gateway emits CHARACTER + AUDIO_SECOND usage rows using the
  // headers tts's /audio/speech endpoint surfaces (X-Tts-Characters,
  // X-Tts-Provider, X-Tts-Sample-Rate, X-Tts-Audio-Format, and — batch only —
  // X-Tts-Audio-Seconds). Streaming responses don't carry a final duration
  // header (unknowable before headers commit), so the gateway derives it from
  // the byte count it observes while proxying, using the SAME PCM/WAV byte
  // math tts uses internally.
  describe('POST /speech/synthesize — usage-ledger emission', () => {
    const buildController = (usageLedger: unknown = createMockUsageLedger(), cls: unknown = createMockCls()) =>
      new SpeechProxyController(http as any, config as any, createMockSecrets('svc-token') as any, undefined, cls as any, usageLedger as any);

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

    it('A PLATFORM-FUNDED override is deployment CLOUD, not BYOK', async () => {
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

    it('An override for a DIFFERENT provider never marks this call BYOK', async () => {
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
