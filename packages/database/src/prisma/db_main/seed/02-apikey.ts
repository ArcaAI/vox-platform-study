import { createHash, createHmac } from 'crypto';
import type { CorePrismaClient } from '../../../client';
import { ApiKeyStatus, ApiKeyType } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS, SEED_API_KEY_IDS, SEED_API_KEY_RAW, SEED_USER_IDS } from './00-constants';

/**
 * Hash an API key using SHA-256
 * This must match the hashing in ApiKeyService
 */
function hashApiKey(rawKey: string): string {
  const pepper = process.env.API_KEY_PEPPER;
  if (pepper) {
    return createHmac('sha256', pepper).update(rawKey).digest('hex');
  }
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Extract checksum from key (last segment after underscore)
 */
function extractChecksum(rawKey: string): string | null {
  const parts = rawKey.split('_');
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/**
 * Extract prefix from key (first 12 characters)
 */
function extractPrefix(rawKey: string): string {
  return rawKey.substring(0, 12);
}

export const DEFAULT_API_KEYS = [
  {
    id: SEED_API_KEY_IDS.SDK_DOCTOR,
    rawKey: SEED_API_KEY_RAW.SDK_DOCTOR,
    keyName: 'SDK Test API Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for development and testing - linked to doctor user',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR,
    scopes: [
      'stt:transcription:read',
      'stt:transcription:write',
      'stt:stream:write',
      'consultation:session:read',
      'consultation:session:write',
      'consultation:report:read',
      'user:preferences:read',
      'user:preferences:write',
    ],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.SDK_DOCTOR2,
    rawKey: SEED_API_KEY_RAW.SDK_DOCTOR2,
    keyName: 'SDK API Key - Doctor 2',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for doctor2 - for multi-user testing',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR2,
    scopes: [
      'stt:transcription:read',
      'stt:transcription:write',
      'stt:stream:write',
      'consultation:session:read',
      'consultation:session:write',
      'consultation:report:read',
      'user:preferences:read',
      'user:preferences:write',
    ],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.WEBHOOK_ADMIN,
    rawKey: SEED_API_KEY_RAW.WEBHOOK_ADMIN,
    keyName: 'Webhook Integration Key',
    keyType: ApiKeyType.WEBHOOK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'Webhook API key for tenant admin - receives event notifications',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.TENANT_ADMIN,
    scopes: ['webhook:event:read', 'webhook:event:write'],
    rateLimit: 500,
  },
  {
    id: SEED_API_KEY_IDS.SERVICE_ACCOUNT,
    rawKey: SEED_API_KEY_RAW.SERVICE_ACCOUNT,
    keyName: 'Service Account Key',
    keyType: ApiKeyType.SERVICE_ACCOUNT,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'Service account API key for backend integrations',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.SERVICE_ACCOUNT,
    scopes: ['*'],
    rateLimit: 5000,
  },
  {
    id: SEED_API_KEY_IDS.SDK_ARCAAI,
    rawKey: SEED_API_KEY_RAW.SDK_ARCAAI,
    keyName: 'ArcaAI Tenant SDK Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for ArcaAI tenant admin - multi-tenant testing',
    environment: 'development',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    userId: SEED_USER_IDS.ARCAAI_ADMIN,
    scopes: [
      'stt:transcription:read',
      'stt:transcription:write',
      'stt:stream:write',
      'consultation:session:read',
      'consultation:session:write',
      'consultation:report:read',
      'user:preferences:read',
      'user:preferences:write',
      'admin:user:read',
      'admin:apikey:read',
      'admin:tenant:read',
    ],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.REVOKED_DOCTOR,
    rawKey: SEED_API_KEY_RAW.REVOKED_DOCTOR,
    keyName: 'Revoked Test Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.REVOKED,
    description: 'Revoked SDK key for testing key revocation flow',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR,
    scopes: ['stt:transcription:read', 'consultation:session:read'],
    rateLimit: 100,
  },
  {
    id: SEED_API_KEY_IDS.SDK_SURGERY,
    rawKey: SEED_API_KEY_RAW.SDK_SURGERY,
    keyName: 'SDK API Key - Surgery',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for doctor_surgery - surgical workflow testing',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR_SURGERY,
    scopes: [
      'stt:transcription:read',
      'stt:transcription:write',
      'stt:stream:write',
      'consultation:session:read',
      'consultation:session:write',
      'consultation:report:read',
      'user:preferences:read',
      'user:preferences:write',
    ],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.INTEGRATION_ARCAAI,
    rawKey: SEED_API_KEY_RAW.INTEGRATION_ARCAAI,
    keyName: 'ArcaAI Integration Key',
    keyType: ApiKeyType.INTEGRATION,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'Integration API key for ArcaAI tenant - read-only data access',
    environment: 'development',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    userId: SEED_USER_IDS.ARCAAI_ADMIN,
    scopes: ['stt:*', 'consultation:*'],
    rateLimit: 2000,
  },
  {
    id: SEED_API_KEY_IDS.EXPIRED_DOCTOR2,
    rawKey: SEED_API_KEY_RAW.EXPIRED_DOCTOR2,
    keyName: 'Expired Test Key - Doctor2',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.EXPIRED,
    description: 'Expired SDK key for testing key expiration flow',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR2,
    scopes: ['stt:transcription:read', 'consultation:session:read'],
    rateLimit: 100,
  },
];

export const seedApiKey = async (client: CorePrismaClient) => {
  console.log('Seeding API keys...');

  try {
    console.log('\n📋 Development API Keys (use these in your requests):');
    console.log('─'.repeat(60));

    for (const { rawKey, keyName, ...apiKeyData } of DEFAULT_API_KEYS) {
      const keyHash = hashApiKey(rawKey);
      const keyPrefix = extractPrefix(rawKey);
      const keyChecksum = extractChecksum(rawKey);

      console.log(`  ${keyName}:`);
      console.log(`    Raw Key: ${rawKey}`);
      console.log(`    Prefix:  ${keyPrefix}`);
      console.log('');

      await client.apiKey.upsert({
        where: { keyHash },
        update: {
          ...apiKeyData,
          keyName,
          keyHash,
          keyPrefix,
          keyChecksum,
        },
        create: {
          ...apiKeyData,
          keyName,
          keyHash,
          keyPrefix,
          keyChecksum,
        },
      });
    }

    console.log('─'.repeat(60));
    console.log('API key seeding completed successfully\n');
  } catch (error) {
    console.error('Error seeding API keys:', error);
  }
};
