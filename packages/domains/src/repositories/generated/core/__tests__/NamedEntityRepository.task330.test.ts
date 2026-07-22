/**
 * NamedEntityRepository.findByConsultation.
 *
 * The SummaryProcessor needs every NER entity for a consultation's transcript
 * (with transcript offsets + ontology codes) to inject into the LLM prompt.
 * `findByConsultation` filters NamedEntity through its parent ContextItem
 * relation by `consultationId`. The base `Repository.db` getter returns
 * `unitOfWork.getDatabaseService()[modelName]`, so we hand the repo a fake
 * unit-of-work whose `namedEntity` delegate is a `findMany` mock and assert the
 * query shape + mapping.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../mappers', () => ({
  NamedEntityEntityMapper: {
    getInstance: () => ({
      toDomainEntity: (m: Record<string, unknown>) => ({
        id: m.id,
        contextItemId: m.contextItemId,
        transcriptStartOffset: m.transcriptStartOffset,
      }),
    }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

const buildRepo = async (delegate: any) => {
  const { NamedEntityRepository } = await import('../NamedEntityRepository');
  return new NamedEntityRepository(makeUow({ namedEntity: delegate }) as never);
};

describe('NamedEntityRepository.findByConsultation (Phase 1)', () => {
  it('filters by the parent ContextItem.consultationId and maps results', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'ne-1', contextItemId: 'ctx-1', transcriptStartOffset: 0 },
      { id: 'ne-2', contextItemId: 'ctx-1', transcriptStartOffset: 5 },
    ]);
    const repo = await buildRepo({ findMany });

    const result = await repo.findByConsultation('consult-1');

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ ContextItem: { consultationId: 'consult-1' } });
    expect(result.map((e: { id: string }) => e.id)).toEqual(['ne-1', 'ne-2']);
  });

  it('returns an empty array when there are no entities', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = await buildRepo({ findMany });

    const result = await repo.findByConsultation('consult-empty');

    expect(result).toEqual([]);
  });
});
