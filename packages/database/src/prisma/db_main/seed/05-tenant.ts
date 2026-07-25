import type { CorePrismaClient } from '../../../client';
import { TranscriptionMode } from '../../../generated/core-prisma-client/client.js';
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
  description: 'System-wide default tenant — do not remove',
};

const CUSTOMER_TENANTS = [
  {
    id: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    name: 'ArcaAI',
    key: 'ARCAAI',
    description: 'ArcaAI customer environment — retained as the secondary tenant backing cross-tenant isolation E2E tests',
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
