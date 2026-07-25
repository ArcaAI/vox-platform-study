import { createHash, randomBytes, randomUUID } from 'crypto';
import { config } from 'dotenv';
import { resolve } from 'path';
import pg from 'pg';

const workspaceRoot = resolve(process.cwd(), '../..');
config({ path: resolve(workspaceRoot, '.env') });

const KEY_SERVICE_PREFIX = 'hope';

const KEY_TYPE_PREFIX: Record<string, string> = {
  SDK: 'sk',
  WEBHOOK: 'wh',
  INTEGRATION: 'int',
  SERVICE_ACCOUNT: 'sa',
};

function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

function extractChecksum(rawKey: string): string | null {
  const parts = rawKey.split('_');
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

function extractPrefix(rawKey: string): string {
  return rawKey.substring(0, 12);
}

export function generateRawKey(keyType: string = 'SDK'): string {
  const typePrefix = KEY_TYPE_PREFIX[keyType] || 'sk';
  const randomPart = randomBytes(32).toString('hex');
  const checksum = createHash('sha256').update(randomPart).digest('hex').substring(0, 6);

  return `${KEY_SERVICE_PREFIX}_${typePrefix}_${randomPart}_${checksum}`;
}

function getPool(): pg.Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL not found in environment variables.\n' + 'Please ensure your .env file in the workspace root contains DATABASE_URL.',
    );
  }
  return new pg.Pool({ connectionString, max: 1 });
}

export interface ApiKeyRecord {
  id: string;
  keyName: string;
  keyPrefix: string;
  keyType: string;
  keyStatus: string;
  tenantId: string | null;
  userId: string | null;
  scopes: string[] | null;
  environment: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  usageCount: number;
  expiresAt: Date | null;
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const pool = getPool();
  try {
    const result = await pool.query(`
            SELECT id, "keyName", "keyPrefix", "keyType"::text, "keyStatus"::text,
                   "tenantId", "userId", scopes, environment, "createdAt",
                   "lastUsedAt", "usageCount", "expiresAt"
            FROM core."ApiKey"
            WHERE "resourceStatus" != 'DELETED'
            ORDER BY "createdAt" DESC
        `);
    return result.rows;
  } finally {
    await pool.end();
  }
}

export interface CreateApiKeyOptions {
  keyName: string;
  keyType?: string;
  tenantId?: string;
  userId?: string;
  scopes?: string[];
  rateLimit?: number;
  environment?: string;
  description?: string;
}

export interface CreateApiKeyResult {
  rawKey: string;
  record: ApiKeyRecord;
}

export async function createApiKey(options: CreateApiKeyOptions): Promise<CreateApiKeyResult> {
  const {
    keyName,
    keyType = 'SDK',
    tenantId = '50000000-0000-0000-0000-000000000000',
    userId,
    scopes = ['read', 'write', 'consultations', 'preferences'],
    rateLimit = 1000,
    environment = 'development',
    description,
  } = options;

  const rawKey = generateRawKey(keyType);
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = extractPrefix(rawKey);
  const keyChecksum = extractChecksum(rawKey);

  const id = randomUUID();

  const pool = getPool();
  try {
    const result = await pool.query(
      `
            INSERT INTO core."ApiKey" (
                id, "keyName", "keyHash", "keyPrefix", "keyChecksum",
                "keyType", "keyStatus", "tenantId", "userId",
                scopes, "rateLimit", environment, description,
                "resourceStatus", "createdAt", "updatedAt"
            ) VALUES (
                $1, $2, $3, $4, $5,
                $6::core."ApiKeyType", 'ACTIVE'::core."ApiKeyStatus", $7, $8,
                $9::jsonb, $10, $11, $12,
                'ENABLED'::core."ResourceStatusType", NOW(), NOW()
            )
            RETURNING id, "keyName", "keyPrefix", "keyType"::text, "keyStatus"::text,
                      "tenantId", "userId", scopes, environment, "createdAt",
                      "lastUsedAt", "usageCount", "expiresAt"
        `,
      [
        id,
        keyName,
        keyHash,
        keyPrefix,
        keyChecksum,
        keyType,
        tenantId,
        userId || null,
        JSON.stringify(scopes),
        rateLimit,
        environment,
        description || null,
      ],
    );

    return {
      rawKey,
      record: result.rows[0],
    };
  } finally {
    await pool.end();
  }
}
