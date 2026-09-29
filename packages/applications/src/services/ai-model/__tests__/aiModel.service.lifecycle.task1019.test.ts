/**
 * TASK-1019 D-9 — the admin registry reads carry `lifecycle`, derived ONCE per
 * request (one residency catalogue read however many rows), and a lifecycle
 * failure never fails the read.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiDeploymentKind, AiModelAvailability, ModelTaskType, ResourceStatusType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';

function cls() {
  return { get: vi.fn((key: string) => (key === 'user' ? { id: 'u', roles: ['SUPER_ADMIN'] } : null)), set: vi.fn() };
}

function row(id: string) {
  return {
    id,
    tenantId: SYSTEM_TENANT_ID,
    name: id,
    slug: id,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    availability: AiModelAvailability.AVAILABLE,
    servedBy: 'nlp',
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: null,
    tags: [],
  };
}

const LIFECYCLE = { status: 'SERVING', services: [], download: null, unregister: null, observedAt: '2026-09-29T10:00:00Z' };

function build(lifecycle?: { forRows: ReturnType<typeof vi.fn> }) {
  const repo = {
    findAll: vi.fn().mockResolvedValue([row('a'), row('b')]),
    count: vi.fn().mockResolvedValue(2),
    findById: vi.fn().mockResolvedValue(row('a')),
    findBySlug: vi.fn().mockResolvedValue(row('a')),
  };
  const svc = new AiModelService(
    repo as never,
    { baseClient: {} } as never,
    { emit: vi.fn() } as never,
    cls() as never,
    undefined,
    undefined,
    undefined,
    lifecycle as never,
  );
  return { svc, repo };
}

describe('AiModelService — lifecycle on the admin reads', () => {
  it('list: ONE forRows call for the whole page, each row gets its lifecycle', async () => {
    const forRows = vi.fn(async (rows: Array<{ id: string }>) => new Map(rows.map((r) => [r.id, { ...LIFECYCLE }])));
    const { svc } = build({ forRows });
    const page = await svc.list({ page: 1, limit: 10 });
    expect(forRows).toHaveBeenCalledTimes(1);
    expect(forRows.mock.calls[0][0].map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(page.data.map((m) => m.lifecycle?.status)).toEqual(['SERVING', 'SERVING']);
  });

  it('getAllForAdmin, getById and getBySlug carry lifecycle too', async () => {
    const forRows = vi.fn(async (rows: Array<{ id: string }>) => new Map(rows.map((r) => [r.id, { ...LIFECYCLE }])));
    const { svc } = build({ forRows });
    expect((await svc.getAllForAdmin()).every((m) => m.lifecycle?.status === 'SERVING')).toBe(true);
    expect((await svc.getById('a'))?.lifecycle?.status).toBe('SERVING');
    expect((await svc.getBySlug('a'))?.lifecycle?.status).toBe('SERVING');
  });

  it('a lifecycle failure never fails the read — the rows come back without it', async () => {
    const { svc } = build({ forRows: vi.fn().mockRejectedValue(new Error('boom')) });
    const page = await svc.list({ page: 1, limit: 10 });
    expect(page.data).toHaveLength(2);
    expect(page.data[0].lifecycle).toBeUndefined();
  });

  it('with no lifecycle collaborator wired the reads are unchanged', async () => {
    const { svc } = build();
    const page = await svc.list({ page: 1, limit: 10 });
    expect(page.data[0]).not.toHaveProperty('lifecycle');
  });
});
