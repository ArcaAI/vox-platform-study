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
 *      the platform tenant. Ships **OFF** by default (Q9) so the epic lands
 *      safely dark; the fresh-DB seed value is **env-driven** (TASK-392 closeout)
 *      so DEV + STAGING come up **ON** while TEST/CI/PROD stay **OFF** — see the
 *      `ENTITLEMENTS_ENABLED_DEFAULT` note below.
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

/**
 * TASK-392 closeout — the kill-switch's SEED-TIME initial value is now
 * environment-driven so an env can come up with enforcement already ON without
 * any code change, while keeping the default SAFE (OFF):
 *
 *   - DEV  → `.env.dev` sets `ENTITLEMENTS_ENABLED_DEFAULT=true` → fresh DEV seed = ON.
 *   - STAGING → its deploy/host env sets `ENTITLEMENTS_ENABLED_DEFAULT=true` → ON on the
 *     next deploy+seed (staging uses host env; there is no committed `.env.staging`).
 *   - TEST/CI → `.env.test` (and CI) never set the var → default **false** → OFF, so the
 *     shared E2E baseline stays OFF even after a `pnpm test:db:reset`.
 *   - PRODUCTION → host env unset → OFF (prod enablement is a separate decision).
 *
 * This only affects a FRESH row (the `create` branch). On an existing DB the
 * kill-switch upsert's `update` branch intentionally omits `value`, so a re-seed
 * NEVER clobbers a live operator toggle (flip it any time via
 * `PUT /admin/entitlements/enabled`). `defaultValue` stays the canonical `'false'`.
 */
const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);
const ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT = TRUTHY_ENV.has((process.env.ENTITLEMENTS_ENABLED_DEFAULT ?? '').trim().toLowerCase());

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
            // Fresh-DB initial value is env-driven (DEV/STAGING=ON, TEST/CI/PROD=OFF).
            // `defaultValue` stays the canonical safe 'false' (reset target).
            value: String(ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT),
            defaultValue: 'false',
            dataType: ValueType.Boolean,
            description: 'Global entitlements enforcement kill-switch. Set to true to enable quota/feature gating platform-wide.',
            locked: false,
            createdBy: CREATED_BY,
        },
    });
    console.log(`  entitlements/entitlements.enabled = ${ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT} (fresh-DB seed default; env ENTITLEMENTS_ENABLED_DEFAULT)`);

    console.log(`Seeded ${PLAN_ENTITLEMENTS.length} plan entitlements + kill-switch (fresh-DB default ${ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT ? 'ON' : 'OFF'})`);
};
