import type { CorePrismaClient } from '../../../client';
import { getNodeEnv, isCI, loadDatabaseEnv } from '../../../env';
import { TenantPlan, ValueType } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_USER_IDS, SEED_GLOBAL_SETTING_IDS, SEED_PLAN_ENTITLEMENT_IDS } from './00-constants';

/**
 * Plan entitlements seed.
 *
 * Seeds three things:
 *   1. The platform-wide per-plan default matrix (`PlanEntitlement`, one row per
 *      `TenantPlan`). This is the proposed STARTER → TRIAL → PRO → ENTERPRISE
 *      matrix anchored at ~100 seats for ENTERPRISE. `null` = unlimited.
 *   2. The entitlements enforcement kill-switch (`entitlements.enabled`
 *      GlobalSetting) under the platform tenant. The fresh-DB seed value is
 *      **derived**: every DEPLOYED env (hope-v2-dev, staging, production) comes
 *      up **ON**, while LOCAL dev and TEST/CI stay **OFF** — see the
 *      {@link ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT} note below (policy), which
 *      also records why the previous env-var-only form never actually turned it
 *      on in any deployed environment.
 * 3.: the metering reconcile-sweep kill-switch
 *      (`metering.reconcile.enabled` GlobalSetting), same platform tenant,
 *      same fresh-DB resolution (OQ3) via a SEPARATE
 *      `METERING_RECONCILE_ENABLED_DEFAULT` var — the two switches gate
 *      different things (quota/feature enforcement vs. a snapshot-persist
 *      job) and must be flippable independently.
 *
 * Values mirror
 * `packages/applications/src/services/entitlements/entitlements.constants.ts`
 * (`PLAN_ENTITLEMENT_DEFAULTS`) — kept in sync manually (the database package
 * must not depend on @arcaai/applications, matching the rate-limit seed).
 *
 * Idempotent: the matrix upsert is create-only (`update: {}`), so a re-seed
 * NEVER clobbers admin-tuned matrix values; both kill-switch upserts refresh
 * metadata but never overwrite a live `value`.
 */

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;
const GIB = 1024 ** 3;

/**
 * The kill-switch's SEED-TIME initial value.
 *
 * POLICY: enforcement is ON in every DEPLOYED environment and OFF only on a
 * developer laptop and in test/CI.
 *
 * That policy is unchanged. What changed is HOW a deployed env is recognised.
 * This used to require the deploy/host env to SET `ENTITLEMENTS_ENABLED_DEFAULT=true`,
 * and the comment here asserted that `hope-v2-dev` did so. It never did — the
 * var appears in no ConfigMap, no `turbo.json#globalEnv`, and no `.env.sample`
 * anywhere in the repo, so the "deployed ⇒ ON" half of the policy was
 * documentation, not behaviour. Worse, it was unfixable by adding the key alone:
 * the GitOps `db-migrate` Job deliberately carries NO `envFrom` (the DB-05 fix),
 * so a ConfigMap value would never have reached this process. Every fresh
 * cluster seed came up OFF, and TASK-643's platform-default credential gate —
 * which only takes effect when this switch is ON — sat inert.
 *
 * So the default is now INVERTED and derived, not stamped:
 *
 *   - explicit env var still WINS, in both directions (`true|1|yes|on` ⇒ ON,
 *     `false|0|no|off` ⇒ OFF). An operator can still force either posture.
 *   - unset ⇒ {@link isDeployedEnvironment}: ON in a deployed env, OFF locally
 *     and in test/CI.
 *
 * Per-environment outcome (identical to the policy above, now actually enforced):
 *   - LOCAL DEV → loads `.env.dev` ⇒ OFF, so a developer never fights quota locally.
 *   - `hope-v2-dev` / STAGING / PRODUCTION → host-env-only, no file ⇒ **ON**, with
 *     no ConfigMap key and no `envFrom` on the migrate Job.
 *   - TEST/CI → `NODE_ENV=test` / `CI` ⇒ OFF, so the shared E2E baseline stays OFF
 *     even after a `pnpm test:db:reset`.
 *
 * This only affects a FRESH row (the `create` branch). On an existing DB the
 * kill-switch upsert's `update` branch intentionally omits `value`, so a re-seed
 * NEVER clobbers a live operator toggle (flip it any time via
 * `PUT /admin/entitlements/enabled`). `defaultValue` stays the canonical `'false'`
 * — it is the RESET target (the safe value an operator reverts to), not the
 * fresh-seed value.
 *
 * KNOWN CONSEQUENCE: with enforcement ON by default in deployed envs, the open
 * fail-closed gap in `resolveForTenant` (TASK-646) becomes reachable there — a
 * failed read of the billing-only entitlements tables raises instead of falling
 * back, which can surface as a 500 on the clinical path. Accepted deliberately;
 * TASK-646 is the fix.
 */
const TRUTHY_ENV = new Set(['1', 'true', 'yes', 'on']);
const FALSY_ENV = new Set(['0', 'false', 'no', 'off']);

/**
 * A deployed environment is HOST-ENV-ONLY: it reads no env file. That is the
 * repo's own env contract (`src/env.ts`, mirroring
 * `packages/applications/src/common/env/env-file-resolution.ts`), so it is
 * reused here rather than inventing a second signal. `loadDatabaseEnv()` is
 * idempotent (`override: false`) and already ran at import of `../../../env`;
 * calling it again only re-reports whether a file was found.
 *
 * Edge case, deliberate: a checkout with no `.env.dev` at all counts as
 * deployed and seeds ON. That is the contract read literally — no file means
 * host env is the only configuration source — and it is the safe direction for
 * a switch that must default ON.
 */
function isDeployedEnvironment(): boolean {
  if (isCI()) return false;
  if (getNodeEnv() === 'test') return false;
  return !loadDatabaseEnv().loaded;
}

function resolveKillSwitchSeedDefault(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (TRUTHY_ENV.has(value)) return true;
  if (FALSY_ENV.has(value)) return false;
  return isDeployedEnvironment();
}

const ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT = resolveKillSwitchSeedDefault(process.env.ENTITLEMENTS_ENABLED_DEFAULT);

/**
 * Same resolution as {@link ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT}, for the
 * metering reconcile-sweep kill-switch. Independent variable
 * (`METERING_RECONCILE_ENABLED_DEFAULT`) on purpose: the two switches gate
 * unrelated things (quota/feature enforcement vs. a `TenantUsageMeter`
 * snapshot-persist job) and an operator must be able to flip one without the
 * other.
 */
const METERING_RECONCILE_SEED_DEFAULT = resolveKillSwitchSeedDefault(process.env.METERING_RECONCILE_ENABLED_DEFAULT);

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
  // Per-capability included allowances, derived in
  // from the RATIFIED business ceilings above:
  //
  //   sttSessionSeconds = transcriptionMinutes × 60 × 1.1 (session ≥ audio)
  //   llmTokens         = summaries          × 6,000      (in+out, all passes)
  //   ttsCharacters     = consultations      × 2,000
  //   nlpTextUnits      = consultations      ×    30      (100-char units)
  //   embeddingTokens   = consultations      × 1,500
  //
  // …then DOUBLED. The ×2 headroom is deliberate: `monthlyConsultations` is the
  // commercial cap, so these per-capability numbers exist as RUNAWAY GUARDS, not
  // as a second business ceiling. A tenant working normally inside its
  // consultation cap must never trip one; only a loop or an abusive workload
  // should. Tighten them only after shadow metering reports real per-consultation
  // intensity (the intensity constants above are estimates).
  //
  // `null` = unlimited (ENTERPRISE only — negotiated per contract).
  monthlySttSessionSeconds: bigint | null;
  monthlyLlmTokens: bigint | null;
  monthlyTtsCharacters: bigint | null;
  monthlyNlpTextUnits: bigint | null;
  monthlyEmbeddingTokens: bigint | null;
  featureDnaReports: boolean;
  featureVoiceEnrollment: boolean;
  featureMonitoringAccess: boolean;
  // May this plan's tenants consume the PLATFORM-DEFAULT
  // (SYSTEM-tenant) provider credential? `false` on every plan (OD-7): the
  // grant is sold per tenant via `TenantEntitlement`, because a plan-level
  // grant would hand every tenant on that tier a platform-funded cloud path —
  // the margin hole closed. Kept in sync by
  // `packages/applications/src/services/entitlements/__tests__/plan-matrix-parity.test.ts`.
  featurePlatformDefaultCredential: boolean;
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
  // RATIFIED 2026-08-08: PRO = $100/mo bundling 250 consultations.
  monthlyConsultations: 250,
  monthlyTranscriptionMinutes: 5_000, // 250 × 20-min average
  monthlySummaries: 250,
  // Derived + ×2 headroom — see the interface comment.
  monthlySttSessionSeconds: 660_000n, // 5,000 × 60 × 1.1 × 2
  monthlyLlmTokens: 3_000_000n, //        250 × 6,000     × 2
  monthlyTtsCharacters: 1_000_000n, //    250 × 2,000     × 2
  monthlyNlpTextUnits: 15_000n, //        250 ×    30     × 2
  monthlyEmbeddingTokens: 750_000n, //    250 × 1,500     × 2
  featureDnaReports: true,
  featureVoiceEnrollment: true,
  featureMonitoringAccess: false,
  featurePlatformDefaultCredential: false,
  modelTier: 'full',
  rateLimitTier: 'default',
};

/**
 * The seeded per-plan matrix. EXPORTED so the parity guard in
 * `@arcaai/applications` can assert it field-for-field against
 * `PLAN_ENTITLEMENT_DEFAULTS` — the two copies are hand-synced and, until that
 * test, nothing checked them. Follows the same export-for-test convention as
 * `SYSTEM_AI_PROVIDER_CONNECTIONS` (17-ai-provider-connection.ts).
 */
export const PLAN_ENTITLEMENTS: PlanEntitlementSeed[] = [
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
    // RATIFIED 2026-08-08: STARTER = $50/mo bundling 50 consultations.
    monthlyConsultations: 50,
    monthlyTranscriptionMinutes: 1_000, // 50 × 20-min average
    monthlySummaries: 50,
    // Derived + ×2 headroom — see the interface comment.
    monthlySttSessionSeconds: 132_000n, // 1,000 × 60 × 1.1 × 2
    monthlyLlmTokens: 600_000n, //            50 × 6,000     × 2
    monthlyTtsCharacters: 200_000n, //        50 × 2,000     × 2
    monthlyNlpTextUnits: 3_000n, //           50 ×    30     × 2
    monthlyEmbeddingTokens: 150_000n, //      50 × 1,500     × 2
    featureDnaReports: false,
    featureVoiceEnrollment: false,
    featureMonitoringAccess: false,
    featurePlatformDefaultCredential: false,
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
    // RATIFIED 2026-08-08: ENTERPRISE is NEGOTIATED — usage is
    // unlimited by default; a signed contract sets tenant-scoped overrides.
    // Structural caps (seats/departments/storage) stay finite on purpose.
    monthlyConsultations: null,
    monthlyTranscriptionMinutes: null,
    monthlySummaries: null,
    // Per-capability allowances: NULL = unlimited (negotiated per contract).
    monthlySttSessionSeconds: null,
    monthlyLlmTokens: null,
    monthlyTtsCharacters: null,
    monthlyNlpTextUnits: null,
    monthlyEmbeddingTokens: null,
    featureDnaReports: true,
    featureVoiceEnrollment: true,
    featureMonitoringAccess: true,
    featurePlatformDefaultCredential: false,
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
      // Fresh-DB initial value is derived (DEPLOYED=ON, LOCAL/TEST/CI=OFF),
      // overridable either way by the env var.
      // `defaultValue` stays the canonical safe 'false' (reset target).
      value: String(ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT),
      defaultValue: 'false',
      dataType: ValueType.Boolean,
      description: 'Global entitlements enforcement kill-switch. Set to true to enable quota/feature gating platform-wide.',
      locked: false,
      createdBy: CREATED_BY,
    },
  });
  console.log(
    `  entitlements/entitlements.enabled = ${ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT} (fresh-DB seed default; env ENTITLEMENTS_ENABLED_DEFAULT)`,
  );

  // 3. — metering reconcile-sweep kill-switch. Same platform
  //    tenant + upsert shape as the entitlements switch above, resolved
  //    independently (METERING_RECONCILE_ENABLED_DEFAULT). Off locally: capability/
  //    usage READS never depend on it (MeteringService.getCurrentUsage is
  //    always a live aggregate) — the job only warms a persisted snapshot.
  await client.globalSetting.upsert({
    where: {
      GlobalSetting_tenantId_name_key_unique: {
        tenantId: SEED_TENANT_ID,
        name: 'Metering Reconcile Enabled',
        key: 'metering.reconcile.enabled',
      },
    },
    update: {
      dataType: ValueType.Boolean,
      description:
        'Metering reconcile-sweep kill-switch. Persists per-(tenant, metric, window) usage snapshots into TenantUsageMeter; reads never depend on it.',
      namespace: 'metering',
    },
    create: {
      id: SEED_GLOBAL_SETTING_IDS.METERING_RECONCILE_ENABLED,
      tenantId: SEED_TENANT_ID,
      namespace: 'metering',
      name: 'Metering Reconcile Enabled',
      key: 'metering.reconcile.enabled',
      // Fresh-DB initial value is derived (DEPLOYED=ON, LOCAL/TEST/CI=OFF),
      // overridable either way by the env var.
      // `defaultValue` stays the canonical safe 'false' (reset target).
      value: String(METERING_RECONCILE_SEED_DEFAULT),
      defaultValue: 'false',
      dataType: ValueType.Boolean,
      description:
        'Metering reconcile-sweep kill-switch. Persists per-(tenant, metric, window) usage snapshots into TenantUsageMeter; reads never depend on it.',
      locked: false,
      createdBy: CREATED_BY,
    },
  });
  console.log(
    `  metering/metering.reconcile.enabled = ${METERING_RECONCILE_SEED_DEFAULT} (fresh-DB seed default; env METERING_RECONCILE_ENABLED_DEFAULT)`,
  );

  console.log(
    `Seeded ${PLAN_ENTITLEMENTS.length} plan entitlements + 2 kill-switches (entitlements.enabled fresh-DB default ${ENTITLEMENTS_ENFORCEMENT_SEED_DEFAULT ? 'ON' : 'OFF'}; metering.reconcile.enabled fresh-DB default ${METERING_RECONCILE_SEED_DEFAULT ? 'ON' : 'OFF'})`,
  );
};
