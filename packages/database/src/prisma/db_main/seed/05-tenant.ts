import type { CorePrismaClient } from '../../../client';
import { SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS, SYSTEM_TENANT_ID } from './00-constants';

export { SEED_TENANT_ID as DEFAULT_TENANT_ID } from './00-constants';

const SYSTEM_TENANT = {
    id: SYSTEM_TENANT_ID,
    name: 'System',
    key: '__SYSTEM__',
    description:
        'Reserved system tenant for platform-wide rows (policies, roles, system AI models). DO NOT use for customer data.',
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
        description: 'ArcaAI customer environment',
    },
    {
        id: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        name: '4bits',
        key: '4BITS',
        description: '4bits customer environment',
    },
    {
        id: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
        name: 'Mumbai General Hospital',
        key: 'MUMBAI_HOSPITAL',
        description: 'Mumbai General Hospital — multi-site hospital group for multi-tenant testing',
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
// Tenant Frontend Config (TASK-328 A6 Q5 / TASK-331 doc-03 F3)
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
    {
        tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        asrModel: null,
        noiseCancel: false,
        vad: true,
        voiceEnrollment: false,
        diarization: false,
        configJson: {},
    },
    {
        tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
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
