import type { CorePrismaClient } from '../../../client';
import { TenantPlan, ValueType } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_USER_IDS, SEED_GLOBAL_SETTING_IDS, SEED_PLAN_ENTITLEMENT_IDS } from './00-constants';

/**
 * TASK-392 — Plan entitlements seed (proposal §2 / Q1 / Q9).
 *
 * Seeds two things:
 *   1. The platform-wide per-plan default matrix (`PlanEntitlement`, one row per
 *      `TenantPlan`). This is the proposed STARTER → TRIAL → PRO → ENTERPRISE
 *      matrix anchored at ~100 seats for ENTERPRISE. `null` = unlimited.
 *   2. The enforcement kill-switch (`entitlements.enabled` GlobalSetting) under
 *      the platform tenant — seeded **OFF** (Q9). Until an operator flips it
 *      per-env, every quota/feature check is a no-op, so this whole epic lands
 *      safely dark.
 *
 * Values mirror
 * `packages/applications/src/services/entitlements/entitlements.constants.ts`
 * (`PLAN_ENTITLEMENT_DEFAULTS`) — kept in sync manually (the database package
 * must not depend on @arcaai/applications, matching the rate-limit seed).
 *
 * Idempotent: the matrix upsert is create-only (`update: {}`), so a re-seed
 * NEVER clobbers admin-tuned matrix values; the kill-switch upsert refreshes
 * metadata but never overwrites a live `value`.
 */

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;
const GIB = 1024 ** 3;

interface PlanEntitlementSeed {
    id: string;
    plan: TenantPlan;
    maxUsers: number | null;
    maxDepartments: number | null;
    maxPromptTemplates: number | null;
    maxAsrPipelines: number | null;
    maxApiKeys: number | null;
    storageQuotaBytes: bigint | null;
    maxConcurrentSessions: number | null;
    monthlyConsultations: number | null;
    monthlyTranscriptionMinutes: number | null;
    monthlySummaries: number | null;
    featureDnaReports: boolean;
    featureVoiceEnrollment: boolean;
    featureMonitoringAccess: boolean;
    modelTier: string;
    rateLimitTier: string;
}

// TRIAL is a 1-week PRO-entitled window (Q4), so it shares PRO's values.
const PRO_VALUES = {
    maxUsers: 25,
    maxDepartments: 10,
    maxPromptTemplates: 50,
    maxAsrPipelines: 5,
    maxApiKeys: 10,
    storageQuotaBytes: BigInt(100 * GIB),
    maxConcurrentSessions: 25,
    monthlyConsultations: 5_000,
    monthlyTranscriptionMinutes: 12_000,
    monthlySummaries: 5_000,
    featureDnaReports: true,
    featureVoiceEnrollment: true,
    featureMonitoringAccess: false,
    modelTier: 'full',
    rateLimitTier: 'default',
};

const PLAN_ENTITLEMENTS: PlanEntitlementSeed[] = [
    {
        id: SEED_PLAN_ENTITLEMENT_IDS.STARTER,
        plan: TenantPlan.STARTER,
        maxUsers: 5,
        maxDepartments: 2,
        maxPromptTemplates: 10,
        maxAsrPipelines: 1,
        maxApiKeys: 2,
        storageQuotaBytes: BigInt(5 * GIB),
        maxConcurrentSessions: 5,
        monthlyConsultations: 500,
        monthlyTranscriptionMinutes: 1_000,
        monthlySummaries: 500,
        featureDnaReports: false,
        featureVoiceEnrollment: false,
        featureMonitoringAccess: false,
        modelTier: 'base',
        rateLimitTier: 'strict',
    },
    { id: SEED_PLAN_ENTITLEMENT_IDS.TRIAL, plan: TenantPlan.TRIAL, ...PRO_VALUES },
    { id: SEED_PLAN_ENTITLEMENT_IDS.PRO, plan: TenantPlan.PRO, ...PRO_VALUES },
    {
        id: SEED_PLAN_ENTITLEMENT_IDS.ENTERPRISE,
        plan: TenantPlan.ENTERPRISE,
        maxUsers: 100,
        maxDepartments: 40,
        maxPromptTemplates: 300,
        maxAsrPipelines: 20,
        maxApiKeys: 50,
        storageQuotaBytes: BigInt(1_000 * GIB),
        maxConcurrentSessions: 100,
        monthlyConsultations: 50_000,
        monthlyTranscriptionMinutes: 120_000,
        monthlySummaries: 50_000,
        featureDnaReports: true,
        featureVoiceEnrollment: true,
        featureMonitoringAccess: true,
        modelTier: 'full_custom',
        rateLimitTier: 'relaxed',
    },
];

export const seedEntitlements = async (client: CorePrismaClient) => {
    console.log(`Seeding plan entitlements (${PLAN_ENTITLEMENTS.length} plan rows + kill-switch)...`);

    // 1. Per-plan default matrix. Create-only on re-seed so an admin who tuned
    //    the matrix keeps their values.
    for (const row of PLAN_ENTITLEMENTS) {
        await client.planEntitlement.upsert({
            where: { plan: row.plan },
            update: {},
            create: { ...row, createdBy: CREATED_BY },
        });
        console.log(`  plan/${row.plan}`);
    }

    // 2. Enforcement kill-switch — seeded OFF (Q9). Single platform row so the
    //    flat AppSettings cache lookup stays deterministic (mirrors rate-limit).
    await client.globalSetting.upsert({
        where: {
            GlobalSetting_tenantId_name_key_unique: {
                tenantId: SEED_TENANT_ID,
                name: 'Entitlements Enabled',
                key: 'entitlements.enabled',
            },
        },
        update: {
            dataType: ValueType.Boolean,
            description: 'Global entitlements enforcement kill-switch. Set to true to enable quota/feature gating platform-wide.',
            namespace: 'entitlements',
        },
        create: {
            id: SEED_GLOBAL_SETTING_IDS.ENTITLEMENTS_ENABLED,
            tenantId: SEED_TENANT_ID,
            namespace: 'entitlements',
            name: 'Entitlements Enabled',
            key: 'entitlements.enabled',
            value: 'false',
            defaultValue: 'false',
            dataType: ValueType.Boolean,
            description: 'Global entitlements enforcement kill-switch. Set to true to enable quota/feature gating platform-wide.',
            locked: false,
            createdBy: CREATED_BY,
        },
    });
    console.log('  entitlements/entitlements.enabled = false');

    console.log(`Seeded ${PLAN_ENTITLEMENTS.length} plan entitlements + kill-switch (OFF)`);
};
