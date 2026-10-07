/**
 * TASK-1050 W2e — the admin activity aggregates carry the consultation's guardrail counts
 * (README §9.6): evaluations, warn / block / unverified decisions and open notices. Counts only.
 */
import { describe, expect, it, vi } from 'vitest';
import { ConsultationHistoryService } from '../consultation-history.service';

const TENANT = 'tenant-a';
const CID = 'cons-1';

function makeService(withGuardrail: boolean) {
  const cls = {
    get: vi.fn((key: string) => (key === 'tenantId' ? TENANT : key === 'user' ? { id: 'sadmin', roles: ['SUPER_ADMIN'] } : undefined)),
    set: vi.fn(),
  };
  const reads = {
    pageItems: vi.fn(async () => []),
    countEditedItems: vi.fn(async () => 0),
    listLifecycleEvents: vi.fn(async () => []),
    listVersionMeta: vi.fn(async () => []),
    readContents: vi.fn(async () => []),
  };
  const evaluations = {
    count: vi.fn(async (args: { where: { decision?: string } }) =>
      args.where.decision === 'WARN' ? 3 : args.where.decision === 'BLOCK' ? 1 : args.where.decision === 'UNVERIFIED' ? 0 : 7,
    ),
  };
  const notices = { count: vi.fn(async () => 2) };
  const service = new ConsultationHistoryService(
    { findByIdOrNull: vi.fn(async () => ({ id: CID, tenantId: TENANT, status: 'STOPPED', processing: 'IDLE', closedAt: null })) } as never,
    { findByConsultation: vi.fn(async () => []) } as never,
    { findByConsultation: vi.fn(async () => []) } as never,
    {} as never,
    {} as never,
    reads as never,
    { emit: vi.fn() } as never,
    cls as never,
    undefined,
    undefined,
    undefined,
    withGuardrail ? (evaluations as never) : undefined,
    withGuardrail ? (notices as never) : undefined,
  );
  return { service, evaluations, notices };
}

describe('ConsultationHistoryService — guardrail aggregates', () => {
  it('adds the guardrail counts to the admin first-page aggregates', async () => {
    const { service, evaluations } = makeService(true);
    const page = await service.getActivity(CID, {}, { admin: true });
    expect(page.aggregates).toMatchObject({ guardrail: { evaluations: 7, warn: 3, block: 1, unverified: 0, openNotices: 2 } });
    expect(evaluations.count).toHaveBeenCalledWith({ where: { tenantId: TENANT, consultationId: CID } });
  });

  it('leaves the aggregates as they were when the guardrail repositories are not wired', async () => {
    const { service } = makeService(false);
    const page = await service.getActivity(CID, {}, { admin: true });
    expect(page.aggregates).not.toHaveProperty('guardrail');
  });
});
