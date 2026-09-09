import type { CorePrismaClient } from '../../../client';
import { platformStorageEndpoint } from './05c-platform-storage-config';
import { ResourceStatusType, ValueType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * STT (Speech-to-Text) Seed Data
 *
 * This script seeds the STT service's Global Settings (`DEFAULT_STT_SETTINGS`)
 * and scrubs the plaintext credential rows an older seed planted.
 *
 * These rows are PLATFORM-WIDE system seeds: every customer tenant inherits
 * them; they are NOT customer data. Therefore they are owned by the reserved
 * system tenant (`00000000-…`).
 *
 * The AI model catalogue moved to `06-ai-models.ts` (TASK-860). The
 * `AsrPipeline` / `AsrPipelineVersion` seed half and the SYSTEM
 * `TenantSttConfig` platform-default row were DELETED by TASK-861 (recorded
 * follow-up of step 11): transcription is configured as an ASR Agent
 * (`25-agents.ts`, `platform-transcription`) that the gateway resolves into a
 * `ResolvedAsrSpec`, so no pipeline row and no fallback pointer are seeded any
 * more. The deprecated tables stay for the window (removed in R4).
 */

// `DEFAULT_TENANT_ID` is kept as a local re-export so existing call sites
// (e.g. internal helpers, tests) still compile, but the value now points at
// the reserved system tenant.
export const DEFAULT_TENANT_ID = SYSTEM_TENANT_ID;
export { SYSTEM_USER_ID } from './00-constants';

// =============================================================================
// ENUM MIRRORS (the catalogue itself lives in 06-ai-models.ts)
// Re-exported here so existing importers (seed tests) keep working.
// =============================================================================

export { AiModelSource, AiModelFormat, ModelCategory, ModelTaskType, ModelType, AI_MODEL_PROVIDERS } from './ai-models/shared';
export type { AiModelSeed, TtsVoiceBinding } from './ai-models/shared';

// =============================================================================
// GLOBAL SETTINGS FOR STT SERVICE
// =============================================================================

export const DEFAULT_STT_SETTINGS = [
  // The `model_cache` (max_models / ttl_seconds / max_memory_mb) and
  // `workers` (concurrency / batch_queue / streaming_queue) rows were REMOVED here.
  //
  // They were never read by anything: stt's only GlobalSetting reader was the
  // `GlobalSettingRead` SQLAlchemy mapping, which had zero callers and is now
  // deleted. Their replacements are registered settings keys served over
  // `GET /api/v1/internal/effective-config?service=stt`:
  //     stt.modelCache.{maxModels,ttlSeconds,maxMemoryMb}
  //     stt.workers.concurrency
  // (packages/applications/src/services/settings-registry/descriptors/service-runtime.descriptors.ts)
  //
  // `workers.batch_queue` / `workers.streaming_queue` have NO replacement because
  // they had no consumer either: the queue names are hardcoded (`stt_batch`,
  // `default`) in worker.py and the actor's `queue_name`.
  //
  // NOTE the descriptor for maxMemoryMb defaults to 10000, NOT the 16384 this
  // seed carried: 16384 was never in force (no reader), while the running code
  // has always used the 10000 ctor fallback in models/cache.py. Preserving 16384
  // would have silently raised the cache ceiling 64% on first deploy.

  // Storage Settings
  {
    id: '82000000-0000-0000-0003-000000000001',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'storage',
    key: 'audio_bucket',
    value: 'hope-audio',
    defaultValue: 'hope-audio',
    dataType: ValueType.String,
    description: 'MinIO bucket for audio storage',
  },
  {
    id: '82000000-0000-0000-0003-000000000002',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'storage',
    key: 'chunk_bucket',
    value: 'hope-audio-chunks',
    defaultValue: 'hope-audio-chunks',
    dataType: ValueType.String,
    description: 'MinIO bucket for streaming audio chunks',
  },

  // S3/MinIO Connection Settings (used by S3Service via AppSettingsService)
  {
    id: '82000000-0000-0000-0003-000000000010',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'platform',
    name: 's3',
    key: 'S3_ENDPOINT',
    // derived exactly like the SYSTEM `TenantStorageConfig` row (scheme + host from
    // `MINIO_ENDPOINT`/`MINIO_USE_SSL`); the old `http://localhost:<port>` literal dialled nothing in-cluster.
    value: platformStorageEndpoint(),
    defaultValue: 'http://localhost:9000',
    dataType: ValueType.String,
    description: 'S3-compatible storage endpoint (MinIO)',
  },
  // `S3_ACCESS_KEY` and `S3_SECRET_KEY` were
  // seeded here as PLAINTEXT `GlobalSetting` rows (ids …0011 / …0012). A
  // credential never belongs in a DB column in the clear; these now live in
  // Vault kv-v2 under the `s3.accessKey` / `s3.secretKey` descriptors
  // (`platform-secrets.descriptors.ts`), seeded by
  // `scripts/vault-seed-secrets.sh` and, for the dev container, by
  // `infrastructure/docker/configs/vault/dev-init.sh`. Under
  // `SECRETS_PROVIDER=env` they resolve from the process environment instead.
  //
  // The credential VALUES were already read via `SecretsService.getSecretSync()`
  // — these rows only still gated `S3Service.hasRequiredConfiguration()`, which
  // now asks SecretsService directly.
  {
    id: '82000000-0000-0000-0003-000000000013',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'platform',
    name: 's3',
    key: 'S3_REGION',
    value: 'us-east-1',
    defaultValue: 'us-east-1',
    dataType: ValueType.String,
    description: 'S3 region',
  },
  // ids 0014 (S3_PRIVATE_BUCKET) / 0015 (S3_PUBLIC_BUCKET) RETIRED (TASK-932
  // OD-8, 2026-09-09): a legacy platform-wide bucket pair nothing provisions
  // (dev MinIO never carried `hope-public`/`hope-private`) and the ONLY
  // reader was `S3Service.testConnection()`'s health probe, which listed
  // objects in whichever of the two existed — so a real MinIO carrying
  // neither answered `NoSuchBucket` and the health check reported
  // "unreachable" while MinIO was healthy. `testConnection()` now probes
  // with an account-level `ListBucketsCommand` instead and needs no named
  // bucket at all. Ids stay reserved; `RETIRED_GLOBAL_SETTING_KEYS`
  // (`seed/11-global-setting.ts`) sweeps the copies an already-provisioned
  // database holds to `resourceStatus: DELETED`.
  {
    id: '82000000-0000-0000-0003-000000000016',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'platform',
    name: 's3',
    key: 'S3_FORCE_PATH_STYLE',
    value: 'true',
    defaultValue: 'true',
    dataType: ValueType.Boolean,
    description: 'Force path-style URLs (required for MinIO)',
  },

  // HuggingFace Settings
  {
    id: '82000000-0000-0000-0004-000000000001',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'huggingface',
    key: 'cache_dir',
    value: '/models/hf-cache',
    defaultValue: '/models/hf-cache',
    dataType: ValueType.String,
    description: 'Local directory for HuggingFace model cache',
  },
  {
    id: '82000000-0000-0000-0004-000000000002',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'huggingface',
    key: 'offline_mode',
    value: 'false',
    defaultValue: 'false',
    dataType: ValueType.Boolean,
    description: 'Run in offline mode (use only cached models)',
  },

  // API Gateway Settings
  {
    id: '82000000-0000-0000-0005-000000000001',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'api_gateway',
    key: 'base_url',
    value: 'http://api:8868/api/v1',
    defaultValue: 'http://api:8868/api/v1',
    dataType: ValueType.String,
    description: 'Internal API Gateway base URL',
  },
  {
    id: '82000000-0000-0000-0005-000000000002',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'api_gateway',
    key: 'timeout_seconds',
    value: '30',
    defaultValue: '30',
    dataType: ValueType.Integer,
    description: 'API Gateway request timeout in seconds',
  },

  // Default Pipeline Settings
  {
    id: '82000000-0000-0000-0006-000000000001',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'defaults',
    key: 'batch_pipeline_slug',
    // Batch + streaming defaults point at the ArcaAI ml-en GGUF fine-tune
    // (arcaai-whisper-large-ml-en-gguf) — the generic whisper-turbo GGUF
    // pinned to ml produced garbage Malayalam, so the in-house code-switch
    // fine-tune is the default.
    value: 'arcaai-whisper-large-ml-en-gguf',
    defaultValue: 'arcaai-whisper-large-ml-en-gguf',
    dataType: ValueType.String,
    description: 'Default pipeline slug for batch transcription',
  },
  {
    id: '82000000-0000-0000-0006-000000000002',
    tenantId: DEFAULT_TENANT_ID,
    namespace: 'stt.config',
    name: 'defaults',
    key: 'streaming_pipeline_slug',
    // See batch_pipeline_slug note above.
    value: 'arcaai-whisper-large-ml-en-gguf',
    defaultValue: 'arcaai-whisper-large-ml-en-gguf',
    dataType: ValueType.String,
    description: 'Default pipeline slug for streaming transcription',
  },
];

// =============================================================================
// SEED FUNCTIONS
// =============================================================================

/**
 * Keys whose plaintext `GlobalSetting` rows are superseded by Vault kv-v2
 * (lane G G4). Removing them from `DEFAULT_STT_SETTINGS`
 * stops NEW databases getting them, but existing databases still hold the
 * credential in the clear — so sweep them here.
 */
export const PURGED_PLAINTEXT_SECRET_KEYS: readonly string[] = ['S3_ACCESS_KEY', 'S3_SECRET_KEY'];

/**
 * Idempotently scrub the superseded plaintext credential rows across ALL
 * tenants.
 *
 * The value is OVERWRITTEN before the row is retired: a soft delete alone
 * would leave the secret readable in the `value` column, which is precisely
 * the posture M10 forbids. This is an UPDATE, never a hard delete — no row is
 * destroyed, so the house rule against destructive seed operations holds.
 *
 * Rows already scrubbed are excluded, so a re-run writes nothing.
 */
export const purgePlaintextSecretSettings = async (client: CorePrismaClient): Promise<{ purged: number }> => {
  console.log('Purging superseded plaintext secret Global Settings (M10)...');

  const SCRUBBED = '__MOVED_TO_VAULT__';
  let purged = 0;

  for (const key of PURGED_PLAINTEXT_SECRET_KEYS) {
    const result = await client.globalSetting.updateMany({
      where: { key, value: { not: SCRUBBED } },
      data: {
        value: SCRUBBED,
        defaultValue: SCRUBBED,
        description: 'Superseded by Vault kv-v2 . Resolved via SecretsService, never from this row.',
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: SYSTEM_USER_ID,
        version: { increment: 1 },
      },
    });
    if (result.count > 0) {
      console.log(`  Purged ${key} (${result.count} row(s) across all tenants)`);
    }
    purged += result.count;
  }

  console.log(`Purged ${purged} plaintext secret Global Setting row(s)`);
  return { purged };
};

export const seedSttSettings = async (client: CorePrismaClient) => {
  console.log('Seeding STT Global Settings...');

  for (const settingData of DEFAULT_STT_SETTINGS) {
    const existing = await client.globalSetting.findFirst({
      where: {
        tenantId: settingData.tenantId,
        name: settingData.name,
        key: settingData.key,
      },
    });

    if (existing) {
      console.log(`  Setting "${settingData.namespace}.${settingData.name}.${settingData.key}" already exists, updating...`);
      await client.globalSetting.update({
        where: { id: existing.id },
        data: {
          value: settingData.value,
          defaultValue: settingData.defaultValue,
          description: settingData.description,
        },
      });
    } else {
      console.log(`  Creating setting "${settingData.namespace}.${settingData.name}.${settingData.key}"...`);
      await client.globalSetting.create({
        data: settingData,
      });
    }
  }

  console.log(`Seeded ${DEFAULT_STT_SETTINGS.length} STT Settings`);
  return { success: true, count: DEFAULT_STT_SETTINGS.length };
};

/**
 * Main seed function for STT domain
 * Seeds: Global Settings (the ASR pipeline half is gone — TASK-861)
 */
export const seedStt = async (client: CorePrismaClient) => {
  console.log('Starting STT domain seeding...\n');

  try {
    await seedSttSettings(client);
    console.log('');

    // Scrub credential rows this seed used to plant in plaintext. Runs AFTER
    // seedSttSettings so a re-seed can never leave a freshly written value behind.
    await purgePlaintextSecretSettings(client);
    console.log('');

    console.log('STT domain seeding completed successfully!');
    return { success: true };
  } catch (error) {
    console.error('Error during STT domain seeding:', error);
    throw error;
  }
};
