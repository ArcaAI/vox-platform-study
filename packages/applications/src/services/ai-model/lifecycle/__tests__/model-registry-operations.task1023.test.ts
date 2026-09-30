/**
 * TASK-1023 J6 (OD-6) — `unregister` may be RETRIED once the previous one went
 * stale (open past the download stale window: its job was lost); a fresh open
 * unregister is still refused 409 MODEL_UNREGISTERING.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { AiDeploymentKind, AiModelAvailability, AiModelSource, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { ModelRegistryOperationsService } from '../model-registry-operations.service';

function build(unregisterStartedAt: string) {
  const row = {
    id: 'm-1',
    tenantId: SYSTEM_TENANT_ID,
    slug: 'medical-ner',
    source: AiModelSource.HUGGINGFACE,
    deploymentKind: AiDeploymentKind.CLOUD,
    servedBy: 'nlp',
    provider: 'built-in',
    availability: AiModelAvailability.AVAILABLE,
    bucketPrefix: null,
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: {
      unregister: { jobId: 'u-old', startedAt: unregisterStartedAt, deleteWeights: true, purge: false, finishedAt: null, error: null, weights: 'deleting' },
    } as Record<string, unknown>,
    version: 3,
    updatedBy: null,
  };
  const repo = { findById: vi.fn(async () => row), findAll: vi.fn(async () => []), updateWithVersion: vi.fn(async (_id: string, e: unknown) => e) };
  const queue = { add: vi.fn().mockResolvedValue(undefined) };
  const cls = { get: vi.fn((k: string) => (k === 'user' ? { id: 'admin-1', roles: ['SUPER_ADMIN'] } : null)) };
  const svc = new ModelRegistryOperationsService(
    {} as never,
    repo as never,
    {} as never,
    { referrersOf: vi.fn().mockResolvedValue([]) } as never,
    queue as never,
    { emit: vi.fn() } as never,
    cls as never,
    { getCatalogue: vi.fn(), unload: vi.fn() } as never,
    { findDefaultRow: vi.fn() } as never,
    undefined as never,
  );
  return { svc, queue, row };
}

describe('unregister retry after a stale unregister — TASK-1023 J6', () => {
  it('a STALE open unregister (past the stale window) may be retried: a new job is written and enqueued', async () => {
    const { svc, queue, row } = build(new Date(Date.now() - 60 * 60_000).toISOString());
    const out = await svc.unregister('m-1');
    expect(out.jobId).not.toBe('u-old');
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((row.metaData.unregister as Record<string, unknown>).jobId).toBe(out.jobId);
  });

  it('a FRESH open unregister is still 409 MODEL_UNREGISTERING', async () => {
    const { svc, queue } = build(new Date(Date.now() - 10_000).toISOString());
    const error = await svc.unregister('m-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'MODEL_UNREGISTERING' });
    expect(queue.add).not.toHaveBeenCalled();
  });
});
