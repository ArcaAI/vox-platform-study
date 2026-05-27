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
