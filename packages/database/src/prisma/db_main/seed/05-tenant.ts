import type { CorePrismaClient } from '../../../client';
import { TenantPlan, TranscriptionMode } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS, SYSTEM_TENANT_ID } from './00-constants';

export { SEED_TENANT_ID as DEFAULT_TENANT_ID } from './00-constants';

const SYSTEM_TENANT = {
  id: SYSTEM_TENANT_ID,
  name: 'System',
  key: '__SYSTEM__',
  description: 'Reserved system tenant for platform-wide rows (policies, roles, system AI models). DO NOT use for customer data.',
};

const GLOBAL_TENANT = {
  id: SEED_TENANT_ID,
  name: 'Global',
  key: '__GLOBAL__',
  // was 'System-wide default tenant — do not remove', which is the
  // exact "default tenant" framing `.claude/rules/00-project-context.md`
  // exists to stop. This
  // is a CUSTOMER tenant used as a platform-admin playground; the runtime
  // cascade is request tenant → SYSTEM, and this id must never appear in it.
  // (Several runtime constants still DO treat it as a platform tier — see the
  // Decisions; correcting the row's own description is
  // the part that belongs to the seed.)
  description: 'Global — a CUSTOMER tenant used as the platform-admin playground for trialling configuration before promoting it into the SYSTEM tier. Not a config tier; never a runtime fallback.',
};

const CUSTOMER_TENANTS = [
  {
    id: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI',
    key: 'ARCAAI',
    // was 'retained as the secondary tenant backing cross-tenant
    // isolation E2E tests', which described the row by the TEST that reads it
    // rather than by what it IS. This is the day-1 customer tenant: it carries
    // the clinical department catalog, the approved prompt library, the loop
    // defaults, the frontend pipeline config and the bootstrap
    // tenant admin + machine identity. It still backs the cross-tenant e2e
    // suite; that is a consequence of being a real second tenant, not its
    // purpose.
    description: 'ArcaAI — the day-1 customer tenant: clinical departments, approved prompt library, agent defaults, tenant administrator and machine identity. Tenant-scoped like any customer; never a config tier.',
    // (owner decision, 2026-08-20): ArcaAI is the one seeded
    // tenant with a commercially-modelled plan. Every other seeded tenant
    // (SYSTEM, Global) keeps `plan = null` and resolves ungated-legacy via
    // `resolveEntitlements`'s Q3 rule — see
    // packages/applications/src/services/entitlements/resolve-entitlements.ts.
    plan: TenantPlan.ENTERPRISE,
  },
];

export const ALL_TENANTS = [SYSTEM_TENANT, GLOBAL_TENANT, ...CUSTOMER_TENANTS];

export const seedTenant = async (client: CorePrismaClient) => {
  console.log('Seeding tenants...');

  try {
    for (const tenant of ALL_TENANTS) {
      await client.tenant.upsert({
        where: { key: tenant.key },
        update: tenant,
        create: tenant,
      });
    }

    console.log(`Seeded ${ALL_TENANTS.length} tenants`);
  } catch (error) {
    console.error('Error seeding tenants:', error);
    throw error;
  }
};

// ============================================================================
// Tenant Frontend Config
//
// One row per tenant describing the DEFAULT frontend audio-processing pipeline
// applied to all of a tenant's users. No seed previously created any rows, so
// the SDK had no per-tenant frontend baseline. We seed conservative defaults
// for the Global/SEED tenant and each customer tenant; `configJson` is left as
// an empty object for admins to extend. Idempotent: upsert by the unique
// `tenantId`.
//
// Exported for testing purposes.
// ============================================================================

export const TENANT_FRONTEND_CONFIGS = [
  {
    tenantId: SEED_TENANT_ID,
    asrModel: null,
    noiseCancel: false,
    vad: true,
    voiceEnrollment: false,
    diarization: false,
    // Backend is the default realtime transcription
    // pipeline for the Global tenant, and it is LOCKED so an impersonated
    // doctor's per-user `workflowMode` cannot fall back to the browser-local
    // pipeline (server-authoritative; see UserPreferencesService
    // resolveEffectiveTranscriptionMode). Other tenants stay unlocked so
    // local STT remains opt-in there.
    transcriptionMode: TranscriptionMode.BACKEND,
    transcriptionModeLocked: true,
    // Clinical Workflow Playground (WS6) — enable dual-capture for the Global
    // demo tenant. Effective SDK enablement is this column AND the platform
    // capability `enable-local-raw-capture` (also flipped to true in the
    // platform-settings seed). Other tenants keep the column default (false).
    captureRawAudio: true,
    configJson: {},
  },
  {
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    asrModel: null,
    noiseCancel: false,
    vad: true,
    voiceEnrollment: false,
    diarization: false,
    // ArcaAI is a production-ready day-1 tenant and mirrors the Global tenant's
    // realtime posture exactly: BACKEND is the default transcription pipeline and
    // it is LOCKED so an impersonated doctor's per-user `workflowMode` cannot fall
    // back to the browser-local pipeline (server-authoritative; see
    // UserPreferencesService resolveEffectiveTranscriptionMode). Dual-capture
    // (`captureRawAudio`) is enabled alongside the platform capability
    // `enable-local-raw-capture`.
    transcriptionMode: TranscriptionMode.BACKEND,
    transcriptionModeLocked: true,
    captureRawAudio: true,
    configJson: {},
  },
];

export const seedTenantFrontendConfig = async (client: CorePrismaClient) => {
  console.log('Seeding tenant frontend configs...');

  try {
    for (const cfg of TENANT_FRONTEND_CONFIGS) {
      await client.tenantFrontendConfig.upsert({
        where: { tenantId: cfg.tenantId },
        update: cfg,
        create: cfg,
      });
    }

    console.log(`Seeded ${TENANT_FRONTEND_CONFIGS.length} tenant frontend configs`);
  } catch (error) {
    console.error('Error seeding tenant frontend configs:', error);
    throw error;
  }
};
