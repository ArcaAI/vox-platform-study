/**
 * ConsultationRepository.findTimeoutSweepEligible (TASK-711 state-machine.md
 * §1a).
 *
 * Pins the query shape `ConsultationTimeoutSweepService` depends on:
 *   • `status` filtered to the five sweep-eligible members (PRIMED, DRAINING,
 *     DRAFT_PENDING_SENSORS, TIMED_OUT, REOPENED) — NOT OPEN, RECORDING, or
 *     PENDING_REVIEW, each excluded for a documented reason in the method's
 *     own doc comment.
 *   • `updatedAt` strictly before the supplied cutoff.
 *   • `resourceStatus: ENABLED` (soft-deleted rows never resurface).
 *   • NO `tenantId` filter — deliberately cross-tenant, mirroring
 *     `findCreatedInRange`'s "omit tenantId = cross-tenant read" shape, since
 *     the sweep runs with no CLS tenant context.
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

describe('ConsultationRepository.findTimeoutSweepEligible', () => {
  let delegate: any;
  let repo: any;

  const cutoff = new Date('2026-08-19T00:00:00.000Z');

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('queries the five sweep-eligible statuses, past cutoff, cross-tenant, oldest first', async () => {
    await repo.findTimeoutSweepEligible(cutoff);

    expect(delegate.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: undefined,
      where: {
        status: {
          in: [
            ConsultationStatus.PRIMED,
            ConsultationStatus.DRAINING,
            ConsultationStatus.DRAFT_PENDING_SENSORS,
            ConsultationStatus.TIMED_OUT,
            ConsultationStatus.REOPENED,
          ],
        },
        updatedAt: { lt: cutoff },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: [{ updatedAt: 'asc' }],
      include: undefined,
    });
  });

  it('never includes a tenantId filter (cross-tenant by design)', async () => {
    await repo.findTimeoutSweepEligible(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    expect(callArgs.where).not.toHaveProperty('tenantId');
  });

  it('excludes OPEN, RECORDING, and PENDING_REVIEW from the eligible set', async () => {
    await repo.findTimeoutSweepEligible(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    const eligible: string[] = callArgs.where.status.in;
    expect(eligible).not.toContain(ConsultationStatus.OPEN);
    expect(eligible).not.toContain(ConsultationStatus.RECORDING);
    expect(eligible).not.toContain(ConsultationStatus.PENDING_REVIEW);
  });

  it('maps returned rows through the entity mapper', async () => {
    const rows = [{ id: 'c-1', status: ConsultationStatus.PRIMED }];
    delegate.findMany.mockResolvedValue(rows);

    const result = await repo.findTimeoutSweepEligible(cutoff);

    expect(result).toEqual(rows);
  });
});
