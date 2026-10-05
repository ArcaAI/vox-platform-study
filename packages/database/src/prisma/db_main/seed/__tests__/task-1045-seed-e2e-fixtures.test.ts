/**
 * TASK-1045 E2E-1 / E2E-3 — seed fixtures.
 *  - ArcaAI clinicians carry the EMR consultant id as `UserProfile.staffId` (ALaaS 1001..1006);
 *  - every closed seeded consultation carries `closedReason` + `closedAt` (D-21).
 */
import { describe, expect, it } from 'vitest';

import { ConsultationStatus } from '../../../../generated/core-prisma-client/enums';
import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';
import { CUSTOMER_TENANT_CONSULTATIONS, DEFAULT_CONSULTATIONS } from '../09-consultation';
import { seedUser } from '../91-user';

type Upsert = { where: { userId: string }; update: Record<string, unknown>; create: Record<string, unknown> };

const run = async () => {
  const profiles: Upsert[] = [];
  const fake = {
    role: { findMany: async () => [] },
    user: { upsert: async (a: { where: { id: string } }) => ({ id: a.where.id }) },
    userProfile: { upsert: async (a: Upsert) => void profiles.push(a) },
    userRoleAssignment: { findFirst: async () => null, create: async () => ({}) },
    department: { findFirst: async () => ({ id: 'd' }) },
    userDepartment: { findFirst: async () => null, create: async () => ({}) },
    $executeRawUnsafe: async () => 0,
  };
  // everything after the profile loop (settings, ...) is irrelevant here: stub any other model.
  const client = new Proxy(fake, {
    get: (t, k) => (k in t ? (t as never)[k] : new Proxy({}, { get: () => async () => ({}) })),
  });
  await seedUser(client as never);
  return profiles;
};

describe('ArcaAI clinicians carry staffId (E2E-1)', () => {
  it('sets exactly 1001..1006 on create AND update (idempotent re-seed)', async () => {
    const { SEED_USERS } = await import('../91-user');
    const nameOf = new Map(SEED_USERS.map((u) => [u.id, u.username]));
    const tenantOf = new Map(SEED_USERS.map((u) => [u.id, u.tenantId]));
    const profiles = await run();
    const got: Record<string, unknown> = {};
    for (const p of profiles) {
      const name = nameOf.get(p.where.userId)!;
      expect(p.update.staffId).toEqual(p.create.staffId);
      if (p.create.staffId !== undefined) {
        expect(tenantOf.get(p.where.userId)).toBe(SEED_CUSTOMER_TENANT_IDS.ARCAAI);
        got[name] = p.create.staffId;
      }
    }
    expect(got).toEqual({
      arcaai_doctor: '1001',
      arcaai_doctor_surg: '1002',
      arcaai_doctor_neur: '1003',
      arcaai_doctor_bren: '1004',
      arcaai_doctor_rheum: '1005',
      arcaai_doctor_heme: '1006',
    });
  });
});

describe('closed seeded consultations carry closedReason + closedAt (E2E-3 / D-21)', () => {
  const closed = [...DEFAULT_CONSULTATIONS, ...CUSTOMER_TENANT_CONSULTATIONS].filter(
    (c) => c.status === ConsultationStatus.CLOSED_COMPLETE || c.status === ConsultationStatus.CLOSED_INCOMPLETE,
  ) as Array<Record<string, unknown> & { status: string }>;

  it('there are closed fixtures', () => expect(closed.length).toBeGreaterThan(0));

  it.each(closed.map((c) => [c.id as string, c] as const))('%s', (_id, c) => {
    expect(c.closedAt).toBeInstanceOf(Date);
    if (c.status === ConsultationStatus.CLOSED_COMPLETE) {
      expect(c.closedReason).toBe('APPROVED');
      expect(c.approvedAt).toBeInstanceOf(Date);
    } else {
      expect(c.closedReason).toBe('AUTO');
    }
  });
});
