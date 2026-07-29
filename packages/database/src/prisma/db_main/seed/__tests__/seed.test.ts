/**
 * Seed Data-Coherence Tests (cold-seed bug)
 *
 * Static assertions over the EXPORTED seed data (no live DB), mirroring the
 * pattern in `src/__tests__/seed.test.ts` and `seed-impersonation-coverage.ts`.
 * They lock in four invariants surfaced by review:
 *
 *   - (cold-seed bug) seed usernames are globally unique across 91-user.ts AND
 *     the DNA seed (08), and the DNA seed never invents its own user identities
 *     — it reuses the canonical 91-user.ts clinicians by id. A duplicate
 *     username under a NEW id would violate `User.username @unique` and crash a
 *     COLD seed (91 inserts the canonical user, 08's create then collides).
 *   - (F1) the ArcaAI customer tenant has >= 1 seeded
 *     consultation, so admin clinical lists & analytics are not empty.
 *   - (F8) every customer tenant has >= 1 clinician.
 *   - (F6/F8) every seeded audit row references users/consultations that live
 *     in the SAME tenant as the row (no cross-tenant audit trail) and never
 *     points at an unseeded consultation.
 */

import { describe, it, expect } from 'vitest';

import { SEED_USERS } from '../91-user';
import { CUSTOMER_DNA_CLINICIANS, CUSTOMER_DNA_SEED_USERNAMES, CUSTOMER_DNA_REPORTS } from '../08-dna-writing-style';
import { DEFAULT_CONSULTATIONS, CUSTOMER_TENANT_CONSULTATIONS } from '../09-consultation';
import { DEFAULT_AUDIT_LOGS, CUSTOMER_TENANT_AUDIT_LOGS } from '../10-audit-log';
import { SEED_CUSTOMER_TENANT_IDS, SYSTEM_TENANT_ID } from '../00-constants';

const CUSTOMER_TENANTS = [{ label: 'ArcaAI', tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI }] as const;

// id -> home tenant for every seeded user (platform users live on the system
// tenant and may legitimately act inside any customer tenant).
const USER_TENANT_BY_ID = new Map(SEED_USERS.map((u) => [u.id, u.tenantId] as const));
// id -> tenant for every seeded consultation (Global + customer).
const CONSULTATION_TENANT_BY_ID = new Map([...DEFAULT_CONSULTATIONS, ...CUSTOMER_TENANT_CONSULTATIONS].map((c) => [c.id, c.tenantId] as const));

// =============================================================================
// COLD-SEED BUG — duplicate-username crash on a fresh database
// =============================================================================

describe('DNA seed reuses canonical users (cold-seed duplicate-username bug)', () => {
  it('keeps seed usernames globally unique across 91-user.ts + the DNA seed', () => {
    const usernames = [...SEED_USERS.map((u) => u.username), ...CUSTOMER_DNA_SEED_USERNAMES];
    expect(new Set(usernames).size).toBe(usernames.length);
  });

  it('attaches customer DNA rows only to canonical 91-user.ts users (never invents a new identity)', () => {
    const canonicalIds = new Set(SEED_USERS.map((u) => u.id));
    for (const clinician of CUSTOMER_DNA_CLINICIANS) {
      expect(canonicalIds.has(clinician.userId), `DNA clinician userId ${clinician.userId} is not a canonical 91-user.ts user`).toBe(true);
    }
  });

  it('binds every customer DNA report to a doctor that lives in the report tenant', () => {
    for (const report of CUSTOMER_DNA_REPORTS) {
      const doctorTenant = USER_TENANT_BY_ID.get(report.doctorId);
      expect(doctorTenant, `DNA report ${report.id} references unknown doctor ${report.doctorId}`).toBeDefined();
      expect(doctorTenant).toBe(report.tenantId);
    }
  });
});

// =============================================================================
// F1 / F8 — customer tenants have clinicians AND consultations
// =============================================================================

describe('Customer-tenant clinical data completeness', () => {
  describe.each(CUSTOMER_TENANTS)('$label customer tenant', ({ tenantId }) => {
    it('seeds at least one clinician (DOCTOR or NURSE)', () => {
      const clinicians = SEED_USERS.filter((u) => u.tenantId === tenantId && (u.roleNames.includes('DOCTOR') || u.roleNames.includes('NURSE')));
      expect(clinicians.length).toBeGreaterThanOrEqual(1);
    });

    it('seeds at least one consultation', () => {
      const consultations = CUSTOMER_TENANT_CONSULTATIONS.filter((c) => c.tenantId === tenantId);
      expect(consultations.length).toBeGreaterThanOrEqual(1);
    });

    it('owns every seeded consultation by a clinician in the SAME tenant', () => {
      const consultations = CUSTOMER_TENANT_CONSULTATIONS.filter((c) => c.tenantId === tenantId);
      for (const consultation of consultations) {
        expect(USER_TENANT_BY_ID.get(consultation.doctorId)).toBe(tenantId);
      }
    });
  });
});

// =============================================================================
// F6 / F8 — coherent, single-tenant audit trail
// =============================================================================

describe('Audit-log tenant coherence', () => {
  const ALL_AUDIT_ROWS = [...DEFAULT_AUDIT_LOGS, ...CUSTOMER_TENANT_AUDIT_LOGS];

  // A referenced user satisfies coherence when it is a platform/system user
  // (home tenant = system tenant) or it lives in the audit row's tenant.
  const assertUserInRowTenant = (userId: string | null, rowTenant: string, ctx: string) => {
    if (!userId) return;
    const userTenant = USER_TENANT_BY_ID.get(userId);
    if (userTenant === undefined || userTenant === SYSTEM_TENANT_ID) return;
    expect(userTenant, ctx).toBe(rowTenant);
  };

  it('never references a user from a different tenant (responsibleUserId / createdBy)', () => {
    for (const row of ALL_AUDIT_ROWS) {
      assertUserInRowTenant(
        row.responsibleUserId,
        row.tenantId,
        `audit ${row.id}: responsibleUserId ${row.responsibleUserId} not in tenant ${row.tenantId}`,
      );
      assertUserInRowTenant(row.createdBy, row.tenantId, `audit ${row.id}: createdBy ${row.createdBy} not in tenant ${row.tenantId}`);
      if (row.resourceType === 'User') {
        assertUserInRowTenant(row.resourceId, row.tenantId, `audit ${row.id}: User resourceId ${row.resourceId} not in tenant ${row.tenantId}`);
      }
    }
  });

  it('only references seeded consultations that live in the audit row tenant (no unseeded / cross-tenant refs)', () => {
    for (const row of ALL_AUDIT_ROWS) {
      if (row.resourceType !== 'Consultation' || !row.resourceId) continue;
      const consultationTenant = CONSULTATION_TENANT_BY_ID.get(row.resourceId);
      expect(consultationTenant, `audit ${row.id} references unseeded consultation ${row.resourceId}`).toBeDefined();
      expect(consultationTenant).toBe(row.tenantId);
    }
  });
});
