-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "core";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";

-- CreateEnum
CREATE TYPE "core"."AgentSessionKind" AS ENUM ('LIVE_DOC', 'HARNESS_DOC', 'SUMMARY_JOB', 'EVAL_RUN');

-- CreateEnum
CREATE TYPE "core"."AgentStepType" AS ENUM ('LLM_CALL', 'TOOL_CALL', 'SENSOR', 'RETRIEVAL', 'GUARDRAIL', 'THINKING', 'SIGNAL', 'GATE', 'PHASE');

-- CreateEnum
CREATE TYPE "core"."AgentStepStatus" AS ENUM ('STARTED', 'OK', 'ERROR', 'SKIPPED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "core"."ApiKeyStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "core"."ApiKeyType" AS ENUM ('SDK', 'WEBHOOK', 'INTEGRATION', 'SERVICE_ACCOUNT');

-- CreateEnum
CREATE TYPE "core"."AuditAction" AS ENUM ('CREATE', 'READ', 'UPDATE', 'DELETE', 'ARCHIVE', 'LOGIN', 'LOGOUT', 'IMPERSONATED_ACTION');

-- CreateEnum
CREATE TYPE "core"."ResourceType" AS ENUM ('AuditLog', 'ApiKey', 'Department', 'GlobalSetting', 'IntegrationPackage', 'IntegrationItem', 'Media', 'Notification', 'ResourceSubscription', 'Role', 'Permission', 'RolePermission', 'Tag', 'Tenant', 'UserRoleAssignment', 'User', 'UserSettings', 'UserProfile', 'UserMedia', 'Webhook', 'WebhookRunHistory', 'Consultation', 'ContextItem', 'ContextItemVersion', 'AudioRecording', 'SummaryMeta', 'NamedEntity', 'AsrPipeline', 'AiModel', 'TranscriptionJob', 'PromptTemplate', 'DnaWritingStyleReport', 'TenantBucket', 'StorageAccessKey', 'TenantStorageConfig', 'Highlight', 'AsrPipelineVersion', 'UserVoiceProfile', 'UserDepartment', 'TenantFrontendConfig', 'TenantTtsConfig', 'TenantIdentityProvider', 'FederatedIdentity', 'AiTaskDefault', 'McpServer', 'AiProviderConnection', 'AiRuntimeProfile', 'GateEditExemplar', 'DepartmentAgent', 'EvalRun', 'TenantSttConfig', 'TenantSttProviderCredential', 'TenantAllowedOrigin', 'AiPriceBook', 'BillingInvoice', 'BillingAdjustment', 'ServiceRelease', 'ServiceInstance', 'ChangelogEntry', 'UserChangelogAcknowledgement', 'ConsultationContextSchema', 'AgentPromotion', 'WorkflowDefinition', 'ConsentGrant', 'WorkflowTestFixture', 'TenantNlpTaskInstructions', 'KnowledgeDocument');

-- CreateEnum
CREATE TYPE "core"."UsageMeterMetric" AS ENUM ('CONSULTATIONS', 'TRANSCRIPTION_MINUTES', 'SUMMARIES', 'STT_SESSION_SECONDS', 'LLM_TOKENS', 'TTS_CHARACTERS', 'NLP_TEXT_UNITS', 'GUARDRAIL_CALLS', 'EMBEDDING_TOKENS', 'WORKFLOW_INVOCATIONS');

-- CreateEnum
CREATE TYPE "core"."ValueType" AS ENUM ('String', 'Integer', 'Float', 'Double', 'Decimal', 'Boolean', 'Json', 'Date', 'DateTime', 'Array', 'Uuid', 'Binary', 'Enum', 'Hstore', 'Inet', 'Citext', 'Interval');

-- CreateEnum
CREATE TYPE "core"."ResourceStatusType" AS ENUM ('ENABLED', 'DISABLED', 'SUSPENDED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "core"."TenantPlan" AS ENUM ('ENTERPRISE', 'PRO', 'TRIAL', 'STARTER');

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
CREATE TYPE "core"."ModelTaskType" AS ENUM ('IMAGE_TEXT_TO_TEXT', 'VISUAL_QUESTION_ANSWERING', 'DOCUMENT_QUESTION_ANSWERING', 'VIDEO_TEXT_TO_TEXT', 'ANY_TO_ANY', 'DEPTH_ESTIMATION', 'IMAGE_CLASSIFICATION', 'OBJECT_DETECTION', 'IMAGE_SEGMENTATION', 'TEXT_TO_IMAGE', 'IMAGE_TO_TEXT', 'IMAGE_TO_IMAGE', 'IMAGE_TO_VIDEO', 'UNCONDITIONAL_IMAGE_GENERATION', 'VIDEO_CLASSIFICATION', 'TEXT_TO_VIDEO', 'ZERO_SHOT_IMAGE_CLASSIFICATION', 'MASK_GENERATION', 'ZERO_SHOT_OBJECT_DETECTION', 'TEXT_TO_3D', 'IMAGE_TO_3D', 'IMAGE_FEATURE_EXTRACTION', 'KEYPOINT_DETECTION', 'TEXT_CLASSIFICATION', 'TOKEN_CLASSIFICATION', 'TABLE_QUESTION_ANSWERING', 'QUESTION_ANSWERING', 'ZERO_SHOT_CLASSIFICATION', 'TRANSLATION', 'SUMMARIZATION', 'FEATURE_EXTRACTION', 'TEXT_GENERATION', 'TEXT2TEXT_GENERATION', 'FILL_MASK', 'SENTENCE_SIMILARITY', 'GUARDRAIL', 'TEXT_TO_SPEECH', 'TEXT_TO_AUDIO', 'AUTOMATIC_SPEECH_RECOGNITION', 'AUDIO_TO_AUDIO', 'AUDIO_CLASSIFICATION', 'VOICE_ACTIVITY_DETECTION', 'SPEAKER_DIARIZATION', 'SPEAKER_EMBEDDING', 'TABULAR_CLASSIFICATION', 'TABULAR_REGRESSION', 'TIME_SERIES_FORECASTING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "core"."ModelJobStatus" AS ENUM ('SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "core"."WebhookRunStatus" AS ENUM ('SUCCESS', 'FAILED', 'DEAD_LETTERED');

-- CreateEnum
CREATE TYPE "core"."NotificationType" AS ENUM ('STANDARD', 'LINK', 'ACTION');

-- CreateEnum
CREATE TYPE "core"."TenantBucketType" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "core"."TenantBucketPurpose" AS ENUM ('AUDIO', 'ATTACHMENTS', 'MISC', 'CUSTOM');

-- CreateEnum
CREATE TYPE "core"."StorageProviderType" AS ENUM ('MINIO', 'AWS_S3', 'AZURE_BLOB');

-- CreateEnum
CREATE TYPE "core"."StorageTopologyType" AS ENUM ('SHARED', 'DEDICATED');

-- CreateEnum
CREATE TYPE "core"."ContextItemType" AS ENUM ('AUDIO_RECORDING', 'WORKNOTE', 'RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY', 'NAMED_ENTITY', 'TRANSCRIPT', 'CASE_NOTE', 'ATTACHMENT', 'SIGNED_NOTE', 'STRUCTURED');

-- CreateEnum
CREATE TYPE "core"."ConsultationContextSchemaScope" AS ENUM ('TENANT', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "core"."ConsultationContextSchemaStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'APPROVED');

-- CreateEnum
CREATE TYPE "core"."WorkflowDefinitionStatus" AS ENUM ('DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "core"."ConsultationStatus" AS ENUM ('OPEN', 'RECORDING', 'DRAFT_PENDING_SENSORS', 'PENDING_REVIEW', 'SIGNED', 'CLOSED', 'REOPENED', 'PRIMED', 'DRAINING', 'TIMED_OUT', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE');

-- CreateEnum
CREATE TYPE "core"."ContextItemSource" AS ENUM ('USER', 'AI', 'SYSTEM', 'TRANSCRIPTION');

-- CreateEnum
CREATE TYPE "core"."HighlightTargetKind" AS ENUM ('TRANSCRIPT', 'CASE_NOTE', 'WORKNOTE', 'SUMMARY');

-- CreateEnum
CREATE TYPE "core"."AiModelSource" AS ENUM ('HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "core"."AiModelFormat" AS ENUM ('SAFETENSOR', 'ONNX', 'NEMO', 'PYTORCH', 'CTRANSLATE2', 'FASTER_WHISPER', 'MLX', 'GGUF', 'ONNX_OPTIMUM', 'AZURE_SPEECH', 'AZURE_FOUNDRY', 'PARAKEET_CPP', 'CLOUD_API', 'WHISPER_CPP', 'SARVAM', 'OPENAI');

-- CreateEnum
CREATE TYPE "core"."AiModelDownloadStatus" AS ENUM ('NOT_DOWNLOADED', 'DOWNLOADING', 'DOWNLOADED', 'DOWNLOAD_FAILED');

-- CreateEnum
CREATE TYPE "core"."TranscriptionJobType" AS ENUM ('BATCH', 'STREAMING');

-- CreateEnum
CREATE TYPE "core"."TranscriptionJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD');

-- CreateEnum
CREATE TYPE "core"."TranscriptionMode" AS ENUM ('LOCAL', 'BACKEND');

-- CreateEnum
CREATE TYPE "core"."CaptureMode" AS ENUM ('RAW_AND_PROCESSED', 'RAW_ONLY', 'PROCESSED_ONLY', 'NONE');

-- CreateEnum
CREATE TYPE "core"."PipelinePolicyScope" AS ENUM ('TENANT', 'DEPARTMENT', 'DOCTOR');

-- CreateEnum
CREATE TYPE "core"."IdpProtocol" AS ENUM ('OIDC', 'SAML');

-- CreateEnum
CREATE TYPE "core"."DepartmentAgentDnaPolicy" AS ENUM ('INHERIT', 'DISABLED');

-- CreateEnum
CREATE TYPE "core"."DepartmentAgentRole" AS ENUM ('PRIMARY', 'SPECIALIST');

-- CreateEnum
CREATE TYPE "core"."ExemplarCurationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "core"."IdpStatus" AS ENUM ('DRAFT', 'ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "core"."AiCapability" AS ENUM ('STT', 'LLM', 'NLP', 'TTS', 'EMBEDDING');

-- CreateEnum
CREATE TYPE "core"."AiUsageUnit" AS ENUM ('INPUT_TOKEN', 'OUTPUT_TOKEN', 'CACHE_READ_TOKEN', 'CACHE_WRITE_TOKEN', 'REASONING_TOKEN', 'AUDIO_SECOND', 'SESSION_SECOND', 'CHARACTER', 'TEXT_UNIT', 'REQUEST', 'GPU_SECOND');

-- CreateEnum
CREATE TYPE "core"."AiDeploymentKind" AS ENUM ('SELF_HOSTED', 'CLOUD', 'BYOK');

-- CreateEnum
CREATE TYPE "core"."AiCostBasis" AS ENUM ('INTERNAL', 'BYOK_NOTIONAL');

-- CreateEnum
CREATE TYPE "core"."AiPriceBookPlane" AS ENUM ('COST', 'SELL');

-- CreateEnum
CREATE TYPE "core"."AiPriceRowKind" AS ENUM ('USAGE_UNIT', 'PLAN_FEE');

-- CreateEnum
CREATE TYPE "core"."AiUsageOutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."BillingInvoiceStatus" AS ENUM ('DRAFT', 'FINALIZED', 'VOID');

-- CreateEnum
CREATE TYPE "core"."BillingLineKind" AS ENUM ('PLAN_FEE', 'OVERAGE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "core"."ChangelogSeverity" AS ENUM ('INFO', 'IMPORTANT', 'BREAKING');

-- CreateEnum
CREATE TYPE "core"."ChangelogAudience" AS ENUM ('ALL', 'GLOBAL_ADMIN', 'TENANT_ADMIN');

-- CreateEnum
CREATE TYPE "core"."ChangelogPublishStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "core"."ConsentPurpose" AS ENUM ('AI_DOCUMENTATION', 'HISTORY_RETRIEVAL', 'EXTERNAL_TOOL_LOOKUP', 'STYLE_LEARNING', 'QUALITY_REVIEW');

-- CreateEnum
CREATE TYPE "core"."ConsentGrantMethod" AS ENUM ('VERBAL_ATTESTED', 'WRITTEN', 'PORTAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "core"."FedlRoundStatus" AS ENUM ('PENDING', 'AGGREGATING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "core"."HarnessAuditAction" AS ENUM ('GENERATE', 'SENSOR_RUN', 'GATE_DECISION', 'ATTEST', 'CONSENT_GIVEN', 'CONSENT_WITHDRAWN', 'BREACH_REPORTED', 'REDUCED_ASSURANCE', 'SAFETY_OVERRIDE', 'SIGNED_BEFORE_ASSURANCE', 'POST_SIGN_FLAG', 'GATE_ESCALATED', 'GATE_ABANDONED', 'SESSION_PRIMED', 'SESSION_TIMED_OUT', 'SESSION_REOPENED', 'SESSION_CLOSED_COMPLETE', 'SESSION_CLOSED_INCOMPLETE');

-- CreateEnum
CREATE TYPE "core"."KnowledgeDocumentStatus" AS ENUM ('DRAFT', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "core"."PromptTemplateCategory" AS ENUM ('SYSTEM', 'SUMMARY', 'DNA_ANALYSIS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "core"."PromptTemplateScope" AS ENUM ('TENANT_DEFAULT', 'DEPARTMENT_DEFAULT', 'USER_PERSONAL');

-- CreateEnum
CREATE TYPE "core"."PromptTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'APPROVED');

-- CreateEnum
CREATE TYPE "core"."WorkflowRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "core"."AgentTrajectoryStep" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "sessionKind" "core"."AgentSessionKind" NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "seq" INTEGER NOT NULL,
    "stepType" "core"."AgentStepType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "core"."AgentStepStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "stats" JSONB,
    "payloadRef" JSONB,
    "errorCode" TEXT,
    "correlationId" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTrajectoryStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiProviderConnection" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "service" TEXT NOT NULL DEFAULT 'llm',
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "region" TEXT,
    "apiVersion" TEXT,
    "deploymentName" TEXT,
    "encryptedApiKey" BYTEA,
    "keyVersion" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "extraJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiRuntimeProfile" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL DEFAULT '',
    "temperature" DOUBLE PRECISION,
    "topP" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "contextLength" INTEGER,
    "maxConcurrent" INTEGER,
    "tpmLimit" INTEGER,
    "rpmLimit" INTEGER,
    "timeoutS" INTEGER,
    "keepAliveSeconds" INTEGER,
    "extraJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRuntimeProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiTaskDefault" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "modelSlug" TEXT NOT NULL,
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiTaskDefault_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ApiKey" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
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
    "encryptedData" BYTEA,
    "encryptedPreviousData" BYTEA,
    "dekWrapped" TEXT,
    "dekKeyVersion" INTEGER,
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
CREATE TABLE "core"."BillingInvoice" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "core"."BillingInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotalMicros" BIGINT NOT NULL DEFAULT 0,
    "totalMicros" BIGINT NOT NULL DEFAULT 0,
    "finalizedAt" TIMESTAMP(3),
    "finalizedBy" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."BillingInvoiceLine" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "kind" "core"."BillingLineKind" NOT NULL,
    "capability" "core"."AiCapability",
    "unit" "core"."AiUsageUnit",
    "quantity" DECIMAL(38,6),
    "includedAllowance" DECIMAL(38,6),
    "overageQuantity" DECIMAL(38,6),
    "unitPriceMicros" BIGINT,
    "amountMicros" BIGINT NOT NULL,
    "description" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."BillingAdjustment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "amountMicros" BIGINT NOT NULL,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsentGrant" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalPatientId" TEXT NOT NULL,
    "purpose" "core"."ConsentPurpose" NOT NULL,
    "scope" JSONB,
    "grantedAt" TIMESTAMP(3) NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "grantMethod" "core"."ConsentGrantMethod" NOT NULL,
    "evidenceRef" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationContextSchema" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "core"."ConsultationContextSchemaScope" NOT NULL DEFAULT 'TENANT',
    "departmentId" TEXT,
    "status" "core"."ConsultationContextSchemaStatus" NOT NULL DEFAULT 'DRAFT',
    "pinnedVersionNumber" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sourceTemplateSlug" TEXT,
    "templateLocked" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationContextSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ConsultationContextSchemaVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "schemaId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "changeReason" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationContextSchemaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Consultation" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentDate" DATE NOT NULL,
    "doctorId" TEXT NOT NULL,
    "departmentId" TEXT,
    "parentConsultationId" TEXT,
    "metadata" JSONB,
    "status" "core"."ConsultationStatus" NOT NULL DEFAULT 'OPEN',
    "degradedReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "type" "core"."ContextItemType" NOT NULL,
    "source" "core"."ContextItemSource" NOT NULL DEFAULT 'USER',
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
    "encryptedContent" BYTEA,
    "contentKeyVersion" INTEGER,
    "mediaId" TEXT,
    "dnaWritingStyleId" TEXT,
    "kindKey" TEXT,
    "contextSchemaVersionId" TEXT,
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
    "tenantId" TEXT NOT NULL,
    "contextItemId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "rawMediaId" TEXT,
    "processedMediaId" TEXT,
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
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextItemId" TEXT NOT NULL,
    "aiModelId" TEXT,
    "aiModelVersion" TEXT,
    "promptVersion" TEXT,
    "processingTimeMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "stopReason" TEXT,
    "ttftMs" INTEGER,
    "tokensPerSecond" DOUBLE PRECISION,
    "cacheHit" BOOLEAN,
    "qualityScore" DOUBLE PRECISION,
    "caseNoteIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preSummaryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "previousSummaryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "generatedAt" TIMESTAMP(3),
    "promptResolvedFrom" TEXT,
    "resolvedPromptId" TEXT,
    "sessionAgentId" TEXT,
    "sessionAgentPromptVersion" TEXT,
    "entityFaithfulnessScore" DOUBLE PRECISION,
    "coverageScore" DOUBLE PRECISION,
    "ragTriadScore" DOUBLE PRECISION,
    "attestationRef" TEXT,
    "modelName" TEXT,
    "gateDecision" TEXT,
    "assuranceCompletedAt" TIMESTAMP(3),
    "encryptedCitationsMap" BYTEA,
    "encryptedGuardrailDecisions" BYTEA,
    "keyVersion" INTEGER,
    "redactionApplied" BOOLEAN,
    "encryptedRedactionManifest" BYTEA,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SummaryMeta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."NamedEntity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextItemId" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "umlsCui" TEXT,
    "snomedCode" TEXT,
    "rxnormCode" TEXT,
    "icdCode" TEXT,
    "loincCode" TEXT,
    "transcriptContextItemId" TEXT,
    "transcriptStartOffset" INTEGER,
    "transcriptEndOffset" INTEGER,
    "startOffset" INTEGER,
    "endOffset" INTEGER,
    "assertion" TEXT,
    "confidence" DOUBLE PRECISION,
    "aiModelId" TEXT,
    "aiModelVersion" TEXT,
    "processingTimeMs" INTEGER,
    "encryptedText" BYTEA,
    "encryptedNormalizedText" BYTEA,
    "encryptedMetadata" BYTEA,
    "keyVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NamedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ContextItemVersion" (
    "_metadata" JSONB,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextItemId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "changeReason" TEXT,
    "changedBy" TEXT,
    "changeSource" TEXT,
    "encryptedContent" BYTEA,
    "encryptedContentDiff" BYTEA,
    "encryptedChangeSummary" BYTEA,
    "encryptedFieldChanges" BYTEA,
    "keyVersion" INTEGER,
    "attestedAt" TIMESTAMP(3),
    "attestedBy" TEXT,
    "attestationHash" TEXT,
    "modelName" TEXT,
    "modelVersion" TEXT,
    "sensorScores" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContextItemVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Highlight" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "sourceContextItemId" TEXT,
    "targetKind" "core"."HighlightTargetKind" NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "color" TEXT,
    "label" TEXT,
    "encryptedExact" BYTEA,
    "encryptedPrefix" BYTEA,
    "encryptedSuffix" BYTEA,
    "encryptedNote" BYTEA,
    "keyVersion" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Highlight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TranscriptSegment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contextItemId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "t0Ms" INTEGER,
    "t1Ms" INTEGER,
    "speaker" TEXT,
    "charStart" INTEGER,
    "charEnd" INTEGER,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TranscriptSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."DepartmentAgent" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "promptTemplateId" TEXT NOT NULL,
    "pinnedVersionNumber" INTEGER,
    "dnaStylePolicy" "core"."DepartmentAgentDnaPolicy" NOT NULL DEFAULT 'INHERIT',
    "harnessOverrides" JSONB,
    "goldenSetId" TEXT,
    "newPatientTemplateId" TEXT,
    "revisitTemplateId" TEXT,
    "preSummaryTemplateId" TEXT,
    "livePromptTemplateId" TEXT,
    "toolConfig" JSONB,
    "llmOverrides" JSONB,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sourceAgentTemplateSlug" TEXT,
    "templateLocked" BOOLEAN NOT NULL DEFAULT false,
    "role" "core"."DepartmentAgentRole" NOT NULL DEFAULT 'SPECIALIST',
    "subscribedKinds" JSONB,
    "writeScope" JSONB,
    "goal" JSONB,
    "guardrailProfile" TEXT,
    "alwaysActions" JSONB,
    "neverActions" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "DepartmentAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."DepartmentAgentVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "changeReason" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepartmentAgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AgentPromotion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromTenantId" TEXT NOT NULL,
    "toTenantId" TEXT NOT NULL,
    "agentVersionId" TEXT NOT NULL,
    "sourceAgentId" TEXT NOT NULL,
    "targetAgentId" TEXT NOT NULL,
    "targetAgentVersionId" TEXT,
    "configSnapshot" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "evalRunId" TEXT,
    "sourceEvalRunId" TEXT,
    "warnings" JSONB,
    "promotedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Department" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT,
    "name" TEXT,
    "description" TEXT,
    "defaultSummaryTemplate" TEXT,
    "preSummaryPromptId" TEXT,
    "newPatientPromptId" TEXT,
    "revisitPromptId" TEXT,
    "dnaWritingStylePromptId" TEXT,
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
    "tenantId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "encryptedReportData" BYTEA,
    "encryptedStyleText" BYTEA,
    "encryptedRedactionRules" BYTEA,
    "keyVersion" INTEGER,
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
    "tenantId" TEXT NOT NULL,
    "dnaReportId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "encryptedReportData" BYTEA,
    "encryptedStyleText" BYTEA,
    "encryptedRedactionRules" BYTEA,
    "keyVersion" INTEGER,
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
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
    "promptTemplateId" TEXT NOT NULL,
    "promptVersionNumber" INTEGER,
    "consultationId" TEXT,
    "doctorId" TEXT,
    "departmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptUsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PlanEntitlement" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "plan" "core"."TenantPlan" NOT NULL,
    "maxUsers" INTEGER,
    "maxDepartments" INTEGER,
    "maxPromptTemplates" INTEGER,
    "maxAsrPipelines" INTEGER,
    "maxApiKeys" INTEGER,
    "storageQuotaBytes" BIGINT,
    "maxWorkflowDefinitions" INTEGER,
    "maxConcurrentSessions" INTEGER,
    "monthlyConsultations" INTEGER,
    "monthlyTranscriptionMinutes" INTEGER,
    "monthlySummaries" INTEGER,
    "monthlyWorkflowInvocations" INTEGER,
    "monthlySttSessionSeconds" BIGINT,
    "monthlyLlmTokens" BIGINT,
    "monthlyTtsCharacters" BIGINT,
    "monthlyNlpTextUnits" BIGINT,
    "monthlyEmbeddingTokens" BIGINT,
    "featureDnaReports" BOOLEAN NOT NULL DEFAULT false,
    "featureVoiceEnrollment" BOOLEAN NOT NULL DEFAULT false,
    "featureMonitoringAccess" BOOLEAN NOT NULL DEFAULT false,
    "featurePlatformDefaultCredential" BOOLEAN NOT NULL DEFAULT false,
    "featurePaletteStt" BOOLEAN NOT NULL DEFAULT true,
    "modelTier" TEXT NOT NULL DEFAULT 'full',
    "rateLimitTier" TEXT NOT NULL DEFAULT 'default',
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantEntitlement" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "maxUsers" INTEGER,
    "maxDepartments" INTEGER,
    "maxPromptTemplates" INTEGER,
    "maxAsrPipelines" INTEGER,
    "maxApiKeys" INTEGER,
    "storageQuotaBytes" BIGINT,
    "maxWorkflowDefinitions" INTEGER,
    "maxConcurrentSessions" INTEGER,
    "monthlyConsultations" INTEGER,
    "monthlyTranscriptionMinutes" INTEGER,
    "monthlySummaries" INTEGER,
    "monthlyWorkflowInvocations" INTEGER,
    "monthlySttSessionSeconds" BIGINT,
    "monthlyLlmTokens" BIGINT,
    "monthlyTtsCharacters" BIGINT,
    "monthlyNlpTextUnits" BIGINT,
    "monthlyEmbeddingTokens" BIGINT,
    "monthlySpendLimitMicros" BIGINT,
    "featureDnaReports" BOOLEAN,
    "featureVoiceEnrollment" BOOLEAN,
    "featureMonitoringAccess" BOOLEAN,
    "featurePlatformDefaultCredential" BOOLEAN,
    "featurePaletteStt" BOOLEAN,
    "modelTier" TEXT,
    "rateLimitTier" TEXT,
    "rateLimitPerMinute" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantUsageMeter" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "metric" "core"."UsageMeterMetric" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "usedCount" BIGINT NOT NULL DEFAULT 0,
    "reconciledAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantUsageMeter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantPlanHistory" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plan" "core"."TenantPlan" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "previousPlan" "core"."TenantPlan",
    "changeReason" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPlanHistory_pkey" PRIMARY KEY ("id")
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
    "tenantId" TEXT NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "key" TEXT NOT NULL,
    "defaultValue" TEXT,
    "value" TEXT NOT NULL,
    "encryptedValue" BYTEA,
    "keyVersion" INTEGER,
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
CREATE TABLE "core"."GoldenSet" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pinnedVersion" TEXT,
    "departmentId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GoldenCase" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "label" TEXT,
    "encryptedTranscript" BYTEA,
    "encryptedReferenceNote" BYTEA,
    "keyVersion" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."EvalRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "goldenSetId" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT,
    "promptTemplateId" TEXT,
    "promptVersion" TEXT,
    "promptVersionNumber" INTEGER,
    "judgeModel" TEXT,
    "triggerType" TEXT,
    "status" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "aggregateScores" JSONB,
    "encryptedNotes" BYTEA,
    "keyVersion" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."EvalScore" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "evalRunId" TEXT NOT NULL,
    "goldenCaseId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION,
    "judgeModel" TEXT,
    "encryptedRationale" BYTEA,
    "encryptedDetails" BYTEA,
    "keyVersion" INTEGER,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."HarnessAuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT,
    "contextItemVersionId" TEXT,
    "action" "core"."HarnessAuditAction" NOT NULL,
    "modelName" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "promptTemplateId" TEXT,
    "promptVersion" TEXT,
    "sensorScores" JSONB NOT NULL,
    "citations" JSONB NOT NULL,
    "encryptedSensorScores" BYTEA,
    "encryptedCitations" BYTEA,
    "keyVersion" INTEGER,
    "gateDecision" TEXT,
    "clinicianId" TEXT,
    "attestationHash" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarnessAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."HarnessPolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityFaithfulnessThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "coverageThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "citationPresenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "numericDoseThreshold" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "groundednessThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "safetyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "phiEnabled" BOOLEAN NOT NULL DEFAULT true,
    "phiFailClosed" BOOLEAN NOT NULL DEFAULT true,
    "safetyProvider" TEXT NOT NULL DEFAULT 'lm-studio',
    "safetyModel" TEXT NOT NULL DEFAULT 'granite-guardian-4.1-8b',
    "smrProvider" TEXT,
    "smrModel" TEXT,
    "maxRegen" INTEGER NOT NULL DEFAULT 2,
    "gateSlaSeconds" INTEGER NOT NULL DEFAULT 86400,
    "gateEscalationSeconds" INTEGER NOT NULL DEFAULT 43200,
    "toolAllowlist" JSONB,
    "optimisticDeliveryEnabled" BOOLEAN,
    "atomicFactEnabled" BOOLEAN,
    "retrievalEnabled" BOOLEAN,
    "warmStartEnabled" BOOLEAN,
    "nerPriorsEnabled" BOOLEAN,
    "maxEditReruns" INTEGER,
    "regenFeedbackEnabled" BOOLEAN,
    "mcpToolsEnabled" BOOLEAN,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HarnessPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."HarnessPolicyChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "changedBy" TEXT,
    "policyVersion" INTEGER,
    "beforeJson" JSONB,
    "afterJson" JSONB NOT NULL,
    "reason" TEXT,
    "encryptedBeforeJson" BYTEA,
    "encryptedAfterJson" BYTEA,
    "keyVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HarnessPolicyChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."GateEditExemplar" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "consultationId" TEXT NOT NULL,
    "departmentId" TEXT,
    "visitType" TEXT,
    "gateDecision" TEXT NOT NULL,
    "qualitySignal" TEXT NOT NULL,
    "editDistance" INTEGER,
    "editDistanceRatio" DOUBLE PRECISION,
    "timeToSignSeconds" INTEGER,
    "redactedBefore" TEXT,
    "redactedAfter" TEXT,
    "contextItemId" TEXT,
    "modelName" TEXT,
    "promptTemplateId" TEXT,
    "curationStatus" "core"."ExemplarCurationStatus" NOT NULL DEFAULT 'PENDING',
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GateEditExemplar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantIdentityProvider" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "protocol" "core"."IdpProtocol" NOT NULL,
    "displayName" TEXT NOT NULL,
    "providerStatus" "core"."IdpStatus" NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "encryptedSecretRef" TEXT,
    "directoryCredentialsRef" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantIdentityProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."FederatedIdentity" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "FederatedIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantIdentityProviderDomain" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "TenantIdentityProviderDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."KnowledgeDocument" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" "core"."KnowledgeDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "ingestedAt" TIMESTAMP(3),
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."KnowledgeChunk" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "knowledgeDocumentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "encryptedText" BYTEA,
    "keyVersion" INTEGER,
    "qdrantPointId" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddingDim" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."McpServer" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "baseUrl" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'streamable-http',
    "authRef" TEXT,
    "toolAllowlist" JSONB,
    "phiBoundary" TEXT NOT NULL DEFAULT 'external',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Media" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "core"."NotificationType" NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "encryptedMessageText" BYTEA,
    "encryptedMessageRichText" BYTEA,
    "encryptedMessageContent" BYTEA,
    "keyVersion" INTEGER,
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
    "tenantId" TEXT NOT NULL,
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
CREATE TABLE "core"."PasswordResetToken" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'password_reset',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "requestedByUserId" TEXT,
    "requestedVia" TEXT,
    "requestIp" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PipelinePolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "autoSummaryEnabled" BOOLEAN,
    "autoNerEnabled" BOOLEAN,
    "harnessEnabled" BOOLEAN,
    "dnaStyleEnabled" BOOLEAN,
    "dnaRedactionEnabled" BOOLEAN,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PipelinePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PipelinePolicyChange" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" "core"."PipelinePolicyScope" NOT NULL DEFAULT 'TENANT',
    "scopeId" TEXT,
    "changedBy" TEXT,
    "policyVersion" INTEGER,
    "beforeJson" JSONB,
    "afterJson" JSONB NOT NULL,
    "reason" TEXT,
    "encryptedBeforeJson" BYTEA,
    "encryptedAfterJson" BYTEA,
    "keyVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PipelinePolicyChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ServiceRelease" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "releaseVersion" TEXT NOT NULL,
    "releaseTag" TEXT,
    "gitBranch" TEXT NOT NULL,
    "gitCommitSha" TEXT NOT NULL,
    "buildAt" TIMESTAMP(3) NOT NULL,
    "imageRepository" TEXT,
    "imageDigest" TEXT,
    "ciPipelineId" TEXT,
    "ciPipelineUrl" TEXT,
    "changelog" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ServiceInstance" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "serviceName" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ChangelogEntry" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "platformVersion" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" "core"."ChangelogSeverity" NOT NULL DEFAULT 'INFO',
    "audience" "core"."ChangelogAudience" NOT NULL DEFAULT 'ALL',
    "publishStatus" "core"."ChangelogPublishStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangelogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserChangelogAcknowledgement" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "changelogEntryId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserChangelogAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."PromptTemplate" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "content" TEXT NOT NULL,
    "category" "core"."PromptTemplateCategory" NOT NULL,
    "status" "core"."PromptTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "variables" JSONB,
    "lastTestScore" DOUBLE PRECISION,
    "lastTestAt" TIMESTAMP(3),
    "encryptedLastTestOutput" BYTEA,
    "keyVersion" INTEGER,
    "currentVersionNumber" INTEGER NOT NULL DEFAULT 1,
    "approvedVersionNumber" INTEGER,
    "departmentId" TEXT,
    "scope" "core"."PromptTemplateScope" NOT NULL DEFAULT 'TENANT_DEFAULT',
    "ownerUserId" TEXT,
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
    "tenantId" TEXT NOT NULL,
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
    "isProtected" BOOLEAN NOT NULL DEFAULT false,
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
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "configYaml" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sourceTemplateSlug" TEXT,
    "templateLocked" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "core"."AsrPipelineVersion" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "asrPipelineId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "configYaml" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "changeReason" TEXT,
    "changedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AsrPipelineVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiModel" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "provider" TEXT,
    "architecture" TEXT,
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
    "tenantId" TEXT NOT NULL,
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
    "encryptedResultText" BYTEA,
    "encryptedResultMetadata" BYTEA,
    "keyVersion" INTEGER,
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
    "tenantId" TEXT NOT NULL,
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
CREATE TABLE "core"."TenantAllowedOrigin" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantAllowedOrigin_pkey" PRIMARY KEY ("id")
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
    "purpose" "core"."TenantBucketPurpose" NOT NULL DEFAULT 'CUSTOM',
    "pathPattern" TEXT NOT NULL DEFAULT '{yyyy}/{MM}/{dd}/{user_name}',
    "quotaBytes" BIGINT,
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
CREATE TABLE "core"."TenantStorageConfig" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bucketId" TEXT,
    "provider" "core"."StorageProviderType" NOT NULL,
    "topology" "core"."StorageTopologyType" NOT NULL DEFAULT 'SHARED',
    "endpoint" TEXT,
    "region" TEXT,
    "forcePathStyle" BOOLEAN,
    "accountName" TEXT,
    "endpointSuffix" TEXT,
    "containerPrefix" TEXT,
    "credentialsRef" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "TenantStorageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantNlpTaskInstructions" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "instructionsJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantNlpTaskInstructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantSttConfig" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fallbackPipelineId" TEXT,
    "autoSwitchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSttConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantTtsConfig" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "defaultVoiceEn" TEXT,
    "defaultVoiceMl" TEXT,
    "routingEn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "routingMl" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultFormat" TEXT,
    "defaultSpeed" DOUBLE PRECISION,
    "sampleRate" INTEGER,
    "maxInputChars" INTEGER,
    "sarvamPublicApiAllowed" BOOLEAN NOT NULL DEFAULT false,
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantTtsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Tenant" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "plan" "core"."TenantPlan",
    "trialEndsAt" TIMESTAMP(3),
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
CREATE TABLE "core"."TenantFrontendConfig" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "asrModel" TEXT,
    "noiseCancel" BOOLEAN NOT NULL DEFAULT false,
    "vad" BOOLEAN NOT NULL DEFAULT false,
    "voiceEnrollment" BOOLEAN NOT NULL DEFAULT false,
    "diarization" BOOLEAN NOT NULL DEFAULT false,
    "captureRawAudio" BOOLEAN NOT NULL DEFAULT false,
    "transcriptionMode" "core"."TranscriptionMode" NOT NULL DEFAULT 'BACKEND',
    "transcriptionModeLocked" BOOLEAN NOT NULL DEFAULT false,
    "captureMode" "core"."CaptureMode",
    "configJson" JSONB,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantFrontendConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiUsageEvent" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capability" "core"."AiCapability" NOT NULL,
    "operation" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "deployment" "core"."AiDeploymentKind" NOT NULL,
    "unit" "core"."AiUsageUnit" NOT NULL,
    "quantity" DECIMAL(24,6) NOT NULL,
    "consultationId" TEXT,
    "doctorId" TEXT,
    "departmentId" TEXT,
    "requestId" TEXT,
    "sessionId" TEXT,
    "unitPriceMicros" BIGINT,
    "priceBookVersion" TEXT,
    "costMicros" BIGINT,
    "costBasis" "core"."AiCostBasis" NOT NULL DEFAULT 'INTERNAL',
    "attributesJson" JSONB,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiUsageOutbox" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "core"."AiUsageOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiPriceBook" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "plane" "core"."AiPriceBookPlane" NOT NULL,
    "rowKind" "core"."AiPriceRowKind" NOT NULL DEFAULT 'USAGE_UNIT',
    "planTier" "core"."TenantPlan",
    "capability" "core"."AiCapability",
    "provider" TEXT,
    "model" TEXT,
    "unit" "core"."AiUsageUnit",
    "contextBand" TEXT,
    "cacheTtl" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "unitPriceMicros" BIGINT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "bookVersion" TEXT NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiUsageRollupHourly" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "capability" "core"."AiCapability" NOT NULL,
    "operation" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "deployment" "core"."AiDeploymentKind" NOT NULL DEFAULT 'SELF_HOSTED',
    "model" TEXT NOT NULL DEFAULT '',
    "unit" "core"."AiUsageUnit" NOT NULL,
    "quantitySum" DECIMAL(38,6) NOT NULL,
    "costMicrosSum" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageRollupHourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."AiUsageRollupDaily" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "capability" "core"."AiCapability" NOT NULL,
    "operation" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL,
    "deployment" "core"."AiDeploymentKind" NOT NULL DEFAULT 'SELF_HOSTED',
    "model" TEXT NOT NULL DEFAULT '',
    "unit" "core"."AiUsageUnit" NOT NULL,
    "quantitySum" DECIMAL(38,6) NOT NULL,
    "costMicrosSum" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageRollupDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."ProviderReconciliationRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "windowLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "ledgerQuantity" DECIMAL(38,6),
    "providerQuantity" DECIMAL(38,6),
    "providerUnit" TEXT,
    "relativeDrift" DECIMAL(12,6),
    "breachedThreshold" BOOLEAN NOT NULL DEFAULT false,
    "thresholdPct" INTEGER NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserRoleAssignment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
    "passwordChangedAt" TIMESTAMP(3),
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
    "preferredPromptTemplateId" TEXT,
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
CREATE TABLE "core"."UserVoiceProfile" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "embedding" vector(256) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "label" VARCHAR(100),
    "modelId" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserVoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."UserDepartment" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,

    CONSTRAINT "UserDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."Webhook" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
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
CREATE TABLE "core"."WorkflowDefinition" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "paletteKey" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "parentVersionId" TEXT,
    "status" "core"."WorkflowDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "graph" JSONB NOT NULL,
    "graphChecksum" TEXT NOT NULL,
    "compiledConfig" JSONB,
    "compiledConfigChecksum" TEXT,
    "registryChecksum" TEXT,
    "validationReport" JSONB,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "validatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "deprecatedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "WorkflowDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."WorkflowRun" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "workflowSlug" TEXT NOT NULL,
    "workflowVersionNumber" INTEGER NOT NULL,
    "definitionName" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "trigger" TEXT NOT NULL,
    "status" "core"."WorkflowRunStatus" NOT NULL DEFAULT 'RUNNING',
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "nodeCount" INTEGER,
    "failedNodeCount" INTEGER NOT NULL DEFAULT 0,
    "degradedNodeCount" INTEGER NOT NULL DEFAULT 0,
    "firstErrorCode" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."WorkflowTestFixture" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "paletteId" TEXT,
    "workflowDefinitionId" TEXT,
    "input" JSONB NOT NULL,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowTestFixture_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "AgentTrajectoryStep_tenant_consultation_idx" ON "core"."AgentTrajectoryStep"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX "AgentTrajectoryStep_tenant_createdAt_idx" ON "core"."AgentTrajectoryStep"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTrajectoryStep_tenantId_sessionId_runId_seq_key" ON "core"."AgentTrajectoryStep"("tenantId", "sessionId", "runId", "seq");

-- CreateIndex
CREATE INDEX "AiProviderConnection_tenantId_service_idx" ON "core"."AiProviderConnection"("tenantId", "service");

-- CreateIndex
CREATE INDEX "AiProviderConnection_service_provider_idx" ON "core"."AiProviderConnection"("service", "provider");

-- CreateIndex
CREATE INDEX "AiProviderConnection_provider_idx" ON "core"."AiProviderConnection"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "AiProviderConnection_tenantId_service_provider_key" ON "core"."AiProviderConnection"("tenantId", "service", "provider");

-- CreateIndex
CREATE INDEX "AiRuntimeProfile_tenantId_idx" ON "core"."AiRuntimeProfile"("tenantId");

-- CreateIndex
CREATE INDEX "AiRuntimeProfile_provider_idx" ON "core"."AiRuntimeProfile"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "AiRuntimeProfile_tenantId_provider_modelSlug_key" ON "core"."AiRuntimeProfile"("tenantId", "provider", "modelSlug");

-- CreateIndex
CREATE INDEX "AiTaskDefault_tenantId_idx" ON "core"."AiTaskDefault"("tenantId");

-- CreateIndex
CREATE INDEX "AiTaskDefault_taskKey_idx" ON "core"."AiTaskDefault"("taskKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiTaskDefault_tenantId_taskKey_key" ON "core"."AiTaskDefault"("tenantId", "taskKey");

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
CREATE INDEX "BillingInvoice_tenantId_idx" ON "core"."BillingInvoice"("tenantId");

-- CreateIndex
CREATE INDEX "BillingInvoice_tenant_status_idx" ON "core"."BillingInvoice"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingInvoice_tenantId_periodStart_key" ON "core"."BillingInvoice"("tenantId", "periodStart");

-- CreateIndex
CREATE INDEX "BillingInvoiceLine_tenant_invoice_idx" ON "core"."BillingInvoiceLine"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "BillingInvoiceLine_invoiceId_idx" ON "core"."BillingInvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_tenant_invoice_idx" ON "core"."BillingAdjustment"("tenantId", "invoiceId");

-- CreateIndex
CREATE INDEX "BillingAdjustment_invoiceId_idx" ON "core"."BillingAdjustment"("invoiceId");

-- CreateIndex
CREATE INDEX "ConsentGrant_tenantId_idx" ON "core"."ConsentGrant"("tenantId");

-- CreateIndex
CREATE INDEX "ConsentGrant_tenant_patient_idx" ON "core"."ConsentGrant"("tenantId", "externalPatientId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_tenantId_idx" ON "core"."ConsultationContextSchema"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_departmentId_idx" ON "core"."ConsultationContextSchema"("departmentId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_tenant_scope_department_idx" ON "core"."ConsultationContextSchema"("tenantId", "scope", "departmentId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchema_tenant_isDefault_idx" ON "core"."ConsultationContextSchema"("tenantId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationContextSchema_tenantId_slug_key" ON "core"."ConsultationContextSchema"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "ConsultationContextSchemaVersion_tenantId_idx" ON "core"."ConsultationContextSchemaVersion"("tenantId");

-- CreateIndex
CREATE INDEX "ConsultationContextSchemaVersion_schemaId_idx" ON "core"."ConsultationContextSchemaVersion"("schemaId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsultationContextSchemaVersion_schemaId_versionNumber_key" ON "core"."ConsultationContextSchemaVersion"("schemaId", "versionNumber");

-- CreateIndex
CREATE INDEX "Consultation_tenantId_idx" ON "core"."Consultation"("tenantId");

-- CreateIndex
CREATE INDEX "Consultation_patientId_idx" ON "core"."Consultation"("patientId");

-- CreateIndex
CREATE INDEX "Consultation_appointmentDate_idx" ON "core"."Consultation"("appointmentDate");

-- CreateIndex
CREATE INDEX "Consultation_parentId_idx" ON "core"."Consultation"("parentConsultationId");

-- CreateIndex
CREATE INDEX "Consultation_tenant_doctor_idx" ON "core"."Consultation"("tenantId", "doctorId");

-- CreateIndex
CREATE INDEX "Consultation_tenant_department_idx" ON "core"."Consultation"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "Consultation_tenant_patient_date_idx" ON "core"."Consultation"("tenantId", "patientId", "appointmentDate");

-- CreateIndex
CREATE INDEX "Consultation_tenant_status_idx" ON "core"."Consultation"("tenantId", "status");

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
CREATE INDEX "ContextItem_mediaId_idx" ON "core"."ContextItem"("mediaId");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_kindKey_idx" ON "core"."ContextItem"("consultationId", "kindKey");

-- CreateIndex
CREATE INDEX "ContextItem_contextSchemaVersionId_idx" ON "core"."ContextItem"("contextSchemaVersionId");

-- CreateIndex
CREATE INDEX "ContextItem_consultation_type_idx" ON "core"."ContextItem"("consultationId", "type");

-- CreateIndex
CREATE INDEX "ContextItem_tenant_type_created_idx" ON "core"."ContextItem"("tenantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "ContextItem_tenant_consultation_type_idx" ON "core"."ContextItem"("tenantId", "consultationId", "type");

-- CreateIndex
CREATE INDEX "AudioRecording_tenantId_idx" ON "core"."AudioRecording"("tenantId");

-- CreateIndex
CREATE INDEX "AudioRecording_contextItemId_idx" ON "core"."AudioRecording"("contextItemId");

-- CreateIndex
CREATE INDEX "AudioRecording_mediaId_idx" ON "core"."AudioRecording"("mediaId");

-- CreateIndex
CREATE INDEX "AudioRecording_sequence_idx" ON "core"."AudioRecording"("contextItemId", "sequenceNumber");

-- CreateIndex
CREATE INDEX "AudioRecording_tenant_contextItem_idx" ON "core"."AudioRecording"("tenantId", "contextItemId");

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
CREATE INDEX "SummaryMeta_promptResolvedFrom_idx" ON "core"."SummaryMeta"("promptResolvedFrom");

-- CreateIndex
CREATE INDEX "SummaryMeta_tenant_contextItem_idx" ON "core"."SummaryMeta"("tenantId", "contextItemId");

-- CreateIndex
CREATE INDEX "NamedEntity_tenantId_idx" ON "core"."NamedEntity"("tenantId");

-- CreateIndex
CREATE INDEX "NamedEntity_contextItemId_idx" ON "core"."NamedEntity"("contextItemId");

-- CreateIndex
CREATE INDEX "NamedEntity_className_idx" ON "core"."NamedEntity"("className");

-- CreateIndex
CREATE INDEX "NamedEntity_confidence_idx" ON "core"."NamedEntity"("confidence");

-- CreateIndex
CREATE INDEX "NamedEntity_item_class_idx" ON "core"."NamedEntity"("contextItemId", "className");

-- CreateIndex
CREATE INDEX "NamedEntity_tenant_item_class_idx" ON "core"."NamedEntity"("tenantId", "contextItemId", "className");

-- CreateIndex
CREATE INDEX "NamedEntity_transcriptContextItem_idx" ON "core"."NamedEntity"("transcriptContextItemId");

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
CREATE INDEX "Highlight_tenantId_idx" ON "core"."Highlight"("tenantId");

-- CreateIndex
CREATE INDEX "Highlight_consultationId_idx" ON "core"."Highlight"("consultationId");

-- CreateIndex
CREATE INDEX "Highlight_sourceContextItemId_idx" ON "core"."Highlight"("sourceContextItemId");

-- CreateIndex
CREATE INDEX "Highlight_tenant_consultation_idx" ON "core"."Highlight"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_tenantId_idx" ON "core"."TranscriptSegment"("tenantId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_contextItemId_idx" ON "core"."TranscriptSegment"("contextItemId");

-- CreateIndex
CREATE INDEX "TranscriptSegment_tenant_item_idx" ON "core"."TranscriptSegment"("tenantId", "contextItemId");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptSegment_contextItemId_idx_key" ON "core"."TranscriptSegment"("contextItemId", "idx");

-- CreateIndex
CREATE INDEX "DepartmentAgent_tenantId_idx" ON "core"."DepartmentAgent"("tenantId");

-- CreateIndex
CREATE INDEX "DepartmentAgent_departmentId_idx" ON "core"."DepartmentAgent"("departmentId");

-- CreateIndex
CREATE INDEX "DepartmentAgent_promptTemplateId_idx" ON "core"."DepartmentAgent"("promptTemplateId");

-- CreateIndex
CREATE INDEX "DepartmentAgent_tenantId_departmentId_isDefault_idx" ON "core"."DepartmentAgent"("tenantId", "departmentId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentAgent_tenantId_departmentId_slug_key" ON "core"."DepartmentAgent"("tenantId", "departmentId", "slug");

-- CreateIndex
CREATE INDEX "DepartmentAgentVersion_tenantId_idx" ON "core"."DepartmentAgentVersion"("tenantId");

-- CreateIndex
CREATE INDEX "DepartmentAgentVersion_agentId_idx" ON "core"."DepartmentAgentVersion"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentAgentVersion_agentId_versionNumber_key" ON "core"."DepartmentAgentVersion"("agentId", "versionNumber");

-- CreateIndex
CREATE INDEX "AgentPromotion_tenantId_idx" ON "core"."AgentPromotion"("tenantId");

-- CreateIndex
CREATE INDEX "AgentPromotion_tenantId_targetAgentId_idx" ON "core"."AgentPromotion"("tenantId", "targetAgentId");

-- CreateIndex
CREATE INDEX "AgentPromotion_fromTenantId_idx" ON "core"."AgentPromotion"("fromTenantId");

-- CreateIndex
CREATE INDEX "AgentPromotion_agentVersionId_idx" ON "core"."AgentPromotion"("agentVersionId");

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
CREATE UNIQUE INDEX "PlanEntitlement_plan_key" ON "core"."PlanEntitlement"("plan");

-- CreateIndex
CREATE UNIQUE INDEX "TenantEntitlement_tenantId_key" ON "core"."TenantEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX "TenantEntitlement_tenantId_idx" ON "core"."TenantEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX "TenantUsageMeter_tenantId_idx" ON "core"."TenantUsageMeter"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantUsageMeter_tenantId_metric_periodStart_key" ON "core"."TenantUsageMeter"("tenantId", "metric", "periodStart");

-- CreateIndex
CREATE INDEX "TenantPlanHistory_tenantId_idx" ON "core"."TenantPlanHistory"("tenantId");

-- CreateIndex
CREATE INDEX "TenantPlanHistory_tenant_effectiveFrom_idx" ON "core"."TenantPlanHistory"("tenantId", "effectiveFrom");

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
CREATE INDEX "GoldenSet_tenantId_idx" ON "core"."GoldenSet"("tenantId");

-- CreateIndex
CREATE INDEX "GoldenSet_tenant_name_idx" ON "core"."GoldenSet"("tenantId", "name");

-- CreateIndex
CREATE INDEX "GoldenSet_tenant_department_idx" ON "core"."GoldenSet"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "GoldenCase_tenantId_idx" ON "core"."GoldenCase"("tenantId");

-- CreateIndex
CREATE INDEX "GoldenCase_goldenSetId_idx" ON "core"."GoldenCase"("goldenSetId");

-- CreateIndex
CREATE INDEX "GoldenCase_tenant_set_idx" ON "core"."GoldenCase"("tenantId", "goldenSetId");

-- CreateIndex
CREATE INDEX "EvalRun_tenantId_idx" ON "core"."EvalRun"("tenantId");

-- CreateIndex
CREATE INDEX "EvalRun_goldenSetId_idx" ON "core"."EvalRun"("goldenSetId");

-- CreateIndex
CREATE INDEX "EvalRun_tenant_set_idx" ON "core"."EvalRun"("tenantId", "goldenSetId");

-- CreateIndex
CREATE INDEX "EvalRun_tenant_createdAt_idx" ON "core"."EvalRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "EvalScore_tenantId_idx" ON "core"."EvalScore"("tenantId");

-- CreateIndex
CREATE INDEX "EvalScore_evalRunId_idx" ON "core"."EvalScore"("evalRunId");

-- CreateIndex
CREATE INDEX "EvalScore_goldenCaseId_idx" ON "core"."EvalScore"("goldenCaseId");

-- CreateIndex
CREATE INDEX "EvalScore_tenant_run_idx" ON "core"."EvalScore"("tenantId", "evalRunId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_tenantId_idx" ON "core"."HarnessAuditEvent"("tenantId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_tenant_consultation_idx" ON "core"."HarnessAuditEvent"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_tenant_createdAt_idx" ON "core"."HarnessAuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_consultationId_idx" ON "core"."HarnessAuditEvent"("consultationId");

-- CreateIndex
CREATE INDEX "HarnessAuditEvent_prevHash_idx" ON "core"."HarnessAuditEvent"("prevHash");

-- CreateIndex
CREATE UNIQUE INDEX "HarnessAuditEvent_hash_key" ON "core"."HarnessAuditEvent"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "HarnessPolicy_tenantId_key" ON "core"."HarnessPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "HarnessPolicyChange_tenantId_idx" ON "core"."HarnessPolicyChange"("tenantId");

-- CreateIndex
CREATE INDEX "HarnessPolicyChange_tenant_createdAt_idx" ON "core"."HarnessPolicyChange"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "GateEditExemplar_tenantId_idx" ON "core"."GateEditExemplar"("tenantId");

-- CreateIndex
CREATE INDEX "GateEditExemplar_tenant_consultation_idx" ON "core"."GateEditExemplar"("tenantId", "consultationId");

-- CreateIndex
CREATE INDEX "GateEditExemplar_retrieval_idx" ON "core"."GateEditExemplar"("tenantId", "departmentId", "qualitySignal", "createdAt");

-- CreateIndex
CREATE INDEX "GateEditExemplar_tenant_curationStatus_idx" ON "core"."GateEditExemplar"("tenantId", "curationStatus");

-- CreateIndex
CREATE INDEX "TenantIdentityProvider_tenantId_idx" ON "core"."TenantIdentityProvider"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantIdentityProvider_tenantId_protocol_displayName_key" ON "core"."TenantIdentityProvider"("tenantId", "protocol", "displayName");

-- CreateIndex
CREATE INDEX "FederatedIdentity_userId_idx" ON "core"."FederatedIdentity"("userId");

-- CreateIndex
CREATE INDEX "FederatedIdentity_tenantId_idx" ON "core"."FederatedIdentity"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "FederatedIdentity_providerId_subject_key" ON "core"."FederatedIdentity"("providerId", "subject");

-- CreateIndex
CREATE INDEX "TenantIdentityProviderDomain_providerId_idx" ON "core"."TenantIdentityProviderDomain"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantIdentityProviderDomain_domain_key" ON "core"."TenantIdentityProviderDomain"("domain");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenantId_idx" ON "core"."KnowledgeDocument"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenant_status_idx" ON "core"."KnowledgeDocument"("tenantId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenant_checksum_idx" ON "core"."KnowledgeDocument"("tenantId", "checksum");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenantId_idx" ON "core"."KnowledgeChunk"("tenantId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_knowledgeDocumentId_idx" ON "core"."KnowledgeChunk"("knowledgeDocumentId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenant_document_idx" ON "core"."KnowledgeChunk"("tenantId", "knowledgeDocumentId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_qdrantPointId_idx" ON "core"."KnowledgeChunk"("qdrantPointId");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_tenantId_name_key" ON "core"."McpServer"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Media_tenantId_index" ON "core"."Media"("tenantId");

-- CreateIndex
CREATE INDEX "Media_bucketId_index" ON "core"."Media"("bucketId");

-- CreateIndex
CREATE INDEX "Notification_tenantId_index" ON "core"."Notification"("tenantId");

-- CreateIndex
CREATE INDEX "ResourceSubscription_tenantId_index" ON "core"."ResourceSubscription"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "core"."PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "core"."PasswordResetToken"("userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "core"."PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE INDEX "PipelinePolicy_tenant_scope_idx" ON "core"."PipelinePolicy"("tenantId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "PipelinePolicy_tenantId_scope_scopeId_key" ON "core"."PipelinePolicy"("tenantId", "scope", "scopeId");

-- CreateIndex
CREATE INDEX "PipelinePolicyChange_tenantId_idx" ON "core"."PipelinePolicyChange"("tenantId");

-- CreateIndex
CREATE INDEX "PipelinePolicyChange_tenant_createdAt_idx" ON "core"."PipelinePolicyChange"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "ServiceRelease_tenantId_idx" ON "core"."ServiceRelease"("tenantId");

-- CreateIndex
CREATE INDEX "ServiceRelease_serviceName_buildAt_idx" ON "core"."ServiceRelease"("serviceName", "buildAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceRelease_serviceName_gitCommitSha_releaseTag_key" ON "core"."ServiceRelease"("serviceName", "gitCommitSha", "releaseTag");

-- CreateIndex
CREATE INDEX "ServiceInstance_tenantId_idx" ON "core"."ServiceInstance"("tenantId");

-- CreateIndex
CREATE INDEX "ServiceInstance_lastSeenAt_idx" ON "core"."ServiceInstance"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceInstance_serviceName_environment_instanceId_key" ON "core"."ServiceInstance"("serviceName", "environment", "instanceId");

-- CreateIndex
CREATE INDEX "ChangelogEntry_tenantId_idx" ON "core"."ChangelogEntry"("tenantId");

-- CreateIndex
CREATE INDEX "ChangelogEntry_publishStatus_publishedAt_idx" ON "core"."ChangelogEntry"("publishStatus", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChangelogEntry_platformVersion_key" ON "core"."ChangelogEntry"("platformVersion");

-- CreateIndex
CREATE INDEX "UserChangelogAck_tenantId_idx" ON "core"."UserChangelogAcknowledgement"("tenantId");

-- CreateIndex
CREATE INDEX "UserChangelogAck_userId_idx" ON "core"."UserChangelogAcknowledgement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserChangelogAcknowledgement_userId_changelogEntryId_key" ON "core"."UserChangelogAcknowledgement"("userId", "changelogEntryId");

-- CreateIndex
CREATE INDEX "PromptTemplate_tenantId_idx" ON "core"."PromptTemplate"("tenantId");

-- CreateIndex
CREATE INDEX "PromptTemplate_departmentId_idx" ON "core"."PromptTemplate"("departmentId");

-- CreateIndex
CREATE INDEX "PromptTemplate_category_idx" ON "core"."PromptTemplate"("category");

-- CreateIndex
CREATE INDEX "PromptTemplate_tenantId_scope_idx" ON "core"."PromptTemplate"("tenantId", "scope");

-- CreateIndex
CREATE INDEX "PromptTemplate_ownerUserId_idx" ON "core"."PromptTemplate"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_tenantId_name_key" ON "core"."PromptTemplate"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_tenantId_departmentId_ownerUserId_name_key" ON "core"."PromptTemplate"("tenantId", "departmentId", "ownerUserId", "name");

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
CREATE INDEX "AsrPipeline_tenant_locked_idx" ON "core"."AsrPipeline"("tenantId", "templateLocked");

-- CreateIndex
CREATE UNIQUE INDEX "AsrPipeline_tenantId_slug_key" ON "core"."AsrPipeline"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "AsrPipelineVersion_tenantId_idx" ON "core"."AsrPipelineVersion"("tenantId");

-- CreateIndex
CREATE INDEX "AsrPipelineVersion_asrPipelineId_idx" ON "core"."AsrPipelineVersion"("asrPipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "AsrPipelineVersion_asrPipelineId_versionNumber_key" ON "core"."AsrPipelineVersion"("asrPipelineId", "versionNumber");

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
CREATE INDEX "AiModel_provider_idx" ON "core"."AiModel"("provider");

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
CREATE INDEX "Tag_tenantId_resource_idx" ON "core"."Tag"("tenantId", "resourceTypeName", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_tenantId_resourceTypeName_resourceId_tagKey_key" ON "core"."Tag"("tenantId", "resourceTypeName", "resourceId", "tagKey");

-- CreateIndex
CREATE INDEX "TenantAllowedOrigin_tenantId_idx" ON "core"."TenantAllowedOrigin"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantAllowedOrigin_origin_tenantId_unique" ON "core"."TenantAllowedOrigin"("origin", "tenantId");

-- CreateIndex
CREATE INDEX "TenantBucket_tenantId_idx" ON "core"."TenantBucket"("tenantId");

-- CreateIndex
CREATE INDEX "TenantBucket_bucketType_idx" ON "core"."TenantBucket"("bucketType");

-- CreateIndex
CREATE INDEX "TenantBucket_tenant_type_idx" ON "core"."TenantBucket"("tenantId", "bucketType");

-- CreateIndex
CREATE INDEX "TenantBucket_tenant_purpose_idx" ON "core"."TenantBucket"("tenantId", "purpose");

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
CREATE INDEX "TenantStorageConfig_tenantId_idx" ON "core"."TenantStorageConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantStorageConfig_bucketId_idx" ON "core"."TenantStorageConfig"("bucketId");

-- CreateIndex
CREATE INDEX "TenantStorageConfig_tenant_status_idx" ON "core"."TenantStorageConfig"("tenantId", "resourceStatus");

-- CreateIndex
CREATE UNIQUE INDEX "TenantStorageConfig_tenantId_bucketId_key" ON "core"."TenantStorageConfig"("tenantId", "bucketId");

-- CreateIndex
CREATE INDEX "TenantNlpTaskInstructions_tenantId_idx" ON "core"."TenantNlpTaskInstructions"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantNlpTaskInstructions_tenant_task_unique" ON "core"."TenantNlpTaskInstructions"("tenantId", "taskKey");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSttConfig_tenantId_key" ON "core"."TenantSttConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantSttConfig_tenantId_idx" ON "core"."TenantSttConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantTtsConfig_tenantId_key" ON "core"."TenantTtsConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantTtsConfig_tenantId_idx" ON "core"."TenantTtsConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_key_key" ON "core"."Tenant"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_name_key_key" ON "core"."Tenant"("name", "key");

-- CreateIndex
CREATE UNIQUE INDEX "TenantFrontendConfig_tenantId_key" ON "core"."TenantFrontendConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantFrontendConfig_tenantId_idx" ON "core"."TenantFrontendConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageEvent_idempotencyKey_key" ON "core"."AiUsageEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenant_occurredAt_idx" ON "core"."AiUsageEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_tenant_capability_occurredAt_idx" ON "core"."AiUsageEvent"("tenantId", "capability", "occurredAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_requestId_idx" ON "core"."AiUsageEvent"("requestId");

-- CreateIndex
CREATE INDEX "AiUsageOutbox_status_availableAt_idx" ON "core"."AiUsageOutbox"("status", "availableAt");

-- CreateIndex
CREATE INDEX "AiUsageOutbox_tenantId_idx" ON "core"."AiUsageOutbox"("tenantId");

-- CreateIndex
CREATE INDEX "AiPriceBook_resolution_idx" ON "core"."AiPriceBook"("tenantId", "plane", "capability", "provider", "model", "unit", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AiPriceBook_plan_resolution_idx" ON "core"."AiPriceBook"("tenantId", "plane", "rowKind", "planTier", "effectiveFrom");

-- CreateIndex
CREATE INDEX "AiPriceBook_tenantId_idx" ON "core"."AiPriceBook"("tenantId");

-- CreateIndex
CREATE INDEX "AiUsageRollupHourly_tenant_bucketStart_idx" ON "core"."AiUsageRollupHourly"("tenantId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupHourly_tenantId_bucketStart_capability_operati_key" ON "core"."AiUsageRollupHourly"("tenantId", "bucketStart", "capability", "operation", "provider", "deployment", "model", "unit");

-- CreateIndex
CREATE INDEX "AiUsageRollupDaily_tenant_bucketStart_idx" ON "core"."AiUsageRollupDaily"("tenantId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageRollupDaily_tenantId_bucketStart_capability_operatio_key" ON "core"."AiUsageRollupDaily"("tenantId", "bucketStart", "capability", "operation", "provider", "deployment", "model", "unit");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_tenantId_idx" ON "core"."ProviderReconciliationRun"("tenantId");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_provider_window_idx" ON "core"."ProviderReconciliationRun"("provider", "windowStart");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_runAt_idx" ON "core"."ProviderReconciliationRun"("runAt");

-- CreateIndex
CREATE INDEX "ProviderReconciliationRun_breach_runAt_idx" ON "core"."ProviderReconciliationRun"("breachedThreshold", "runAt");

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
CREATE INDEX "UserVoiceProfile_tenantId_idx" ON "core"."UserVoiceProfile"("tenantId");

-- CreateIndex
CREATE INDEX "UserVoiceProfile_userId_isActive_idx" ON "core"."UserVoiceProfile"("userId", "isActive");

-- CreateIndex
CREATE INDEX "UserVoiceProfile_status_idx" ON "core"."UserVoiceProfile"("resourceStatus");

-- CreateIndex
CREATE INDEX "UserDepartment_tenantId_idx" ON "core"."UserDepartment"("tenantId");

-- CreateIndex
CREATE INDEX "UserDepartment_userId_idx" ON "core"."UserDepartment"("userId");

-- CreateIndex
CREATE INDEX "UserDepartment_departmentId_idx" ON "core"."UserDepartment"("departmentId");

-- CreateIndex
CREATE INDEX "UserDepartment_tenant_user_idx" ON "core"."UserDepartment"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "UserDepartment_tenantId_userId_departmentId_key" ON "core"."UserDepartment"("tenantId", "userId", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_tenantId_name_key" ON "core"."Webhook"("tenantId", "name");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenantId_idx" ON "core"."WorkflowDefinition"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenant_slug_status_idx" ON "core"."WorkflowDefinition"("tenantId", "slug", "status");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_tenant_slug_isActive_idx" ON "core"."WorkflowDefinition"("tenantId", "slug", "isActive");

-- CreateIndex
CREATE INDEX "WorkflowDefinition_parentVersionId_idx" ON "core"."WorkflowDefinition"("parentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_tenant_slug_version_unique" ON "core"."WorkflowDefinition"("tenantId", "slug", "versionNumber");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_startedAt_idx" ON "core"."WorkflowRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_version_idx" ON "core"."WorkflowRun"("tenantId", "workflowVersionId");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_slug_idx" ON "core"."WorkflowRun"("tenantId", "workflowSlug");

-- CreateIndex
CREATE INDEX "WorkflowRun_tenant_status_idx" ON "core"."WorkflowRun"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_session_run_key" ON "core"."WorkflowRun"("tenantId", "sessionId", "runId");

-- CreateIndex
CREATE INDEX "WorkflowTestFixture_tenantId_idx" ON "core"."WorkflowTestFixture"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowTestFixture_tenant_definition_idx" ON "core"."WorkflowTestFixture"("tenantId", "workflowDefinitionId");

-- CreateIndex
CREATE INDEX "__User_Subscription_B_index" ON "core"."__User_Subscription"("B");

-- CreateIndex
CREATE INDEX "_BucketAccessKeys_B_index" ON "core"."_BucketAccessKeys"("B");

-- AddForeignKey
ALTER TABLE "core"."ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."BillingInvoiceLine" ADD CONSTRAINT "BillingInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "core"."BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."BillingAdjustment" ADD CONSTRAINT "BillingAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "core"."BillingInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ConsultationContextSchema" ADD CONSTRAINT "ConsultationContextSchema_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ConsultationContextSchemaVersion" ADD CONSTRAINT "ConsultationContextSchemaVersion_schemaId_fkey" FOREIGN KEY ("schemaId") REFERENCES "core"."ConsultationContextSchema"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "core"."NamedEntity" ADD CONSTRAINT "NamedEntity_transcriptContextItemId_fkey" FOREIGN KEY ("transcriptContextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ContextItemVersion" ADD CONSTRAINT "ContextItemVersion_contextItemId_fkey" FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Highlight" ADD CONSTRAINT "Highlight_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "core"."Consultation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."TranscriptSegment" ADD CONSTRAINT "TranscriptSegment_contextItemId_fkey" FOREIGN KEY ("contextItemId") REFERENCES "core"."ContextItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."DepartmentAgent" ADD CONSTRAINT "DepartmentAgent_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."DepartmentAgent" ADD CONSTRAINT "DepartmentAgent_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "core"."PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."DepartmentAgentVersion" ADD CONSTRAINT "DepartmentAgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "core"."DepartmentAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "core"."GoldenCase" ADD CONSTRAINT "GoldenCase_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "core"."GoldenSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."EvalRun" ADD CONSTRAINT "EvalRun_goldenSetId_fkey" FOREIGN KEY ("goldenSetId") REFERENCES "core"."GoldenSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."EvalScore" ADD CONSTRAINT "EvalScore_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "core"."EvalRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."EvalScore" ADD CONSTRAINT "EvalScore_goldenCaseId_fkey" FOREIGN KEY ("goldenCaseId") REFERENCES "core"."GoldenCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."FederatedIdentity" ADD CONSTRAINT "FederatedIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "core"."TenantIdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."TenantIdentityProviderDomain" ADD CONSTRAINT "TenantIdentityProviderDomain_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "core"."TenantIdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_knowledgeDocumentId_fkey" FOREIGN KEY ("knowledgeDocumentId") REFERENCES "core"."KnowledgeDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Media" ADD CONSTRAINT "Media_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "core"."TenantBucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Notification" ADD CONSTRAINT "Notification_resourceSubscriptionId_fkey" FOREIGN KEY ("resourceSubscriptionId") REFERENCES "core"."ResourceSubscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Notification" ADD CONSTRAINT "Notification_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "core"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."ServiceInstance" ADD CONSTRAINT "ServiceInstance_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "core"."ServiceRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserChangelogAcknowledgement" ADD CONSTRAINT "UserChangelogAcknowledgement_changelogEntryId_fkey" FOREIGN KEY ("changelogEntryId") REFERENCES "core"."ChangelogEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."PromptTemplate" ADD CONSTRAINT "PromptTemplate_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."PromptTemplate" ADD CONSTRAINT "PromptTemplate_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "core"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."PromptVersion" ADD CONSTRAINT "PromptVersion_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "core"."PromptTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."Role" ADD CONSTRAINT "Role_parentRoleId_fkey" FOREIGN KEY ("parentRoleId") REFERENCES "core"."Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."RolePolicy" ADD CONSTRAINT "RolePolicy_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "core"."Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."RolePolicy" ADD CONSTRAINT "RolePolicy_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "core"."Policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."AsrPipelineVersion" ADD CONSTRAINT "AsrPipelineVersion_asrPipelineId_fkey" FOREIGN KEY ("asrPipelineId") REFERENCES "core"."AsrPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."TranscriptionJob" ADD CONSTRAINT "TranscriptionJob_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "core"."AsrPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."TenantStorageConfig" ADD CONSTRAINT "TenantStorageConfig_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "core"."TenantBucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "core"."UserVoiceProfile" ADD CONSTRAINT "UserVoiceProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserDepartment" ADD CONSTRAINT "UserDepartment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserDepartment" ADD CONSTRAINT "UserDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

