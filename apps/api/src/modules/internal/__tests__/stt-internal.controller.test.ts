/**
 * `SttInternalController.ensureInternalApiKey`
 * runtime guard, pinned via the typed `RequestWithAuth` parameter.
 *
 * Previously the controller read `request['apiKey']` via bracket-notation;
 * a typo (`request['aip_key']`) would silently resolve to `undefined`
 * and skip the auth check. The new typed dot-access (`request.apiKey`)
 * makes that typo a TypeScript error. This test pins the runtime
 * behaviour the typed interface guards.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AsrAgentResolverService, ProviderVetoedException } from '@arcaai/applications';
import { QuotaExceededException } from '@arcaai/exceptions';
import { SttInternalController } from '../stt-internal.controller';

describe('SttInternalController.ensureInternalApiKey', () => {
  let controller: SttInternalController;
  let sttInternalService: any;

  beforeEach(() => {
    sttInternalService = {
      createTranscript: vi.fn(),
      startJob: vi.fn(),
      updateProgress: vi.fn(),
      completeJob: vi.fn(),
      failJob: vi.fn(),
      getJobStatus: vi.fn(),
      createAudioRecord: vi.fn(),
      createMedia: vi.fn(),
    };
    controller = new SttInternalController(sttInternalService);
  });

  it('throws UnauthorizedException when `apiKey` is undefined on the request', async () => {
    const request = {} as any;
    await expect(controller.createTranscript(request, {} as any)).rejects.toThrow(UnauthorizedException);
    expect(sttInternalService.createTranscript).not.toHaveBeenCalled();
  });

  it('proceeds to the service when `apiKey` is set on the request', async () => {
    const request = { apiKey: { id: 'key-1' } } as any;
    sttInternalService.createTranscript.mockResolvedValue({ id: 'tx-1' });

    const result = await controller.createTranscript(request, { contextItemId: 'c-1' } as any);

    expect(result).toEqual({ id: 'tx-1' });
    expect(sttInternalService.createTranscript).toHaveBeenCalledWith({ contextItemId: 'c-1' }, undefined);
  });

  // F-09: the forward-compatible `Idempotency-Key` header STT-v2 already
  // sends is now read through (`@Headers('idempotency-key')`) and passed to
  // the service so the streaming-transcript create path can dedup a
  // concurrent/retried finalize instead of silently duplicating.
  it('reads the Idempotency-Key header and passes it through to the service', async () => {
    const request = { apiKey: { id: 'key-1' } } as any;
    sttInternalService.createTranscript.mockResolvedValue({ id: 'tx-2' });

    const result = await controller.createTranscript(request, { consultationId: 'c-2' } as any, 'consultation-2:session-9');

    expect(result).toEqual({ id: 'tx-2' });
    expect(sttInternalService.createTranscript).toHaveBeenCalledWith({ consultationId: 'c-2' }, 'consultation-2:session-9');
  });

  it('does NOT accept a typo field (e.g., `aip_key`) as a substitute for `apiKey`', async () => {
    // Runtime regression for the typo class: even though `request.aip_key`
    // is set, the controller MUST read `request.apiKey` and reject. The
    // typed `RequestWithAuth` interface enforces this at compile-time;
    // this test makes the runtime expectation explicit too.
    const request = { aip_key: { id: 'typo-key' } } as any;
    await expect(controller.createTranscript(request, {} as any)).rejects.toThrow(UnauthorizedException);
  });

  // POST internal/stt/media: register a storage object as Media.
  describe('createMedia', () => {
    it('throws UnauthorizedException when `apiKey` is undefined', async () => {
      const request = {} as any;
      await expect(controller.createMedia(request, {} as any)).rejects.toThrow(UnauthorizedException);
      expect(sttInternalService.createMedia).not.toHaveBeenCalled();
    });

    it('delegates to the service and returns the created media id when authorized', async () => {
      const request = { apiKey: { id: 'key-1' } } as any;
      const dto = { tenantId: 't-1', name: 'x.wav', uri: 's3://b/x.wav', extension: 'wav', mimeType: 'audio/wav', size: 10, hash: '' } as any;
      sttInternalService.createMedia.mockResolvedValue({ id: 'media-1' });

      const result = await controller.createMedia(request, dto);

      expect(result).toEqual({ id: 'media-1' });
      expect(sttInternalService.createMedia).toHaveBeenCalledWith(dto);
    });
  });
});

/**
 * The batch-worker BYO credential PULL route (TASK-861 follow-up): a tenant's
 * cloud STT credentials resolve through TASK-862's `ProviderCredentialResolver`
 * — tenant row → SYSTEM fallback, funding DERIVED from the row that served —
 * via `AsrAgentResolverService.resolveProviderOverrides` (the same loop the
 * session / batch entry points use), inside a tenant-pinned CLS context. The
 * wire shape `apps/stt` parses (`{provider: {api_key, funding, ...}}`) is unchanged.
 *
 * These cases run the REAL loop over a mocked one-credential resolver, so what
 * they pin is the route's behaviour end to end, not a mock of the loop.
 */
describe('SttInternalController.getProviderOverrides', () => {
  const TENANT = '50000000-0000-0000-0000-000000000001';
  const request = { apiKey: { id: 'key-1' } } as any;
  let sttInternalService: any;
  let credentials: { resolve: ReturnType<typeof vi.fn> };
  let cls: any;
  let controller: SttInternalController;

  const binding = (funding: 'tenant' | 'platform', override: Record<string, unknown>) => ({
    override: { funding, ...override },
    fundingTier: funding,
    connectionId: `conn-${funding}`,
  });

  beforeEach(() => {
    sttInternalService = { createTranscript: vi.fn() };
    credentials = { resolve: vi.fn().mockResolvedValue(null) };
    // Minimal CLS: `run` invokes the callback synchronously, `set` records the tenant.
    cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
    const asrResolver = new AsrAgentResolverService({} as never, credentials as never);
    controller = new SttInternalController(sttInternalService, asrResolver, cls);
  });

  it('rejects when the internal API key is absent (service-to-service gate)', async () => {
    await expect(controller.getProviderOverrides({} as any, TENANT)).rejects.toThrow(UnauthorizedException);
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('400s when tenantId is missing', async () => {
    await expect(controller.getProviderOverrides(request, undefined)).rejects.toThrow(BadRequestException);
    expect(credentials.resolve).not.toHaveBeenCalled();
  });

  it('400s when the ASR agent resolver is not wired — never a silent empty map', async () => {
    const unwired = new SttInternalController(sttInternalService, undefined, cls);
    await expect(unwired.getProviderOverrides(request, TENANT)).rejects.toThrow(BadRequestException);
  });

  it('resolves every cloud STT provider through the ONE resolver inside a tenant-pinned CLS context; funding is the tier that served', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) => {
      if (provider === 'azure-speech') return binding('tenant', { api_key: 'k-tenant', region: 'eastus' });
      if (provider === 'sarvam') return binding('platform', { api_key: 'k-platform', base_url: 'https://api.sarvam.ai', model: 'saarika:v2' });
      return null; // openai: no row at either tier
    });

    const result = await controller.getProviderOverrides(request, TENANT);

    expect(cls.run).toHaveBeenCalledTimes(1);
    expect(cls.set).toHaveBeenCalledWith('tenantId', TENANT);
    expect(credentials.resolve.mock.calls).toEqual([
      ['stt', 'azure-speech', TENANT],
      ['stt', 'sarvam', TENANT],
      ['stt', 'openai', TENANT],
    ]);
    // The tenant's own row → `tenant`; the SYSTEM platform default → `platform`;
    // no row anywhere → no key (the BYOK-only STT loader then fails closed).
    expect(result).toEqual({
      'azure-speech': { api_key: 'k-tenant', funding: 'tenant', region: 'eastus' },
      sarvam: { api_key: 'k-platform', funding: 'platform', base_url: 'https://api.sarvam.ai', model: 'saarika:v2' },
    });
    expect('openai' in result).toBe(false);
  });

  it('a DISABLED tenant row is a veto for THAT provider: absent from the map (no tier serves it) while the others still resolve', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) => {
      if (provider === 'sarvam') throw new ProviderVetoedException('stt', 'sarvam', TENANT);
      if (provider === 'azure-speech') return binding('tenant', { api_key: 'k-tenant', region: 'eastus' });
      return binding('platform', { api_key: 'k-openai-platform' });
    });

    const result = await controller.getProviderOverrides(request, TENANT);

    expect(Object.keys(result).sort()).toEqual(['azure-speech', 'openai']);
    expect(result.sarvam).toBeUndefined();
    // A veto on one provider does not block the pull for the others.
    expect(credentials.resolve).toHaveBeenCalledTimes(3);
  });

  it('an unentitled platform default is a refusal for that provider only (absent) — never a substituted credential', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) => {
      if (provider === 'openai') {
        throw new QuotaExceededException('not entitled', { capability: 'platformDefaultCredential', limit: 0, used: 0, requested: 1 });
      }
      return binding('tenant', { api_key: `k-${provider}` });
    });
    const result = await controller.getProviderOverrides(request, TENANT);
    expect(Object.keys(result).sort()).toEqual(['azure-speech', 'sarvam']);
  });

  it('a backend fault propagates — it is never disguised as "no credential"', async () => {
    credentials.resolve.mockRejectedValueOnce(new Error('vault transit unavailable'));
    await expect(controller.getProviderOverrides(request, TENANT)).rejects.toThrow('vault transit unavailable');
  });

  it('forwards the resolver’s wire entry verbatim (the shape apps/stt parses) — funding included and never restamped', async () => {
    credentials.resolve.mockImplementation(async (_service: string, provider: string) =>
      provider === 'azure-speech'
        ? binding('platform', { api_key: 'k', region: 'eastus', endpoint: 'https://x.cognitiveservices.azure.com', api_version: '2024-11-15' })
        : null,
    );
    const result = await controller.getProviderOverrides(request, TENANT);
    expect(result).toEqual({
      'azure-speech': { api_key: 'k', funding: 'platform', region: 'eastus', endpoint: 'https://x.cognitiveservices.azure.com', api_version: '2024-11-15' },
    });
  });
});

/**
 * BUG-013 — the worker's job-lifecycle callbacks must resolve a job owned by
 * ANY tenant, not only the tenant that happens to own the internal API-key row.
 *
 * The worker now forwards `X-Internal-Tenant-Id`; the controller pins CLS to it so the
 * tenant-scoped Prisma extension filters on the job's real owner. Because that
 * turns a caller-supplied header into a tenant selector, the pin is honoured
 * ONLY for a caller presenting the platform internal credential
 * (`X-Internal-Service-Key` === `API_GATEWAY_KEY`) — otherwise any tenant SDK
 * key could drive another tenant's job by asserting a header.
 */
describe('SttInternalController tenant pinning (BUG-013)', () => {
  const GATEWAY_KEY = 'internal-gateway-secret';
  const TENANT = '50000000-0000-0000-0000-000000000001';

  let sttInternalService: any;
  let cls: any;
  let secretsService: any;
  let controller: SttInternalController;

  const requestWith = (internalKey?: string) =>
    ({
      apiKey: { id: 'key-1' },
      headers: internalKey ? { 'x-internal-service-key': internalKey } : {},
    }) as any;

  beforeEach(() => {
    sttInternalService = {
      createTranscript: vi.fn().mockResolvedValue({ contextItemId: 'ci-1' }),
      startJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'PROCESSING' }),
      updateProgress: vi.fn().mockResolvedValue({ id: 'job-1' }),
      completeJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'COMPLETED' }),
      failJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'FAILED' }),
      getJobStatus: vi.fn().mockResolvedValue({ status: 'PROCESSING' }),
    };
    cls = { run: vi.fn((fn: () => unknown) => fn()), set: vi.fn() };
    secretsService = { getSecretOptional: vi.fn().mockResolvedValue(GATEWAY_KEY) };
    controller = new SttInternalController(sttInternalService, undefined, cls, secretsService);
  });

  // Each lifecycle route: [name, invoke(tenantHeader, internalKey), assertion on the service call]
  const routes: Array<[string, (tenantId?: string, internalKey?: string) => Promise<unknown>, () => any]> = [
    ['startJob', (t, k) => controller.startJob(requestWith(k), 'job-1', { workerId: 'w-1' } as any, t), () => sttInternalService.startJob],
    ['updateProgress', (t, k) => controller.updateProgress(requestWith(k), 'job-1', { progress: 50 } as any, t), () => sttInternalService.updateProgress],
    ['completeJob', (t, k) => controller.completeJob(requestWith(k), 'job-1', { resultText: 'x' } as any, t), () => sttInternalService.completeJob],
    ['failJob', (t, k) => controller.failJob(requestWith(k), 'job-1', { errorMessage: 'boom' } as any, t), () => sttInternalService.failJob],
    ['getJobStatus', (t, k) => controller.getJobStatus(requestWith(k), 'job-1', t), () => sttInternalService.getJobStatus],
    ['createTranscript', (t, k) => controller.createTranscript(requestWith(k), { jobId: 'job-1' } as any, undefined, t), () => sttInternalService.createTranscript],
  ];

  for (const [name, invoke, serviceFn] of routes) {
    it(`${name}: pins CLS to the forwarded X-Internal-Tenant-Id when the platform internal credential is presented`, async () => {
      await invoke(TENANT, GATEWAY_KEY);

      expect(cls.run).toHaveBeenCalledTimes(1);
      expect(cls.set).toHaveBeenCalledWith('tenantId', TENANT);
      expect(serviceFn()).toHaveBeenCalledTimes(1);
    });

    it(`${name}: leaves CLS untouched when no X-Internal-Tenant-Id is forwarded (backward compatible)`, async () => {
      await invoke(undefined, GATEWAY_KEY);

      expect(cls.run).not.toHaveBeenCalled();
      expect(cls.set).not.toHaveBeenCalled();
      expect(serviceFn()).toHaveBeenCalledTimes(1);
    });

    it(`${name}: refuses the tenant pin for a caller that is not the platform internal credential`, async () => {
      await expect(invoke(TENANT, 'some-tenant-sdk-key')).rejects.toThrow(ForbiddenException);

      expect(cls.run).not.toHaveBeenCalled();
      expect(serviceFn()).not.toHaveBeenCalled();
    });
  }

  it('fails closed when the internal gateway secret is not configured', async () => {
    secretsService.getSecretOptional.mockResolvedValue(undefined);

    await expect(controller.startJob(requestWith(GATEWAY_KEY), 'job-1', { workerId: 'w-1' } as any, TENANT)).rejects.toThrow(ForbiddenException);
    expect(sttInternalService.startJob).not.toHaveBeenCalled();
  });

  it('still requires an API key before any tenant pin is considered', async () => {
    const request = { headers: { 'x-internal-service-key': GATEWAY_KEY } } as any;

    await expect(controller.startJob(request, 'job-1', { workerId: 'w-1' } as any, TENANT)).rejects.toThrow(UnauthorizedException);
    expect(sttInternalService.startJob).not.toHaveBeenCalled();
  });
});

/**
 * BUG-013 follow-up — the pin header name is load-bearing.
 *
 * The first cut of the fix read `@Headers('x-tenant-id')`, which never reached
 * the controller at runtime: the global `ContextInterceptor` rejects an
 * `x-tenant-id` that diverges from the authenticated principal's tenant with a
 * 400, and the worker's API-key row carries a `userId`, so CLS *does* hold a
 * user and that guard *does* fire. The unit tests above call the handlers
 * directly, so they cannot see that — hence this source-level pin, matching the
 * precedent in `apps/api/src/__tests__/secrets-migration.test.ts`.
 */
describe('SttInternalController tenant-pin header name (BUG-013)', () => {
  const src = readFileSync(join(__dirname, '..', 'stt-internal.controller.ts'), 'utf8');

  it('reads the pin from the internal-only `x-internal-tenant-id` header', () => {
    expect(src).toContain("@Headers('x-internal-tenant-id')");
  });

  it('never reads `x-tenant-id`, which ContextInterceptor rejects for this caller', () => {
    expect(src).not.toContain("@Headers('x-tenant-id')");
  });
});
