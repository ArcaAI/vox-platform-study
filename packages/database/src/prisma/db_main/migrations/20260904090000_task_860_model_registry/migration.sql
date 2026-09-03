-- ============================================================================
-- TASK-860 — Model Registry: platform-admin-only catalogue of the shared
-- model bucket, organised by Hugging Face task.
--
-- `model AiModel` moved from `stt.prisma` to `ai-model.prisma` (no DDL — the
-- table is unchanged by the move). This migration adds the registry columns
-- of README §3.2 and the `AiModelAvailability` enum, then performs the two
-- DATA steps the schema cannot express:
--
--   1. BACKFILL the three NOT NULL columns (`libraryName`, `servedBy`,
--      `deploymentKind`) for rows that already exist, derived from the
--      `format` + `provider` + `taskType` they were seeded with. Prisma's own
--      diff emits `ADD COLUMN ... NOT NULL` with no default, which Postgres
--      refuses on a populated table; the columns are therefore added WITH a
--      temporary default, backfilled, and only then locked down. The seed
--      (`06-ai-models.ts`) re-syncs every catalogue row afterwards, so the
--      mapping below only has to be RIGHT, not authoritative.
--   2. RETIRE the customer-tenant clones of the catalogue. Registry rows are
--      SYSTEM-only (R-1); `backfillCustomerTenantAiModels` is gone from the
--      seed, and every row outside `00000000-…` is soft-deleted here so an
--      existing environment converges on the same shape a fresh one seeds.
--      Soft-delete only — `AiRoutingPolicy.modelId` is `onDelete: Restrict`,
--      and nothing is ever hard-deleted in this platform.
--
-- Everything down to the "HAND-WRITTEN" banner is Prisma's diff, reshaped only
-- where the NOT NULL columns needed a default. Idempotent: every data step is
-- guarded, so re-running against a `db push`-managed database is safe.
-- ============================================================================

-- CreateEnum
CREATE TYPE "core"."AiModelAvailability" AS ENUM ('UNKNOWN', 'AVAILABLE', 'MISSING', 'PARTIAL', 'NOT_APPLICABLE');

-- AlterTable
ALTER TABLE "core"."AiModel" ADD COLUMN     "availability" "core"."AiModelAvailability" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "availabilityCheckedAt" TIMESTAMP(3),
ADD COLUMN     "availabilityDetail" JSONB,
ADD COLUMN     "baseModel" TEXT,
ADD COLUMN     "bucketPrefix" TEXT,
ADD COLUMN     "deploymentKind" "core"."AiDeploymentKind" NOT NULL DEFAULT 'SELF_HOSTED',
ADD COLUMN     "gated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hfRevision" TEXT,
ADD COLUMN     "isPlatformDefaultFor" "core"."AiTaskKind"[] DEFAULT ARRAY[]::"core"."AiTaskKind"[],
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "libraryName" TEXT NOT NULL DEFAULT 'transformers',
ADD COLUMN     "license" TEXT,
ADD COLUMN     "manifestDigest" TEXT,
ADD COLUMN     "primaryObject" TEXT,
ADD COLUMN     "servedBy" TEXT NOT NULL DEFAULT 'nlp',
ADD COLUMN     "wireModelId" TEXT;

-- ===========================================================================
-- HAND-WRITTEN — everything above this line is Prisma's (plus the three
-- temporary defaults).
-- ===========================================================================

-- 1a. `deploymentKind`: a cloud pseudo-format, or a cloud provider, is CLOUD.
UPDATE "core"."AiModel"
SET "deploymentKind" = 'CLOUD'
WHERE "deploymentKind" = 'SELF_HOSTED'
  AND (
    "format" IN ('AZURE_SPEECH', 'AZURE_FOUNDRY', 'CLOUD_API', 'SARVAM', 'OPENAI')
    OR "provider" IN ('azure', 'bedrock', 'sarvam', 'openai', 'anthropic', 'vertex')
  );

-- 1b. `libraryName`: the serving LIBRARY, derived from the artifact format
-- first (it names the runtime for every self-hosted engine) and the provider
-- second (cloud vendors + engine hosts). The SQL twin of the seed's rows.
UPDATE "core"."AiModel"
SET "libraryName" = (
  CASE
    WHEN "format" = 'FASTER_WHISPER' THEN 'faster-whisper'
    WHEN "format" = 'CTRANSLATE2' THEN 'ctranslate2'
    WHEN "format" = 'WHISPER_CPP' THEN 'whisper.cpp'
    WHEN "format" = 'PARAKEET_CPP' THEN 'parakeet.cpp'
    WHEN "format" IN ('ONNX', 'ONNX_OPTIMUM') THEN 'onnxruntime'
    WHEN "format" = 'NEMO' THEN 'nemo'
    WHEN "format" = 'AZURE_SPEECH' THEN 'azure-speech'
    WHEN "format" = 'AZURE_FOUNDRY' THEN 'azure-foundry'
    WHEN "format" = 'SARVAM' THEN 'sarvam'
    WHEN "format" = 'OPENAI' THEN 'openai'
    WHEN "provider" = 'lm-studio' THEN 'lm-studio'
    WHEN "provider" = 'ollama' THEN 'ollama'
    WHEN "provider" = 'vllm' THEN 'vllm'
    WHEN "provider" = 'llama-cpp' THEN 'llama.cpp'
    WHEN "provider" = 'azure' THEN 'azure-openai'
    WHEN "provider" = 'bedrock' THEN 'bedrock'
    WHEN "provider" = 'sarvam' THEN 'sarvam'
    WHEN "provider" = 'openai' THEN 'openai'
    WHEN "provider" = 'anthropic' THEN 'anthropic'
    WHEN "provider" = 'vertex' THEN 'vertex'
    WHEN "format" = 'GGUF' THEN 'llama.cpp'
    WHEN "format" = 'MLX' THEN 'lm-studio'
    WHEN "architecture" = 'gliner2' THEN 'gliner2'
    WHEN "architecture" = 'ecapa-tdnn' THEN 'speechbrain'
    WHEN "architecture" = 'wespeaker' THEN 'pyannote-audio'
    WHEN "architecture" = 'deepfilternet' THEN 'deepfilternet'
    WHEN "slug" = 'rnnoise' THEN 'pyrnnoise'
    WHEN "slug" = 'kokoro' THEN 'kokoro'
    WHEN "slug" LIKE 'indic-parler%' THEN 'parler-tts'
    WHEN "slug" = 'cadence-punctuation' THEN 'cadence-punctuation'
    ELSE 'transformers'
  END
)
WHERE "libraryName" = 'transformers';

-- 1c. `servedBy`: the workload that executes the model, by task shape. The
-- Cadence punctuation model is token-classification served IN-PROCESS by the
-- STT post-processing stage (D-4), so it is keyed by slug before the task rule.
UPDATE "core"."AiModel"
SET "servedBy" = (
  CASE
    WHEN "slug" = 'cadence-punctuation' THEN 'stt'
    WHEN "taskType" IN ('AUTOMATIC_SPEECH_RECOGNITION', 'VOICE_ACTIVITY_DETECTION', 'AUDIO_TO_AUDIO', 'AUDIO_CLASSIFICATION', 'SPEAKER_DIARIZATION', 'SPEAKER_EMBEDDING') THEN 'stt'
    WHEN "taskType" IN ('TEXT_TO_SPEECH', 'TEXT_TO_AUDIO') THEN 'tts'
    WHEN "provider" = 'lm-studio' THEN 'lmstudio'
    WHEN "taskType" IN ('TEXT_GENERATION', 'GUARDRAIL', 'IMAGE_TEXT_TO_TEXT', 'SUMMARIZATION', 'TRANSLATION') THEN 'text'
    ELSE 'nlp'
  END
)
WHERE "servedBy" = 'nlp';

-- 1d. `wireModelId` for the cloud rows — the id the vendor is invoked with,
-- which the seed carried in `sourceUri` under a vendor-scheme spelling.
UPDATE "core"."AiModel"
SET "wireModelId" = regexp_replace("sourceUri", '^[a-z-]+://', '')
WHERE "deploymentKind" = 'CLOUD'
  AND "wireModelId" IS NULL;

-- 1e. Cloud rows and weight-less libraries have nothing to inventory.
UPDATE "core"."AiModel"
SET "availability" = 'NOT_APPLICABLE'
WHERE "availability" = 'UNKNOWN'
  AND ("deploymentKind" = 'CLOUD' OR "libraryName" = 'pyrnnoise');

-- Lock the three backfilled columns down: the defaults were a migration
-- device, never a schema opinion (a default library would be a hardcoded
-- selection wearing a config costume).
ALTER TABLE "core"."AiModel" ALTER COLUMN "libraryName" DROP DEFAULT;
ALTER TABLE "core"."AiModel" ALTER COLUMN "servedBy" DROP DEFAULT;
ALTER TABLE "core"."AiModel" ALTER COLUMN "deploymentKind" DROP DEFAULT;

-- 2. Retire every customer-tenant clone of the catalogue (R-1). Matches by
-- tenant, not by slug: a tenant-registered row is a copy the platform no
-- longer recognises, whatever it was called. Soft-delete with the same stamps
-- the seed's retirement sweep writes (`resourceStatusUpdatedBy` = the
-- reserved system user), plus the OCC bump every status write carries.
UPDATE "core"."AiModel"
SET "resourceStatus" = 'DELETED',
    "resourceStatusUpdatedAt" = NOW(),
    "resourceStatusUpdatedBy" = '60000000-0000-0000-0000-000000000000',
    "_version" = "_version" + 1
WHERE "tenantId" <> '00000000-0000-0000-0000-000000000000'
  AND "resourceStatus" <> 'DELETED';
