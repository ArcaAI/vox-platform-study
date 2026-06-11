import { createHash, createHmac } from 'crypto';
import type { CorePrismaClient } from '../../../client';
import { getNodeEnv, type Environment } from '../../../env';
import { ApiKeyStatus, ApiKeyType } from '../../../generated/core-prisma-client/client.js';
import {
    SEED_TENANT_ID,
    SEED_CUSTOMER_TENANT_IDS,
    SEED_API_KEY_IDS,
    SEED_API_KEY_RAW,
    SEED_USER_IDS,
} from './00-constants';
import { resolveApiKeyPepper } from './api-key-pepper';

/**
 * TASK-331 doc-08 F5 — dev/test gate predicate (single source of truth).
 *
 * The demo API keys below embed raw secrets (from 00-constants), ACTIVE status
 * and broad scopes. They are LOCAL DEV fixtures only and must never be seeded
 * in production/staging. This predicate is reused by the seed orchestrator
 * (`SEED_DEMO_DATA` in index.ts) and by the defence-in-depth guard inside
 * `seedApiKey`, so the gate and the guard can never disagree.
 */
export function shouldSeedApiKeys(env: Environment = getNodeEnv()): boolean {
  return env === 'development' || env === 'test';
}

/**
 * TASK-331 doc-08 F5 — build a non-secret, masked preview of a raw key for
 * confirmation logging. Exposes at most the first 4 characters (the shared,
 * non-sensitive `hope` prefix) and masks the remainder, e.g. `hope****`.
 */
export function maskSecret(rawKey: string): string {
  return `${rawKey.slice(0, 4)}****`;
}

/**
 * Hash an API key — HMAC-SHA256 when a pepper is provided, plain SHA-256
 * otherwise. This must match `ApiKeyService.hashKey`. TASK-352: the pepper
 * is resolved once per seed run via `resolveApiKeyPepper` (env first, then
 * Vault KV when SECRETS_PROVIDER=vault) so seeded hashes always match what
 * the running API computes at validation time.
 */
function hashApiKey(rawKey: string, pepper?: string): string {
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
            'stt:transcription:read', 'stt:transcription:write', 'stt:stream:write',
            'consultation:session:read', 'consultation:session:write', 'consultation:report:read',
            'user:preferences:read', 'user:preferences:write',
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
            'stt:transcription:read', 'stt:transcription:write', 'stt:stream:write',
            'consultation:session:read', 'consultation:session:write', 'consultation:report:read',
            'user:preferences:read', 'user:preferences:write',
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
            'stt:transcription:read', 'stt:transcription:write', 'stt:stream:write',
            'consultation:session:read', 'consultation:session:write', 'consultation:report:read',
            'user:preferences:read', 'user:preferences:write',
            'admin:user:read', 'admin:apikey:read', 'admin:tenant:read',
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
            'stt:transcription:read', 'stt:transcription:write', 'stt:stream:write',
            'consultation:session:read', 'consultation:session:write', 'consultation:report:read',
            'user:preferences:read', 'user:preferences:write',
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
  // TASK-331 doc-08 F5 — defence in depth. The orchestrator already gates this
  // step behind `SEED_DEMO_DATA` (dev/test only); refuse to run if invoked
  // directly outside dev/test so the raw-secret fixtures can never reach
  // production/staging even if the gate is bypassed.
  const env = getNodeEnv();
  if (!shouldSeedApiKeys(env)) {
    throw new Error(
      `Refusing to seed API keys: NODE_ENV="${env}" is not development/test. ` +
        'Demo API-key fixtures contain raw secrets and must never be seeded outside local dev/test.'
    );
  }

  console.log('Seeding API keys...');

  // TASK-352 — resolve OUTSIDE the try/catch: in vault mode a resolution
  // failure must abort the seed loudly, not be swallowed by the catch below
  // (plain-SHA hashes seeded in vault mode 401 against the running API).
  const pepper = await resolveApiKeyPepper();
  console.log(
    pepper
      ? '  Key hashing: HMAC-SHA256 with API_KEY_PEPPER (matches runtime validation)'
      : '  Key hashing: plain SHA-256 (no API_KEY_PEPPER configured)'
  );

  try {
    console.log('\n📋 Development API Keys (raw values defined in seed/00-constants.ts):');
    console.log('─'.repeat(60));

    for (const { rawKey, keyName, ...apiKeyData } of DEFAULT_API_KEYS) {
      const keyHash = hashApiKey(rawKey, pepper);
      const keyPrefix = extractPrefix(rawKey);
      const keyChecksum = extractChecksum(rawKey);

      // F5 — never print the raw secret; log only a non-secret reference plus a
      // masked preview (at most the first 4 chars).
      console.log(`  ${keyName}:`);
      console.log(`    Key ID:  ${apiKeyData.id}`);
      console.log(`    Tenant:  ${apiKeyData.tenantId}`);
      console.log(`    Preview: ${maskSecret(rawKey)}`);
      console.log('');

      // Upsert by primary key (not keyHash) so re-seeding after an API_KEY_PEPPER
      // change updates the existing row's hash in place instead of colliding on id.
      await client.apiKey.upsert({
        where: { id: apiKeyData.id },
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
