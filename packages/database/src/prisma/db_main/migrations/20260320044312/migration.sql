-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateEnum
CREATE TYPE "core"."ApiKeyStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "core"."ApiKeyType" AS ENUM ('SDK', 'WEBHOOK', 'INTEGRATION', 'SERVICE_ACCOUNT');

-- CreateEnum
CREATE TYPE "core"."AuditAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE', 'ARCHIVE', 'LOGIN', 'LOGOUT');

-- CreateEnum
CREATE TYPE "core"."ResourceType" AS ENUM ('AuditLog', 'ApiKey', 'GlobalSetting', 'IntegrationPackage', 'IntegrationItem', 'Media', 'Notification', 'ResourceSubscription', 'Role', 'Permission', 'RolePermission', 'Tag', 'Tenant', 'UserRoleAssignment', 'User', 'UserSettings', 'UserProfile', 'UserMedia', 'Webhook', 'WebhookRunHistory', 'Session', 'SessionEvent', 'SessionSyncLog', 'Consultation', 'ContextItem', 'ContextItemVersion', 'AudioRecording', 'SummaryMeta', 'NamedEntity');

-- CreateEnum
CREATE TYPE "core"."ValueType" AS ENUM ('String', 'Integer', 'Float', 'Double', 'Decimal', 'Boolean', 'Json', 'Date', 'DateTime', 'Array', 'Uuid', 'Binary', 'Enum', 'Hstore', 'Inet', 'Citext', 'Interval');

-- CreateEnum
CREATE TYPE "core"."ResourceStatusType" AS ENUM ('ENABLED', 'DISABLED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "core"."ResourceSubscriptionType" AS ENUM ('CREATOR', 'SUBSCRIBER', 'MENTIONED');

-- CreateEnum
CREATE TYPE "core"."PermissionAction" AS ENUM ('MANAGE', 'CREATE', 'READ', 'LIST', 'UPDATE', 'DELETE', 'ARCHIVE', 'EXPORT');

-- CreateEnum
CREATE TYPE "core"."PolicyScope" AS ENUM ('GLOBAL', 'TENANT');

-- CreateEnum
CREATE TYPE "core"."ModelType" AS ENUM ('BASE_MODEL', 'FINETUNED_MODEL', 'QUANTIZED_MODEL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "core"."ModelCategory" AS ENUM ('MULTI_MODAL', 'VISION', 'NLP', 'AUDIO', 'TABULAR', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "core"."ModelTaskType" AS ENUM ('IMAGE_TEXT_TO_TEXT', 'VISUAL_QUESTION_ANSWERING', 'DOCUMENT_QUESTION_ANSWERING', 'VIDEO_TEXT_TO_TEXT', 'ANY_TO_ANY', 'DEPTH_ESTIMATION', 'IMAGE_CLASSIFICATION', 'OBJECT_DETECTION', 'IMAGE_SEGMENTATION', 'TEXT_TO_IMAGE', 'IMAGE_TO_TEXT', 'IMAGE_TO_IMAGE', 'IMAGE_TO_VIDEO', 'UNCONDITIONAL_IMAGE_GENERATION', 'VIDEO_CLASSIFICATION', 'TEXT_TO_VIDEO', 'ZERO_SHOT_IMAGE_CLASSIFICATION', 'MASK_GENERATION', 'ZERO_SHOT_OBJECT_DETECTION', 'TEXT_TO_3D', 'IMAGE_TO_3D', 'IMAGE_FEATURE_EXTRACTION', 'KEYPOINT_DETECTION', 'TEXT_CLASSIFICATION', 'TOKEN_CLASSIFICATION', 'TABLE_QUESTION_ANSWERING', 'QUESTION_ANSWERING', 'ZERO_SHOT_CLASSIFICATION', 'TRANSLATION', 'SUMMARIZATION', 'FEATURE_EXTRACTION', 'TEXT_GENERATION', 'TEXT2TEXT_GENERATION', 'FILL_MASK', 'SENTENCE_SIMILARITY', 'TEXT_TO_SPEECH', 'TEXT_TO_AUDIO', 'AUTOMATIC_SPEECH_RECOGNITION', 'AUDIO_TO_AUDIO', 'AUDIO_CLASSIFICATION', 'VOICE_ACTIVITY_DETECTION', 'TABULAR_CLASSIFICATION', 'TABULAR_REGRESSION', 'TIME_SERIES_FORECASTING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "core"."ModelJobStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "core"."WebhookRunStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."NotificationType" AS ENUM ('STANDARD', 'LINK', 'ACTION');

-- CreateEnum
CREATE TYPE "core"."TenantBucketType" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "core"."ContextItemType" AS ENUM ('AUDIO_RECORDING', 'WORKNOTE', 'RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY', 'NAMED_ENTITY', 'TRANSCRIPT', 'CASE_NOTE', 'ATTACHMENT');

-- CreateEnum
CREATE TYPE "core"."ContextItemSource" AS ENUM ('USER', 'AI', 'SYSTEM', 'TRANSCRIPTION');

-- CreateEnum
CREATE TYPE "core"."AiModelSource" AS ENUM ('HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL');

-- CreateEnum
CREATE TYPE "core"."AiModelFormat" AS ENUM ('SAFETENSOR', 'ONNX', 'NEMO', 'PYTORCH');

-- CreateEnum
CREATE TYPE "core"."AiModelDownloadStatus" AS ENUM ('NOT_DOWNLOADED', 'DOWNLOADING', 'DOWNLOADED', 'DOWNLOAD_FAILED');

-- CreateEnum
CREATE TYPE "core"."TranscriptionJobType" AS ENUM ('BATCH', 'STREAMING');

-- CreateEnum
CREATE TYPE "core"."TranscriptionJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD');

-- CreateEnum
CREATE TYPE "core"."FedlRoundStatus" AS ENUM ('PENDING', 'AGGREGATING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."PromptTemplateCategory" AS ENUM ('SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM');

-- CreateTable
CREATE TABLE "core"."ApiKey" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "keyName" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyChecksum" TEXT,
    "keyType" "core"."ApiKeyType" NOT NULL DEFAULT 'SDK',
    "keyStatus" "core"."ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "scopes" JSONB,
    "allowedIps" JSONB,
    "rateLimit" INTEGER,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "rotated_from_key_id" TEXT,
    "rotated_to_key_id" TEXT,
    "rotation_expires_at" TIMESTAMP(3),
    "original_creator_id" TEXT,
    "description" TEXT,
    "environment" TEXT,
    "userId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AuditLog" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "responsibleUserId" TEXT,
    "responsibleIp" TEXT,
    "resourceType" "core"."ResourceType" NOT NULL,
    "resourceId" TEXT,
    "resourceDatabase" TEXT,
    "correlationId" TEXT,
    "causationId" TEXT,
    "action" "core"."AuditAction" NOT NULL,
    "eventType" TEXT,
    "success" BOOLEAN,
    "data" JSONB NOT NULL,
    "previousData" JSONB NOT NULL,
    "metadata" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Consultation" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "patientId" TEXT NOT NULL,
    "appointmentDate" DATE NOT NULL,
    "doctorId" TEXT NOT NULL,
    "departmentId" TEXT,
    "parentConsultationId" TEXT,
    "metadata" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consultation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ContextItem" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "consultationId" TEXT NOT NULL,
    "type" "core"."ContextItemType" NOT NULL,
    "source" "core"."ContextItemSource" NOT NULL DEFAULT 'USER',
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT,
    "dnaWritingStyleId" TEXT,
    "qdrantSynced" BOOLEAN NOT NULL DEFAULT false,
    "qdrantSyncedAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AudioRecording" (
    "_metadata" JSONB,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "contextItemId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "duration" INTEGER,
    "format" TEXT,
    "sampleRate" INTEGER,
    "channels" INTEGER,
    "bitrate" INTEGER,
    "language" TEXT,
    "sequenceNumber" INTEGER NOT NULL DEFAULT 1,
    "recordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."SummaryMeta" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "contextItemId" TEXT NOT NULL,
    "aiModelId" TEXT,
    "aiModelVersion" TEXT,
    "promptVersion" TEXT,
    "processingTimeMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "caseNoteIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preSummaryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previousSummaryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SummaryMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."NamedEntity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "contextItemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "normalizedText" TEXT,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "confidence" DOUBLE PRECISION,
    "aiModelId" TEXT,
    "aiModelVersion" TEXT,
    "processingTimeMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NamedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ContextItemVersion" (
    "_metadata" JSONB,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "contextItemId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "content" TEXT,
    "contentDiff" TEXT,
    "changeReason" TEXT,
    "changeSummary" TEXT,
    "changedBy" TEXT,
    "changeSource" TEXT,
    "fieldChanges" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextItemVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Department" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "code" TEXT,
    "name" TEXT,
    "description" TEXT,
    "defaultSummaryTemplate" TEXT,
    "preSummaryPromptId" TEXT,
    "newPatientPromptId" TEXT,
    "revisitPromptId" TEXT,
    "promptConfig" JSONB,
    "parentDepartmentId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."DnaWritingStyleReport" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "doctorId" TEXT NOT NULL,
    "reportData" JSONB,
    "styleText" TEXT,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DnaWritingStyleReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."DnaWritingStyleVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "dnaReportId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "reportData" JSONB,
    "styleText" TEXT,
    "changeReason" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DnaWritingStyleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."DnaUsageRecord" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "doctorId" TEXT NOT NULL,
    "dnaReportId" TEXT NOT NULL,
    "dnaVersionNumber" INTEGER,
    "consultationId" TEXT,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DnaUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PromptUsageRecord" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "promptTemplateId" TEXT NOT NULL,
    "promptVersionNumber" INTEGER,
    "consultationId" TEXT,
    "doctorId" TEXT,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."clients" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "last_update" TIMESTAMP(3),
    "total_updates" INTEGER NOT NULL DEFAULT 0,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."rounds" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "round_id" INTEGER NOT NULL,
    "status" "core"."FedlRoundStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "updates_count" INTEGER NOT NULL DEFAULT 0,
    "min_updates_required" INTEGER NOT NULL DEFAULT 3,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."updates" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "update_id" INTEGER NOT NULL,
    "client_id" VARCHAR(64) NOT NULL,
    "round_id" INTEGER NOT NULL,
    "weight_hash" VARCHAR(64) NOT NULL,
    "num_samples" INTEGER NOT NULL DEFAULT 1,
    "metrics" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."model_versions" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "version_id" INTEGER NOT NULL,
    "weight_hash" VARCHAR(64) NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "mlflow_run_id" VARCHAR(64),
    "mlflow_version" VARCHAR(32),
    "mlflow_artifact_uri" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GlobalSetting" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "key" TEXT NOT NULL,
    "defaultValue" TEXT,
    "value" TEXT NOT NULL,
    "dataType" "core"."ValueType" NOT NULL DEFAULT 'String',
    "namespace" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "GlobalSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Media" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "name" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "bucketId" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Notification" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "title" TEXT NOT NULL,
    "messageText" TEXT,
    "messageRichText" TEXT,
    "messageContent" JSONB,
    "type" "core"."NotificationType" NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[],
    "resourceSubscriptionId" TEXT,
    "targetUserId" TEXT NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ResourceSubscription" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "resourceId" TEXT,
    "resourceTypeName" TEXT,
    "subscriptionType" "core"."ResourceSubscriptionType" NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "subscriptionMetadata" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[],

    CONSTRAINT "ResourceSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PromptTemplate" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "category" "core"."PromptTemplateCategory" NOT NULL,
    "variables" JSONB,
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
    "departmentId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PromptVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "promptTemplateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "variables" JSONB,
    "changeReason" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Role" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "externalName" TEXT,
    "externalId" TEXT,
    "isSystemRole" BOOLEAN NOT NULL DEFAULT false,
    "parentRoleId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Policy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "scope" "core"."PolicyScope" NOT NULL DEFAULT 'TENANT',
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."RolePolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "roleId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,

    CONSTRAINT "RolePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AsrPipeline" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "configYaml" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "AsrPipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiModel" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "category" "core"."ModelCategory" NOT NULL,
    "taskType" "core"."ModelTaskType" NOT NULL,
    "modelType" "core"."ModelType" NOT NULL,
    "source" "core"."AiModelSource" NOT NULL,
    "sourceUri" TEXT NOT NULL,
    "sourceRevision" TEXT,
    "format" "core"."AiModelFormat" NOT NULL,
    "memorySizeMb" INTEGER,
    "computeType" TEXT,
    "downloadStatus" "core"."AiModelDownloadStatus" NOT NULL DEFAULT 'NOT_DOWNLOADED',
    "localPath" TEXT,
    "downloadedAt" TIMESTAMP(3),
    "fileSizeMb" INTEGER,
    "checksum" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TranscriptionJob" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '50000000-0000-0000-0000-000000000000',
    "jobType" "core"."TranscriptionJobType" NOT NULL,
    "consultationId" TEXT,
    "contextItemId" TEXT,
    "mediaId" TEXT,
    "pipelineId" TEXT NOT NULL,
    "status" "core"."TranscriptionJobStatus" NOT NULL DEFAULT 'QUEUED',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "resultText" TEXT,
    "resultMetadata" JSONB,
    "errorMessage" TEXT,
    "errorCode" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "workerId" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Tag" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "resourceTypeName" TEXT,
    "resourceId" TEXT,
    "tagKey" TEXT,
    "tagValue" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "icon" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantBucket" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "bucketType" "core"."TenantBucketType" NOT NULL,
    "pathPattern" TEXT NOT NULL DEFAULT '{yyyy}/{MM}/{dd}/{user_name}',
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "TenantBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."StorageAccessKey" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "accessKeyId" TEXT NOT NULL,
    "secretAccessKey" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY['read']::TEXT[],
    "bucketIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageAccessKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Tenant" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserRoleAssignment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "scopeOverrides" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "UserRoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."User" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3),
    "externalId" TEXT,
    "isServiceAccount" BOOLEAN NOT NULL DEFAULT false,
    "secret1" TEXT,
    "secret1Expiry" TIMESTAMP(3),
    "secret2" TEXT,
    "secret2Expiry" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserSettings" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "dataType" "core"."ValueType" NOT NULL,
    "namespace" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserProfile" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "avatarId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserMedia" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "sharedAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,

    CONSTRAINT "UserMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Webhook" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT DEFAULT '50000000-0000-0000-0000-000000000000',
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "hashedSecret" TEXT,
    "resourceTypeName" TEXT NOT NULL,
    "resourceId" TEXT,
    "subscriptionMetadata" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."WebhookRunHistory" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "status" "core"."WebhookRunStatus" NOT NULL,
    "response" JSONB,
    "responeStatusCode" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "webhookId" TEXT NOT NULL,

    CONSTRAINT "WebhookRunHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."__User_Subscription" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "__User_Subscription_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "core"."_BucketAccessKeys" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BucketAccessKeys_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "core"."ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_keyHash_idx" ON "core"."ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_keyPrefix_idx" ON "core"."ApiKey"("keyPrefix");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_idx" ON "core"."ApiKey"("tenantId");

-- CreateIndex
CREATE INDEX "ApiKey_keyStatus_idx" ON "core"."ApiKey"("keyStatus");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "core"."ApiKey"("userId");

-- CreateIndex
CREATE INDEX "ApiKey_expiresAt_idx" ON "core"."ApiKey"("expiresAt");

-- CreateIndex
CREATE INDEX "ApiKey_lastUsedAt_idx" ON "core"."ApiKey"("lastUsedAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_idx" ON "core"."AuditLog"("tenantId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "core"."AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_responsibleUserId_idx" ON "core"."AuditLog"("responsibleUserId");

-- CreateIndex
CREATE INDEX "AuditLog_resource_idx" ON "core"."AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_action_resource_idx" ON "core"."AuditLog"("action", "resourceType");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "core"."AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_success_idx" ON "core"."AuditLog"("success");

-- CreateIndex
CREATE INDEX "AuditLog_correlationId_idx" ON "core"."AuditLog"("correlationId");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_createdAt_idx" ON "core"."AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_resource_time_idx" ON "core"."AuditLog"("tenantId", "resourceType", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_event_user_time_idx" ON "core"."AuditLog"("eventType", "responsibleUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_event_success_time_idx" ON "core"."AuditLog"("tenantId", "eventType", "success", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_tenant_action_time_idx" ON "core"."AuditLog"("tenantId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceId_idx" ON "core"."AuditLog"("resourceId");

-- CreateIndex
CREATE INDEX "Consultation_tenantId_idx" ON "core"."Consultation"("tenantId");

-- CreateIndex
CREATE INDEX "Consultation_patientId_idx" ON "core"."Consultation"("patientId");

-- CreateIndex
CREATE INDEX "Consultation_appointmentDate_idx" ON "core"."Consultation"("appointmentDate");

-- CreateIndex
CREATE INDEX "Consultation_doctorId_idx" ON "core"."Consultation"("doctorId");

-- CreateIndex
CREATE INDEX "Consultation_departmentId_idx" ON "core"."Consultation"("departmentId");

-- CreateIndex
CREATE INDEX "Consultation_parentId_idx" ON "core"."Consultation"("parentConsultationId");

-- CreateIndex
CREATE INDEX "Consultation_tenant_patient_date_idx" ON "core"."Consultation"("tenantId", "patientId", "appointmentDate");

-- CreateIndex
CREATE INDEX "ContextItem_tenantId_idx" ON "core"."ContextItem"("tenantId");

-- CreateIndex
CREATE INDEX "ContextItem_consultationId_idx" ON "core"."ContextItem"("consultationId");

-- CreateIndex
CREATE INDEX "ContextItem_type_idx" ON "core"."ContextItem"("type");

-- CreateIndex
CREATE INDEX "ContextItem_source_idx" ON "core"."ContextItem"("source");

-- CreateIndex
CREATE INDEX "ContextItem_createdAt_idx" ON "core"."ContextItem"("createdAt");

-- CreateIndex
CREATE INDEX "ContextItem_qdrantSynced_idx" ON "core"."ContextItem"("qdrantSynced");

-- CreateIndex
CREATE INDEX "ContextItem_dnaWritingStyleId_idx" ON "core"."ContextItem"("dnaWritingStyleId");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_type_idx" ON "core"."ContextItem"("consultationId", "type");

-- CreateIndex
CREATE INDEX "ContextItem_tenant_type_created_idx" ON "core"."ContextItem"("tenantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "AudioRecording_tenantId_idx" ON "core"."AudioRecording"("tenantId");

-- CreateIndex
CREATE INDEX "AudioRecording_contextItemId_idx" ON "core"."AudioRecording"("contextItemId");

-- CreateIndex
CREATE INDEX "AudioRecording_mediaId_idx" ON "core"."AudioRecording"("mediaId");

-- CreateIndex
CREATE INDEX "AudioRecording_sequence_idx" ON "core"."AudioRecording"("contextItemId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "SummaryMeta_contextItemId_key" ON "core"."SummaryMeta"("contextItemId");

-- CreateIndex
CREATE INDEX "SummaryMeta_tenantId_idx" ON "core"."SummaryMeta"("tenantId");

-- CreateIndex
CREATE INDEX "SummaryMeta_contextItemId_idx" ON "core"."SummaryMeta"("contextItemId");

-- CreateIndex
CREATE INDEX "SummaryMeta_aiModelId_idx" ON "core"."SummaryMeta"("aiModelId");

-- CreateIndex
CREATE INDEX "SummaryMeta_generatedAt_idx" ON "core"."SummaryMeta"("generatedAt");

-- CreateIndex
CREATE INDEX "NamedEntity_tenantId_idx" ON "core"."NamedEntity"("tenantId");

-- CreateIndex
CREATE INDEX "NamedEntity_contextItemId_idx" ON "core"."NamedEntity"("contextItemId");

-- CreateIndex
CREATE INDEX "NamedEntity_className_idx" ON "core"."NamedEntity"("className");

-- CreateIndex
CREATE INDEX "NamedEntity_text_idx" ON "core"."NamedEntity"("text");

-- CreateIndex
CREATE INDEX "NamedEntity_confidence_idx" ON "core"."NamedEntity"("confidence");

-- CreateIndex
CREATE INDEX "NamedEntity_item_class_idx" ON "core"."NamedEntity"("contextItemId", "className");

-- CreateIndex
CREATE INDEX "ContextItemVersion_tenantId_idx" ON "core"."ContextItemVersion"("tenantId");

-- CreateIndex
CREATE INDEX "ContextItemVersion_contextItemId_idx" ON "core"."ContextItemVersion"("contextItemId");

-- CreateIndex
CREATE INDEX "ContextItemVersion_versionNumber_idx" ON "core"."ContextItemVersion"("versionNumber");

-- CreateIndex
CREATE INDEX "ContextItemVersion_createdAt_idx" ON "core"."ContextItemVersion"("createdAt");

-- CreateIndex
CREATE INDEX "ContextItemVersion_changedBy_idx" ON "core"."ContextItemVersion"("changedBy");

-- CreateIndex
CREATE INDEX "ContextItemVersion_item_version_idx" ON "core"."ContextItemVersion"("contextItemId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ContextItemVersion_contextItemId_versionNumber_key" ON "core"."ContextItemVersion"("contextItemId", "versionNumber");

-- CreateIndex
CREATE INDEX "Department_tenantId_idx" ON "core"."Department"("tenantId");

-- CreateIndex
CREATE INDEX "Department_parentDepartmentId_idx" ON "core"."Department"("parentDepartmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_tenantId_code_key" ON "core"."Department"("tenantId", "code");

-- CreateIndex
CREATE INDEX "DnaWritingStyleReport_tenantId_idx" ON "core"."DnaWritingStyleReport"("tenantId");

-- CreateIndex
CREATE INDEX "DnaWritingStyleReport_doctorId_idx" ON "core"."DnaWritingStyleReport"("doctorId");

-- CreateIndex
CREATE INDEX "DnaWritingStyleReport_doctor_latest_idx" ON "core"."DnaWritingStyleReport"("doctorId", "isLatest");

-- CreateIndex
CREATE INDEX "DnaWritingStyleVersion_dnaReportId_idx" ON "core"."DnaWritingStyleVersion"("dnaReportId");

-- CreateIndex
CREATE UNIQUE INDEX "DnaWritingStyleVersion_dnaReportId_versionNumber_key" ON "core"."DnaWritingStyleVersion"("dnaReportId", "versionNumber");

-- CreateIndex
CREATE INDEX "DnaUsageRecord_tenantId_idx" ON "core"."DnaUsageRecord"("tenantId");

-- CreateIndex
CREATE INDEX "DnaUsageRecord_doctorId_idx" ON "core"."DnaUsageRecord"("doctorId");

-- CreateIndex
CREATE INDEX "DnaUsageRecord_dnaReportId_idx" ON "core"."DnaUsageRecord"("dnaReportId");

-- CreateIndex
CREATE INDEX "DnaUsageRecord_consultationId_idx" ON "core"."DnaUsageRecord"("consultationId");

-- CreateIndex
CREATE INDEX "PromptUsageRecord_tenantId_idx" ON "core"."PromptUsageRecord"("tenantId");

-- CreateIndex
CREATE INDEX "PromptUsageRecord_promptTemplateId_idx" ON "core"."PromptUsageRecord"("promptTemplateId");

-- CreateIndex
CREATE INDEX "PromptUsageRecord_consultationId_idx" ON "core"."PromptUsageRecord"("consultationId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_client_id_key" ON "core"."clients"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "rounds_round_id_key" ON "core"."rounds"("round_id");

-- CreateIndex
CREATE INDEX "FedlRound_status_idx" ON "core"."rounds"("status");

-- CreateIndex
CREATE INDEX "FedlRound_startedAt_idx" ON "core"."rounds"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "updates_update_id_key" ON "core"."updates"("update_id");

-- CreateIndex
CREATE INDEX "FedlUpdate_clientId_idx" ON "core"."updates"("client_id");

-- CreateIndex
CREATE INDEX "FedlUpdate_roundId_idx" ON "core"."updates"("round_id");

-- CreateIndex
CREATE UNIQUE INDEX "updates_client_id_round_id_key" ON "core"."updates"("client_id", "round_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_versions_version_id_key" ON "core"."model_versions"("version_id");

-- CreateIndex
CREATE INDEX "FedlModelVersion_isCurrent_idx" ON "core"."model_versions"("is_current");

-- CreateIndex
CREATE INDEX "GlobalSetting_tenantId_idx" ON "core"."GlobalSetting"("tenantId");

-- CreateIndex
CREATE INDEX "GlobalSetting_tenantId_key_idx" ON "core"."GlobalSetting"("tenantId", "name", "key");

-- CreateIndex
CREATE UNIQUE INDEX "GlobalSetting_tenantId_name_key_key" ON "core"."GlobalSetting"("tenantId", "name", "key");

-- CreateIndex
CREATE INDEX "Media_tenantId_index" ON "core"."Media"("tenantId");

-- CreateIndex
CREATE INDEX "Media_bucketId_index" ON "core"."Media"("bucketId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_index" ON "core"."Notification"("tenantId");

-- CreateIndex
CREATE INDEX "ResourceSubscription_tenantId_index" ON "core"."ResourceSubscription"("tenantId");

-- CreateIndex
CREATE INDEX "PromptTemplate_tenantId_idx" ON "core"."PromptTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "PromptTemplate_departmentId_idx" ON "core"."PromptTemplate"("departmentId");

-- CreateIndex
CREATE INDEX "PromptTemplate_category_idx" ON "core"."PromptTemplate"("category");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_tenantId_name_key" ON "core"."PromptTemplate"("tenantId", "name");

-- CreateIndex
CREATE INDEX "PromptVersion_promptTemplateId_idx" ON "core"."PromptVersion"("promptTemplateId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_promptTemplateId_versionNumber_key" ON "core"."PromptVersion"("promptTemplateId", "versionNumber");

-- CreateIndex
CREATE INDEX "Role_parentRoleId_idx" ON "core"."Role"("parentRoleId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "core"."Role"("name");

-- CreateIndex
CREATE INDEX "Policy_scope_idx" ON "core"."Policy"("scope");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_name_key" ON "core"."Policy"("name");

-- CreateIndex
CREATE INDEX "RolePolicy_roleId_idx" ON "core"."RolePolicy"("roleId");

-- CreateIndex
CREATE INDEX "RolePolicy_policyId_idx" ON "core"."RolePolicy"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePolicy_roleId_policyId_key" ON "core"."RolePolicy"("roleId", "policyId");

-- CreateIndex
CREATE INDEX "AsrPipeline_tenantId_idx" ON "core"."AsrPipeline"("tenantId");

-- CreateIndex
CREATE INDEX "AsrPipeline_status_idx" ON "core"."AsrPipeline"("resourceStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AsrPipeline_tenantId_slug_key" ON "core"."AsrPipeline"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "AiModel_tenantId_idx" ON "core"."AiModel"("tenantId");

-- CreateIndex
CREATE INDEX "AiModel_category_idx" ON "core"."AiModel"("category");

-- CreateIndex
CREATE INDEX "AiModel_taskType_idx" ON "core"."AiModel"("taskType");

-- CreateIndex
CREATE INDEX "AiModel_source_idx" ON "core"."AiModel"("source");

-- CreateIndex
CREATE INDEX "AiModel_format_idx" ON "core"."AiModel"("format");

-- CreateIndex
CREATE INDEX "AiModel_status_idx" ON "core"."AiModel"("resourceStatus");

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_tenantId_slug_key" ON "core"."AiModel"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "TranscriptionJob_tenantId_idx" ON "core"."TranscriptionJob"("tenantId");

-- CreateIndex
CREATE INDEX "TranscriptionJob_status_idx" ON "core"."TranscriptionJob"("status");

-- CreateIndex
CREATE INDEX "TranscriptionJob_pipelineId_idx" ON "core"."TranscriptionJob"("pipelineId");

-- CreateIndex
CREATE INDEX "TranscriptionJob_consultationId_idx" ON "core"."TranscriptionJob"("consultationId");

-- CreateIndex
CREATE INDEX "TranscriptionJob_createdAt_idx" ON "core"."TranscriptionJob"("createdAt");

-- CreateIndex
CREATE INDEX "TranscriptionJob_tenant_status_created_idx" ON "core"."TranscriptionJob"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TenantBucket_tenantId_idx" ON "core"."TenantBucket"("tenantId");

-- CreateIndex
CREATE INDEX "TenantBucket_bucketType_idx" ON "core"."TenantBucket"("bucketType");

-- CreateIndex
CREATE INDEX "TenantBucket_tenant_type_idx" ON "core"."TenantBucket"("tenantId", "bucketType");

-- CreateIndex
CREATE UNIQUE INDEX "TenantBucket_tenantId_slug_key" ON "core"."TenantBucket"("tenantId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "TenantBucket_name_key" ON "core"."TenantBucket"("name");

-- CreateIndex
CREATE UNIQUE INDEX "StorageAccessKey_accessKeyId_key" ON "core"."StorageAccessKey"("accessKeyId");

-- CreateIndex
CREATE INDEX "StorageAccessKey_tenantId_idx" ON "core"."StorageAccessKey"("tenantId");

-- CreateIndex
CREATE INDEX "StorageAccessKey_accessKeyId_idx" ON "core"."StorageAccessKey"("accessKeyId");

-- CreateIndex
CREATE INDEX "StorageAccessKey_expiresAt_idx" ON "core"."StorageAccessKey"("expiresAt");

-- CreateIndex
CREATE INDEX "StorageAccessKey_tenant_status_idx" ON "core"."StorageAccessKey"("tenantId", "resourceStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_key_key" ON "core"."Tenant"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_name_key_key" ON "core"."Tenant"("name", "key");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_tenantId_idx" ON "core"."UserRoleAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_userId_idx" ON "core"."UserRoleAssignment"("userId");

-- CreateIndex
CREATE INDEX "UserRoleAssignment_roleId_idx" ON "core"."UserRoleAssignment"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserRoleAssignment_userId_roleId_tenantId_key" ON "core"."UserRoleAssignment"("userId", "roleId", "tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "core"."User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_externalId_key" ON "core"."User"("externalId");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "core"."User"("username");

-- CreateIndex
CREATE INDEX "UserSettings_userId_idx" ON "core"."UserSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "core"."UserProfile"("userId");

-- CreateIndex
CREATE INDEX "UserProfile_email_idx" ON "core"."UserProfile"("email");

-- CreateIndex
CREATE INDEX "UserMedia_userId_index" ON "core"."UserMedia"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserMedia_userId_mediaId_key" ON "core"."UserMedia"("userId", "mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_name_key" ON "core"."Webhook"("name");

-- CreateIndex
CREATE INDEX "Webhook_tenantId_index" ON "core"."Webhook"("tenantId");

-- CreateIndex
CREATE INDEX "__User_Subscription_B_index" ON "core"."__User_Subscription"("B");

-- CreateIndex
CREATE INDEX "_BucketAccessKeys_B_index" ON "core"."_BucketAccessKeys"("B");

-- AddForeignKey
ALTER TABLE "core"."ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Consultation" ADD CONSTRAINT "Consultation_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "core"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Consultation" ADD CONSTRAINT "Consultation_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Consultation" ADD CONSTRAINT "Consultation_parentConsultationId_fkey" FOREIGN KEY ("parentConsultationId") REFERENCES "core"."Consultation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ContextItem" ADD CONSTRAINT "ContextItem_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."AudioRecording" ADD CONSTRAINT "AudioRecording_contextItemId_fkey" FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."SummaryMeta" ADD CONSTRAINT "SummaryMeta_contextItemId_fkey" FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."NamedEntity" ADD CONSTRAINT "NamedEntity_contextItemId_fkey" FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ContextItemVersion" ADD CONSTRAINT "ContextItemVersion_contextItemId_fkey" FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Department" ADD CONSTRAINT "Department_parentDepartmentId_fkey" FOREIGN KEY ("parentDepartmentId") REFERENCES "core"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."DnaWritingStyleReport" ADD CONSTRAINT "DnaWritingStyleReport_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "core"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."DnaWritingStyleVersion" ADD CONSTRAINT "DnaWritingStyleVersion_dnaReportId_fkey" FOREIGN KEY ("dnaReportId") REFERENCES "core"."DnaWritingStyleReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."updates" ADD CONSTRAINT "updates_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "core"."clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."updates" ADD CONSTRAINT "updates_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "core"."rounds"("round_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Media" ADD CONSTRAINT "Media_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "core"."TenantBucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Notification" ADD CONSTRAINT "Notification_resourceSubscriptionId_fkey" FOREIGN KEY ("resourceSubscriptionId") REFERENCES "core"."ResourceSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Notification" ADD CONSTRAINT "Notification_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "core"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."PromptTemplate" ADD CONSTRAINT "PromptTemplate_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."PromptVersion" ADD CONSTRAINT "PromptVersion_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "core"."PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Role" ADD CONSTRAINT "Role_parentRoleId_fkey" FOREIGN KEY ("parentRoleId") REFERENCES "core"."Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."RolePolicy" ADD CONSTRAINT "RolePolicy_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "core"."Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."RolePolicy" ADD CONSTRAINT "RolePolicy_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "core"."Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."TranscriptionJob" ADD CONSTRAINT "TranscriptionJob_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "core"."AsrPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserRoleAssignment" ADD CONSTRAINT "UserRoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "core"."Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserSettings" ADD CONSTRAINT "UserSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserProfile" ADD CONSTRAINT "UserProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserMedia" ADD CONSTRAINT "UserMedia_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserMedia" ADD CONSTRAINT "UserMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "core"."Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."WebhookRunHistory" ADD CONSTRAINT "WebhookRunHistory_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "core"."Webhook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."__User_Subscription" ADD CONSTRAINT "__User_Subscription_A_fkey" FOREIGN KEY ("A") REFERENCES "core"."ResourceSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."__User_Subscription" ADD CONSTRAINT "__User_Subscription_B_fkey" FOREIGN KEY ("B") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."_BucketAccessKeys" ADD CONSTRAINT "_BucketAccessKeys_A_fkey" FOREIGN KEY ("A") REFERENCES "core"."StorageAccessKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."_BucketAccessKeys" ADD CONSTRAINT "_BucketAccessKeys_B_fkey" FOREIGN KEY ("B") REFERENCES "core"."TenantBucket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
