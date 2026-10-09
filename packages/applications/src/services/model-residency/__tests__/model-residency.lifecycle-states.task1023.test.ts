import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { ModelResidencyService } from '../model-residency.service';
import { routeLmStudioThroughAgent } from './lmstudio-agent-route';

/**
 * The status-only residency read behind the tenant-visible registry view: which
 * service holds which model and in what state — nothing else. Ungated (a tenant
 * admin's registry list needs it), so it must carry no placement detail
 * (device, bytes, in-flight, request rates), no errors and no usage.
 */

const GiB = 1024 * 1024 * 1024;
const TENANT_A = '11111111-1111-1111-1111-111111111111';

function build(caller: { roles: string[]; tenantId: string | null }) {
  const catalogue = [
    {
      id: 'model-asr',
      slug: 'arcaai-whisper-ml-en-ggml',
      tenantId: SYSTEM_TENANT_ID,
      deploymentKind: 'SELF_HOSTED',
      resourceStatus: 'ENABLED',
      servedBy: 'stt',
      provider: 'built-in',
      wireModelId: null,
      format: 'WHISPER_CPP',
      sourceUri: 's3://hope-models/asr',
      name: 'ArcaAI Whisper ml-en',
      memorySizeMb: 1500,
      observedMemoryMb: null,
      observedLoadSeconds: null,
    },
  ];
  const sttModels = [
    {
      modelRef: 'arcaai-whisper-ml-en-ggml',
      aiModelId: null,
      cache: 'asr',
      state: 'loaded',
      device: 'cuda:0',
      bytes: 1.5 * GiB,
      bytesSource: 'measured',
      inFlight: 3,
      pinned: false,
      adminPinned: false,
      ttlSeconds: 900,
      loadedAt: new Date(Date.now() - 3_600_000).toISOString(),
      lastUsedAt: new Date().toISOString(),
      loadSeconds: 6.8,
    },
  ];
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return { id: 'u-1', roles: caller.roles };
      if (key === 'tenantId') return caller.tenantId;
      return undefined;
    }),
  };
  const agents = {
    report: vi.fn(async (service: 'stt' | 'nlp') => ({
      service,
      instance: `hope-${service}-pod`,
      reportedAt: new Date().toISOString(),
      devices: [{ id: 'cuda:0', kind: 'gpu', totalBytes: 16 * GiB, freeBytes: 12 * GiB }],
      models: service === 'stt' ? sttModels : [],
    })),
  };
  const lmStudio = { report: vi.fn(async () => ({ service: 'lm-studio', instance: 'lms', reportedAt: new Date().toISOString(), devices: [], models: [] })) };
  const prometheus = { instantVector: vi.fn(async () => []) };
  const usage = { read: vi.fn(async () => new Map()) };
  const eventEmitter = { emit: vi.fn() };

  routeLmStudioThroughAgent(agents as never, lmStudio as never);
  const service = new ModelResidencyService(
    { findAll: vi.fn(async () => []) } as never,
    { findAll: vi.fn(async () => catalogue), findById: vi.fn() } as never,
    agents as never,
    prometheus as never,
    { resolveEffective: vi.fn(async () => null) } as never,
    { read: vi.fn(async () => []) } as never,
    { build: vi.fn() } as never,
    usage as never,
    eventEmitter as never,
    cls as never,
  );
  return { service, usage };
}

describe('ModelResidencyService.getLifecycleStates — ungated, status only', () => {
  it('answers a tenant admin (the full catalogue stays platform-gated)', async () => {
    const { service } = build({ roles: ['TENANT_ADMIN'], tenantId: TENANT_A });
    await expect(service.getCatalogue()).rejects.toBeInstanceOf(ForbiddenException);

    const snapshot = await service.getLifecycleStates();
    const models = snapshot.services.flatMap((s) => s.models);
    expect(models).toContainEqual({ aiModelId: 'model-asr', slug: 'arcaai-whisper-ml-en-ggml', state: 'loaded' });
  });

  it('carries nothing but service, model identity and state — no placement, errors or usage', async () => {
    const { service, usage } = build({ roles: ['TENANT_ADMIN'], tenantId: TENANT_A });
    const snapshot = await service.getLifecycleStates();

    for (const group of snapshot.services) {
      expect(Object.keys(group).sort()).toEqual(['models', 'service']);
      for (const model of group.models) expect(Object.keys(model).sort()).toEqual(['aiModelId', 'slug', 'state']);
    }
    expect(Object.keys(snapshot).sort()).toEqual(['reportedAt', 'services']);
    // Cross-tenant usage is never read on this path.
    expect(usage.read).not.toHaveBeenCalled();
  });
});
