/**
 * Impersonation Seed-Coverage Tests (TASK-331 doc-05 F1)
 *
 * Guards the seed-data invariant that the ArcaAI customer tenant has at least
 * one impersonatable DOCTOR and one impersonatable NURSE.
 *
 * Why this matters: cross-tenant impersonation is blocked for TENANT_ADMINs
 * (auth.controller C-1), so a tenant admin can only impersonate users inside
 * its OWN tenant. The ~17 clinical users live on the Global tenant, so without
 * dedicated per-customer-tenant clinical users the core tenant-admin
 * impersonation workflow is untestable.
 *
 * A user is only a valid impersonation target if it can actually log in. Per
 * the TASK-305 Phase F login invariant, a non-exempt user must belong to its
 * tenant via BOTH a role AND a department. These tests therefore assert, for
 * each customer tenant:
 *   1. at least one DOCTOR and one NURSE user exists, and
 *   2. each such clinical user is non-exempt (not a service account) and is
 *      mapped to a department CODE that the department seed actually creates in
 *      that SAME tenant — i.e. it satisfies the role + department invariant.
 *
 * Static assertions on the exported seed data (no live DB), mirroring the
 * pattern in `seed.test.ts` / `seed-global-settings.test.ts`.
 */

import { describe, it, expect } from 'vitest';

import {
    SEED_USERS,
    PRIMARY_DEPARTMENT_CODE_BY_USERNAME,
} from '../prisma/db_main/seed/91-user';
import {
    DEFAULT_DEPARTMENTS,
    CUSTOMER_TENANT_GEN_DEPARTMENTS,
    CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS,
} from '../prisma/db_main/seed/04-department';
import {
    SEED_CUSTOMER_TENANT_IDS,
    SYSTEM_TENANT_ID,
} from '../prisma/db_main/seed/00-constants';

const CUSTOMER_TENANTS = [
    { label: 'ArcaAI', tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI },
] as const;

// `${tenantId}:${code}` for every department the seed actually creates, used to
// confirm a clinical user's mapped department code resolves within its tenant.
const SEEDED_DEPARTMENT_KEYS = new Set(
    [
        ...DEFAULT_DEPARTMENTS,
        ...CUSTOMER_TENANT_GEN_DEPARTMENTS,
        ...CUSTOMER_TENANT_SPECIALTY_DEPARTMENTS,
    ].map((d) => `${d.tenantId}:${d.code}`),
);

const usersInTenantWithRole = (tenantId: string, role: string) =>
    SEED_USERS.filter(
        (u) => u.tenantId === tenantId && u.roleNames.includes(role),
    );

describe('Impersonation seed coverage (TASK-331 doc-05 F1)', () => {
    describe.each(CUSTOMER_TENANTS)(
        '$label customer tenant',
        ({ tenantId }) => {
            it('seeds at least one DOCTOR', () => {
                expect(usersInTenantWithRole(tenantId, 'DOCTOR').length).toBeGreaterThanOrEqual(1);
            });

            it('seeds at least one NURSE', () => {
                expect(usersInTenantWithRole(tenantId, 'NURSE').length).toBeGreaterThanOrEqual(1);
            });

            it('every seeded DOCTOR/NURSE is a non-service-account (impersonatable, non-exempt)', () => {
                const clinical = SEED_USERS.filter(
                    (u) =>
                        u.tenantId === tenantId &&
                        (u.roleNames.includes('DOCTOR') || u.roleNames.includes('NURSE')),
                );
                expect(clinical.length).toBeGreaterThanOrEqual(2);
                for (const user of clinical) {
                    expect(user.isServiceAccount).toBe(false);
                    expect(user.tenantId).not.toBe(SYSTEM_TENANT_ID);
                }
            });

            it('every seeded DOCTOR/NURSE maps to a department CODE that exists in the SAME tenant (Phase F role+department invariant)', () => {
                const clinical = SEED_USERS.filter(
                    (u) =>
                        u.tenantId === tenantId &&
                        (u.roleNames.includes('DOCTOR') || u.roleNames.includes('NURSE')),
                );
                for (const user of clinical) {
                    const code = PRIMARY_DEPARTMENT_CODE_BY_USERNAME[user.username];
                    expect(code, `missing department mapping for "${user.username}"`).toBeDefined();
                    expect(
                        SEEDED_DEPARTMENT_KEYS.has(`${tenantId}:${code}`),
                        `department code "${code}" not seeded in tenant ${tenantId} for "${user.username}"`,
                    ).toBe(true);
                }
            });
        },
    );

    it('keeps SEED_USERS keyed by unique ids (idempotent upsert key)', () => {
        const ids = SEED_USERS.map((u) => u.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('keeps SEED_USERS usernames and emails unique', () => {
        const usernames = SEED_USERS.map((u) => u.username);
        const emails = SEED_USERS.map((u) => u.profile.email);
        expect(new Set(usernames).size).toBe(usernames.length);
        expect(new Set(emails).size).toBe(emails.length);
    });
});
