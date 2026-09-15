/**
 * ConsultationRepository.findTimeoutSweepEligible ( state-machine.md
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

/**
 * TASK-972 Lane 8 (OD-6) — the two NEW sweep-eligibility queries, one per
 * stranding state. They are deliberately SEPARATE from
 * `findTimeoutSweepEligible` above: each leg carries its own threshold
 * descriptor and its own transition target, so folding them into the
 * five-state `in` list would force one window on three different clinical
 * meanings.
 */
describe('ConsultationRepository.findIdlePendingReview', () => {
  let delegate: any;
  let repo: any;

  const cutoff = new Date('2026-09-15T00:00:00.000Z');

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('queries PENDING_REVIEW only, past cutoff, cross-tenant, oldest first', async () => {
    await repo.findIdlePendingReview(cutoff);

    expect(delegate.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: undefined,
      where: {
        status: ConsultationStatus.PENDING_REVIEW,
        updatedAt: { lt: cutoff },
        resourceStatus: ResourceStatusType.ENABLED,
      },
      orderBy: [{ updatedAt: 'asc' }],
      include: undefined,
    });
  });

  it('never includes a tenantId filter (cross-tenant by design)', async () => {
    await repo.findIdlePendingReview(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    expect(callArgs.where).not.toHaveProperty('tenantId');
  });

  it('maps returned rows through the entity mapper', async () => {
    const rows = [{ id: 'c-1', status: ConsultationStatus.PENDING_REVIEW }];
    delegate.findMany.mockResolvedValue(rows);

    expect(await repo.findIdlePendingReview(cutoff)).toEqual(rows);
  });
});

describe('ConsultationRepository.findIdleOpen', () => {
  let delegate: any;
  let repo: any;

  const cutoff = new Date('2026-09-15T00:00:00.000Z');

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  it('queries OPEN only, past cutoff, cross-tenant, oldest first', async () => {
    await repo.findIdleOpen(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    expect(callArgs.where.status).toBe(ConsultationStatus.OPEN);
    expect(callArgs.where.updatedAt).toEqual({ lt: cutoff });
    expect(callArgs.where.resourceStatus).toBe(ResourceStatusType.ENABLED);
    expect(callArgs.orderBy).toEqual([{ updatedAt: 'asc' }]);
    expect(callArgs.where).not.toHaveProperty('tenantId');
  });

  /**
   * The SECOND signal, and the reason this query is not a mirror of the
   * PENDING_REVIEW one. `ContextService` only ever READS the consultation
   * row (`findById` / `assertParentInScope`) — adding a case note or an
   * attachment to an OPEN consultation does NOT bump `Consultation.updatedAt`.
   * Age alone would therefore close a consultation a clinician is actively
   * loading context into, and `OPEN → CLOSED_INCOMPLETE` only reaches
   * `REOPENED`, so that mistake is not cheap to undo. Mirrors the RECORDING
   * leg's own two-signal rule (age AND an absent live-summary lock).
   */
  it('also requires no context item created inside the window', async () => {
    await repo.findIdleOpen(cutoff);

    const [callArgs] = delegate.findMany.mock.calls[0];
    expect(callArgs.where.ContextItems).toEqual({ none: { createdAt: { gte: cutoff } } });
  });

  it('maps returned rows through the entity mapper', async () => {
    const rows = [{ id: 'c-9', status: ConsultationStatus.OPEN }];
    delegate.findMany.mockResolvedValue(rows);

    expect(await repo.findIdleOpen(cutoff)).toEqual(rows);
  });
});
