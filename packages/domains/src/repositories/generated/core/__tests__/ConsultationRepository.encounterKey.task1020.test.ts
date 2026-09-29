/**
 * TASK-1020 D-2 / D-6 — the two lookups `open` keys on.
 *
 *   • `findByExternalRef` — the caller's own encounter id (`Consultation.externalRef`, the column
 *     promoted from the `metadata.externalRef` marker). Tenant-scoped, ENABLED only, newest first,
 *     and deliberately NOT narrowed by patient or doctor: `open` needs to SEE a same-ref row that
 *     belongs to another patient in order to refuse it (409 `EXTERNAL_REF_CONFLICT`).
 *   • `findByUniqueKey` — the legacy `(tenant, patient, appointmentDate, doctor)` key. It used to
 *     take whichever row Postgres returned first and to swallow EVERY error as "no match", which
 *     turned a database outage into a silently duplicated consultation. It now sorts newest first
 *     and only a genuine miss reads as `null`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceStatusType } from '../../../../enums';

vi.mock('../../../../mappers', () => ({
  ConsultationEntityMapper: {
    getInstance: () => ({ toDomainEntity: (m: Record<string, unknown>) => m }),
  },
}));

vi.mock('../../../../common/unitsOfWork/core', () => ({ CoreUnitOfWorkService: vi.fn() }));

const makeUow = (delegateByModel: Record<string, any>) => ({ getDatabaseService: () => delegateByModel });

describe('ConsultationRepository — TASK-1020 encounter keys', () => {
  let delegate: any;
  let repo: any;
  const day = new Date('2026-09-29');

  beforeEach(async () => {
    delegate = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) };
    const { ConsultationRepository } = await import('../ConsultationRepository');
    repo = new ConsultationRepository(makeUow({ consultation: delegate }) as never);
  });

  describe('findByExternalRef', () => {
    it('queries the tenant + ref, ENABLED only, newest first — never narrowed by patient or doctor', async () => {
      await repo.findByExternalRef('tenant-1', 'EVT-2');

      const [args] = delegate.findMany.mock.calls[0];
      expect(args.where).toEqual({ tenantId: 'tenant-1', externalRef: 'EVT-2', resourceStatus: ResourceStatusType.ENABLED });
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }]);
    });

    it('returns every row it found, mapped', async () => {
      delegate.findMany.mockResolvedValue([{ id: 'c-2' }, { id: 'c-1' }]);
      await expect(repo.findByExternalRef('tenant-1', 'EVT-2')).resolves.toEqual([{ id: 'c-2' }, { id: 'c-1' }]);
    });
  });

  describe('findByUniqueKey', () => {
    it('sorts newest first, so a day with several rows answers deterministically', async () => {
      delegate.findFirst.mockResolvedValue({ id: 'c-latest' });

      await expect(repo.findByUniqueKey('tenant-1', 'patient-1', day, 'doctor-1')).resolves.toEqual({ id: 'c-latest' });

      const [args] = delegate.findFirst.mock.calls[0];
      expect(args.where).toEqual({
        tenantId: 'tenant-1',
        patientId: 'patient-1',
        appointmentDate: day,
        doctorId: 'doctor-1',
        resourceStatus: ResourceStatusType.ENABLED,
      });
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }]);
    });

    it('reads a genuine miss as null', async () => {
      delegate.findFirst.mockResolvedValue(null);
      await expect(repo.findByUniqueKey('tenant-1', 'patient-1', day, 'doctor-1')).resolves.toBeNull();
    });

    it('RETHROWS anything that is not a miss — an outage must never read as "no consultation yet"', async () => {
      delegate.findFirst.mockRejectedValue(new Error('connection terminated'));
      await expect(repo.findByUniqueKey('tenant-1', 'patient-1', day, 'doctor-1')).rejects.toThrow('connection terminated');
    });
  });
});
