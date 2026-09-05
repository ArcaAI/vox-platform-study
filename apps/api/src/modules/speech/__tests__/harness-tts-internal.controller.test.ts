import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { HarnessTtsInternalController } from '../harness-tts-internal.controller';

// A WAV-shaped fixture built from parts rather than a string literal: the four zero bytes of
// a RIFF size field are real NULs, and embedding them in the source makes git treat this
// file as BINARY -- no diff, no review.
const AUDIO = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEpayload')]);

const createHttp = (response?: unknown) => ({
  axiosRef: {
    post: vi.fn().mockResolvedValue(
      response ?? {
        data: AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.byteLength),
        headers: {
          'content-type': 'audio/wav',
          'x-tts-provider': 'azure',
          'x-tts-characters': '23',
          'x-tts-audio-seconds': '1.5',
        },
      },
    ),
  },
});

const createConfig = (url: string | undefined = 'http://localhost:8865') => ({
  getConfigValue: vi.fn((key: string) => (key === 'TTS_URL' ? url : undefined)),
});

/** `cls.run(fn)` must actually invoke `fn` — every read below happens inside it. */
const createCls = () => {
  const store: Record<string, unknown> = {};
  return {
    run: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    set: vi.fn((k: string, v: unknown) => {
      store[k] = v;
    }),
    get: vi.fn((k: string) => store[k]),
    _store: store,
  };
};

const AGENT = { slug: 'clinic-voice', versionId: 'a1', versionNumber: 2, tenantId: 'tenant-a', source: 'tenant' };

const SPEC = {
  schemaVersion: 1,
  agent: AGENT,
  primary: {
    kind: 'primary',
    runtimeKey: 'a1',
    agent: AGENT,
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
      voices: [{ id: 'clinical-en-1', locale: 'en-US', providerVoice: 'en-US-JennyNeural', refAudioPath: null, refText: null }],
    },
    parameters: { voice: 'clinical-en-1', language: 'en', speed: 1.1, format: 'wav', sampleRate: 24000, ssml: false },
    voice: { id: 'clinical-en-1', locale: 'en-US', providerVoice: 'en-US-JennyNeural', refAudioPath: null, refText: null },
    connection: { provider: 'azure', baseUrl: null, region: 'eastus', timeoutS: null, funding: 'tenant' },
    fundingTier: 'tenant',
  },
  fallback: { autoSwitch: true, chain: [] },
};

const createTtsAgentResolver = () => ({
  resolve: vi.fn().mockResolvedValue({ spec: SPEC, providerOverrides: { azure: { api_key: 'k', region: 'eastus', funding: 'tenant' } } }),
});

const createUsageLedger = () => ({ recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o1'], events: 1 }) });
const createEntitlements = () => ({ assertMeterQuota: vi.fn().mockResolvedValue(undefined) });

const build = (over: Partial<Record<string, unknown>> = {}) => {
  const deps = {
    http: createHttp(),
    config: createConfig(),
    cls: createCls(),
    secrets: { getSecretSync: vi.fn(() => 'tts-token') },
    resolver: createTtsAgentResolver(),
    ledger: createUsageLedger(),
    entitlements: createEntitlements(),
    ...over,
  } as any;
  const controller = new HarnessTtsInternalController(deps.http, deps.config, deps.cls, deps.secrets, deps.resolver, deps.ledger, deps.entitlements);
  return { controller, deps };
};

const REQUEST = { tenantId: 'tenant-a', text: 'Take two tablets daily.', voice: 'clinical-en-1' } as any;

describe('HarnessTtsInternalController — the agentic.tts synthesis dispatch', () => {
  it('returns the whole artifact base64-encoded, with its content type', async () => {
    const { controller } = build();
    const result = await controller.synthesize(REQUEST);
    expect(Buffer.from(result.audioBase64, 'base64')).toEqual(AUDIO);
    expect(result.contentType).toBe('audio/wav');
    expect(result.provider).toBe('azure');
    expect(result.characters).toBe(23);
  });

  it('re-establishes tenant CLS from the body, because the harness calls out-of-band of the edge middleware', async () => {
    const { controller, deps } = build();
    await controller.synthesize(REQUEST);
    expect(deps.cls.run).toHaveBeenCalled();
    expect(deps.cls.set).toHaveBeenCalledWith('tenantId', 'tenant-a');
  });

  it('injects the tenant`s resolved TEXT_TO_SPEECH agent and its credentials', async () => {
    const { controller, deps } = build();
    await controller.synthesize(REQUEST);
    expect(deps.resolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-a', agentSlug: null, departmentId: null });
    const [, body] = deps.http.axiosRef.post.mock.calls[0];
    expect(body).toMatchObject({
      input: 'Take two tablets daily.',
      voice: 'clinical-en-1',
      response_format: 'wav',
      speed: 1.1,
      resolved_spec: SPEC,
      provider_overrides: { azure: { api_key: 'k', region: 'eastus', funding: 'tenant' } },
    });
    // The `TenantTtsConfig` fold is gone, not merely unused.
    for (const gone of ['routing_en', 'routing_ml', 'allowed_providers', 'voice_bindings']) {
      expect(gone in body).toBe(false);
    }
  });

  it('lets the node`s own format and speed win over the agent`s parameters', async () => {
    const { controller, deps } = build();
    await controller.synthesize({ ...REQUEST, format: 'pcm', speed: 0.75 });
    const [, body] = deps.http.axiosRef.post.mock.calls[0];
    expect(body.response_format).toBe('pcm');
    expect(body.speed).toBe(0.75);
  });

  it('presents the SHARED internal token, never a user credential', async () => {
    const { controller, deps } = build();
    await controller.synthesize(REQUEST);
    const [, , options] = deps.http.axiosRef.post.mock.calls[0];
    expect(options.headers['X-Service-Token']).toBe('tts-token');
    expect(options.responseType).toBe('arraybuffer');
    // TASK-879/880 — the ONE shared `INTERNAL_ACCESS_TOKEN`; the per-service `TTS_SERVICE_TOKEN` fallback is retired.
    // the migration fallback, so a deployment that configured only the legacy name keeps working.
    expect(deps.secrets.getSecretSync).toHaveBeenCalledWith('INTERNAL_ACCESS_TOKEN');
  });


  it('checks the monthly character allowance BEFORE any upstream call', async () => {
    const order: string[] = [];
    const entitlements = {
      assertMeterQuota: vi.fn(async () => {
        order.push('quota');
      }),
    };
    const http = createHttp();
    http.axiosRef.post.mockImplementation(async () => {
      order.push('upstream');
      return { data: new ArrayBuffer(8), headers: {} };
    });
    const { controller } = build({ entitlements, http });
    await controller.synthesize(REQUEST);
    expect(order).toEqual(['quota', 'upstream']);
    // Unicode CODE POINTS, the CHARACTER unit's own counting rule.
    expect(entitlements.assertMeterQuota).toHaveBeenCalledWith('tenant-a', 'monthlyTtsCharacters', 23);
  });

  it('does not synthesize at all when the quota check throws', async () => {
    const entitlements = {
      assertMeterQuota: vi.fn().mockRejectedValue(new Error('QuotaExceeded')),
    };
    const { controller, deps } = build({ entitlements });
    await expect(controller.synthesize(REQUEST)).rejects.toThrow('QuotaExceeded');
    expect(deps.http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('stamps a usage row whose funding is DERIVED from the override the cascade supplied', async () => {
    const { controller, deps } = build();
    await controller.synthesize(REQUEST);
    expect(deps.ledger.recordUsage).toHaveBeenCalledTimes(1);
    const [event] = deps.ledger.recordUsage.mock.calls[0];
    expect(event.common).toMatchObject({ tenantId: 'tenant-a', operation: 'tts.synthesize', provider: 'azure' });
    expect(event.units).toEqual(expect.arrayContaining([expect.objectContaining({ quantity: 23 }), expect.objectContaining({ quantity: 1.5 })]));
  });

  it('never lets a metering failure surface to the caller — synthesis already happened', async () => {
    const ledger = { recordUsage: vi.fn().mockRejectedValue(new Error('ledger down')) };
    const { controller } = build({ ledger });
    await expect(controller.synthesize(REQUEST)).resolves.toBeDefined();
  });

  it('fails CLOSED on an agent-resolution error — there is no service-side default left', async () => {
    // `apps/tts` refuses a request with no resolved spec, so degrading here would turn an
    // attributable 404/409 into an opaque downstream 503 in a Temporal activity's logs.
    const resolver = { resolve: vi.fn().mockRejectedValue(new Error('No published TEXT_TO_SPEECH agent is assigned for this tenant.')) };
    const { controller, deps } = build({ resolver });
    await expect(controller.synthesize(REQUEST)).rejects.toThrow('No published TEXT_TO_SPEECH agent');
    expect(deps.http.axiosRef.post).not.toHaveBeenCalled();
  });

  it('maps an upstream failure to an HTTP error and never echoes the upstream body (PHI)', async () => {
    const http = createHttp();
    http.axiosRef.post.mockRejectedValue({
      response: { status: 503, data: { detail: 'synthesis failed for: patient reports chest pain' } },
    });
    const { controller } = build({ http });
    await expect(controller.synthesize(REQUEST)).rejects.toThrowError(HttpException);
    await controller.synthesize(REQUEST).catch((err: HttpException) => {
      expect(err.getStatus()).toBe(503);
      expect(JSON.stringify(err.getResponse())).not.toContain('chest pain');
    });
  });

  it('refuses when TTS is not wired on this deployment', async () => {
    // Built inline rather than via `createConfig(undefined)` — a default parameter would
    // silently restore the URL and the test would assert nothing.
    const { controller } = build({ config: { getConfigValue: vi.fn(() => undefined) } });
    await expect(controller.synthesize(REQUEST)).rejects.toThrow(/not wired/);
  });
});
