import { describe, it, expect } from 'vitest';

import { SEED_USERS } from '../91-user';
import { SEED_CUSTOMER_TENANT_IDS } from '../00-constants';

/**
 * TASK-331 doc-05 F1 — impersonation seed invariant.
 *
 * Tenant admins are confined to their own tenant (backend C-1 cross-tenant
 * block), so a TENANT_ADMIN can only impersonate users that live in the same
 * tenant. Each customer tenant (ArcaAI / 4bits / Mumbai) must therefore seed at
 * least one impersonatable, non-admin clinical user (DOCTOR or NURSE) — without
 * one, its admin has nobody to impersonate and the impersonation E2E flow is
 * untestable.
 */
const IMPERSONATABLE_CLINICAL_ROLES = ['DOCTOR', 'NURSE'];
const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];

const CUSTOMER_TENANT_IDS = [
  SEED_CUSTOMER_TENANT_IDS.ARCAAI,
  SEED_CUSTOMER_TENANT_IDS.FOURBITS,
  SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
];

describe('Impersonation seed invariant (TASK-331 doc-05 F1)', () => {
  for (const tenantId of CUSTOMER_TENANT_IDS) {
    it(`customer tenant ${tenantId} seeds >= 1 impersonatable non-admin (DOCTOR/NURSE) user`, () => {
      const impersonatableClinicalUsers = SEED_USERS.filter(
        (user) =>
          user.tenantId === tenantId &&
          !user.isServiceAccount &&
          user.roleNames.some((role) => IMPERSONATABLE_CLINICAL_ROLES.includes(role)) &&
          !user.roleNames.some((role) => ADMIN_ROLES.includes(role)),
      );
      expect(impersonatableClinicalUsers.length).toBeGreaterThanOrEqual(1);
    });
  }
});
