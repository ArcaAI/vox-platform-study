/**
 * TASK-1021 L1.3 (C-2) — `ModelServingSpecService.resolve(slug, tenantId)`: which ROW `apps/vllm`
 * builds an engine from. Tenant row first, SYSTEM only on ABSENCE, never a third tenant; a row not
 * served by `vllm` is invisible (404), and a row that cannot be served is a NAMED 409.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceStatusType, SYSTEM_TENANT_ID, SysEventType, type AiModelEntity, type AiModelRepository } from '@arcaai/domains';
import { ModelServingSpecService } from '../model-serving-spec.service';

const TENANT_A = 'a0000000-0000-0000-0000-00000000000a';
const TENANT_B = 'b0000000-0000-0000-0000-00000000000b';
const SLUG = 'arcaai-whisper-large-ml-en-vllm';

function row(overrides: Record<string, unknown> = {}): AiModelEntity {
  return {
    id: '00000000-0000-0000-0001-000000000026',
    tenantId: SYSTEM_TENANT_ID,
    version: 1,
    slug: SLUG,
    taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
    format: 'SAFETENSOR',
    libraryName: 'vllm',
    servedBy: 'vllm',
    provider: 'vllm',
    sourceUri: 'hf:arcaai/whisper-large-ml-en',
    sourceRevision: null,
    checksum: null,
    computeType: 'float16',
    bucketPrefix: 'hf/hub/models--arcaai--whisper-large-ml-en/snapshots/0000000000000000000000000000000000000000',
    primaryObject: null,
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: { serving: { vramGiB: 5, maxNumSeqs: 64 } },
    ...overrides,
  } as unknown as AiModelEntity;
}

/** A repository holding exactly `rows`, keyed by `(tenantId, slug)`, every status included. */
function repositoryOf(rows: AiModelEntity[]) {
  const findBySlugIncludingDeleted = vi.fn(async (tenantId: string, slug: string) => rows.find((r) => r.tenantId === tenantId && r.slug === slug) ?? null);
  return { repository: { findBySlugIncludingDeleted } as unknown as AiModelRepository, findBySlugIncludingDeleted };
}

const eventEmitter = { emit: vi.fn() };
const cls = { get: vi.fn(), set: vi.fn() };

function serviceOver(rows: AiModelEntity[]) {
  const { repository, findBySlugIncludingDeleted } = repositoryOf(rows);
  const service = new ModelServingSpecService(repository, eventEmitter as never, cls as never);
  return { service, findBySlugIncludingDeleted };
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await promise;
  } catch (error) {
    const http = error as NotFoundException | ConflictException;
    return { status: http.getStatus(), body: http.getResponse() };
  }
  throw new Error('expected a rejection');
}

describe('ModelServingSpecService.resolve (TASK-1021 C-2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a tenant row wins over SYSTEM', async () => {
    const own = row({ id: 'a1111111-0000-0000-0000-000000000001', tenantId: TENANT_A, metaData: { serving: { vramGiB: 8 } } });
    const { service, findBySlugIncludingDeleted } = serviceOver([row(), own]);
    const spec = await service.resolve(SLUG, TENANT_A);
    expect(spec).toMatchObject({ tenantId: TENANT_A, runtimeKey: 'a1111111-0000-0000-0000-000000000001:v1', engine: { vramGiB: 8 } });
    expect(findBySlugIncludingDeleted).toHaveBeenCalledTimes(1);
  });

  it('SYSTEM serves when the tenant has none', async () => {
    const { service, findBySlugIncludingDeleted } = serviceOver([row()]);
    const spec = await service.resolve(SLUG, TENANT_A);
    expect(spec.tenantId).toBe(SYSTEM_TENANT_ID);
    expect(findBySlugIncludingDeleted.mock.calls.map(([tenantId]) => tenantId)).toEqual([TENANT_A, SYSTEM_TENANT_ID]);
  });

  it('a SOFT-DELETED tenant row is absent, so SYSTEM serves', async () => {
    const { service } = serviceOver([row(), row({ tenantId: TENANT_A, resourceStatus: ResourceStatusType.DELETED })]);
    expect((await service.resolve(SLUG, TENANT_A)).tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('a DISABLED tenant row is an opinion, not an absence — 409 DISABLED, never the SYSTEM row', async () => {
    const { service } = serviceOver([row(), row({ tenantId: TENANT_A, resourceStatus: ResourceStatusType.DISABLED })]);
    expect(await rejection(service.resolve(SLUG, TENANT_A))).toEqual({ status: 409, body: { code: 'MODEL_NOT_SERVABLE', reason: 'DISABLED' } });
  });

  it('tenant B asking for tenant A`s slug → 404, and no third tenant is ever read', async () => {
    const { service, findBySlugIncludingDeleted } = serviceOver([row({ tenantId: TENANT_A })]);
    expect(await rejection(service.resolve(SLUG, TENANT_B))).toEqual({ status: 404, body: { code: 'MODEL_NOT_FOUND' } });
    expect(findBySlugIncludingDeleted.mock.calls.map(([tenantId]) => tenantId)).toEqual([TENANT_B, SYSTEM_TENANT_ID]);
  });

  it('a row served by anything but vllm → 404', async () => {
    const { service } = serviceOver([row({ servedBy: 'stt' })]);
    expect(await rejection(service.resolve(SLUG, TENANT_A))).toEqual({ status: 404, body: { code: 'MODEL_NOT_FOUND' } });
  });

  it('a row with no vramGiB → 409 SERVING_FACTS_MISSING', async () => {
    const { service } = serviceOver([row({ metaData: { asr: { maxModelLen: 448 } } })]);
    expect(await rejection(service.resolve(SLUG, TENANT_A))).toEqual({ status: 409, body: { code: 'MODEL_NOT_SERVABLE', reason: 'SERVING_FACTS_MISSING' } });
  });

  it('broadcasts ResourceViewed for the served row (the read pattern — no audit write)', async () => {
    const { service } = serviceOver([row()]);
    await service.resolve(SLUG, TENANT_A);
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceViewed, expect.objectContaining({ resourceId: '00000000-0000-0000-0001-000000000026' }));
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });
});
