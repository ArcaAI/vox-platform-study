/**
 * ConsultationRepository.findConsultationChain full multi-hop walk.
 *
 * The base `Repository.db` getter returns `unitOfWork.getDatabaseService()[modelName]`,
 * so we hand the repo a fake unit-of-work whose `consultation` delegate is an in-memory
 * graph of `findFirst`/`findMany` mocks and assert the traversal (root + every
 * descendant across all hops, ENABLED-only, cycle-safe, ordered by createdAt).
 */
import { describe, it, expect, vi } from 'vitest';
import { ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ConsultationEntityMapper: {
    getInstance: () => ({
      toDomainEntity: (m: Record<string, unknown>) => ({ id: m.id, parentConsultationId: m.parentConsultationId }),
    }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const ENABLED = ResourceStatusType.ENABLED;
const DISABLED = ResourceStatusType.DISABLED;

interface Node {
  id: string;
  parentConsultationId: string | null;
  resourceStatus: ResourceStatusType;
  createdAt: Date;
}

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

const makeDelegate = (nodes: Record<string, Node>) => {
  const all = Object.values(nodes);
  return {
    findFirst: vi.fn(({ where }: any) => {
      const n = all.find((x) => x.id === where.id);
      if (!n) return Promise.resolve(null);
      if (where.resourceStatus && n.resourceStatus !== where.resourceStatus) return Promise.resolve(null);
      return Promise.resolve(n);
    }),
    findMany: vi.fn(({ where }: any) => {
      const parentIds: string[] = where.parentConsultationId.in;
      const status: ResourceStatusType | undefined = where.resourceStatus;
      return Promise.resolve(
        all.filter((n) => n.parentConsultationId != null && parentIds.includes(n.parentConsultationId) && (!status || n.resourceStatus === status)),
      );
    }),
  };
};

const buildRepo = async (delegate: any) => {
  const { ConsultationRepository } = await import('../ConsultationRepository');
  return new ConsultationRepository(makeUow({ consultation: delegate }) as never);
};

describe('ConsultationRepository.findConsultationChain — full multi-hop', () => {
  it('walks the entire chain (root + all descendants, multi-hop) ordered by createdAt', async () => {
    const nodes: Record<string, Node> = {
      A: { id: 'A', parentConsultationId: null, resourceStatus: ENABLED, createdAt: new Date('2026-01-01') },
      B: { id: 'B', parentConsultationId: 'A', resourceStatus: ENABLED, createdAt: new Date('2026-01-02') },
      C: { id: 'C', parentConsultationId: 'B', resourceStatus: ENABLED, createdAt: new Date('2026-01-03') },
      D: { id: 'D', parentConsultationId: 'A', resourceStatus: ENABLED, createdAt: new Date('2026-01-04') },
      E: { id: 'E', parentConsultationId: 'A', resourceStatus: DISABLED, createdAt: new Date('2026-01-05') },
      X: { id: 'X', parentConsultationId: null, resourceStatus: ENABLED, createdAt: new Date('2026-01-06') },
    };
    const repo = await buildRepo(makeDelegate(nodes));

    // Start from the deepest node — the walk must still find the structural root + siblings.
    const chain = await repo.findConsultationChain('C');

    // A (root) → B → C, plus sibling D; E excluded (DISABLED); X excluded (unrelated tree).
    expect(chain.map((c: { id: string }) => c.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('does not infinite-loop on a parent/child cycle', async () => {
    const nodes: Record<string, Node> = {
      P: { id: 'P', parentConsultationId: 'Q', resourceStatus: ENABLED, createdAt: new Date('2026-01-01') },
      Q: { id: 'Q', parentConsultationId: 'P', resourceStatus: ENABLED, createdAt: new Date('2026-01-02') },
    };
    const repo = await buildRepo(makeDelegate(nodes));

    const chain = await repo.findConsultationChain('P');

    expect(chain.map((c: { id: string }) => c.id).sort()).toEqual(['P', 'Q']);
  });

  it('returns an empty array when the consultation does not exist', async () => {
    const repo = await buildRepo(makeDelegate({}));

    const chain = await repo.findConsultationChain('nope');

    expect(chain).toEqual([]);
  });
});
