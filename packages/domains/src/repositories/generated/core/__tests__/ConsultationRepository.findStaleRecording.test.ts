/**
 * ConsultationRepository.findStaleRecording (TASK-932 OD-9)
 *
 * Pins the query shape `ConsultationTimeoutSweepService.sweepStaleRecordings`
 * depends on:
 *   • `status` filtered to exactly `RECORDING`.
 *   • `updatedAt` strictly before the supplied cutoff.
 *   • `resourceStatus: ENABLED` (soft-deleted rows never resurface).
 *   • NO `tenantId` filter — deliberately cross-tenant, mirroring
 *     `findTimeoutSweepEligible`'s "omit tenantId = cross-tenant read" shape,
 *     since the sweep runs with no CLS tenant context.
 *   • oldest-`updatedAt`-first ordering.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConsultationStatus, ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ConsultationEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

describe('ConsultationRepository.findStaleRecording', () => {
  let delegate: any;
  let repo: any;

  const cutoff = new Date('2026-09-09T00:00:00.000Z');

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('queries RECORDING rows, past cutoff, cross-tenant, oldest first', async () => {
    await repo.findStaleRecording(cutoff);

    expect(delegate.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: undefined,
      where: {
        status: ConsultationStatus.RECORDING,
        updatedAt: { lt: cutoff },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: [{ updatedAt: 'asc' }],
      include: undefined,
    });
  });

  it('never includes a tenantId filter (cross-tenant by design)', async () => {
    await repo.findStaleRecording(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    expect(callArgs.where).not.toHaveProperty('tenantId');
  });

  it('filters on exactly RECORDING, not the sweep-eligible set', async () => {
    await repo.findStaleRecording(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    expect(callArgs.where.status).toBe(ConsultationStatus.RECORDING);
  });

  it('maps returned rows through the entity mapper', async () => {
    const rows = [{ id: 'c-1', status: ConsultationStatus.RECORDING }];
    delegate.findMany.mockResolvedValue(rows);

    const result = await repo.findStaleRecording(cutoff);

    expect(result).toEqual(rows);
  });
});
