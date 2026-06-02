-- AlterTable
ALTER TABLE "core"."AudioRecording" ADD COLUMN     "processedMediaId" TEXT,
ADD COLUMN     "rawMediaId" TEXT;

-- AlterTable
ALTER TABLE "core"."SummaryMeta" ADD COLUMN     "cacheHit" BOOLEAN,
ADD COLUMN     "qualityScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "core"."PromptTemplate" ADD COLUMN     "lastTestAt" TIMESTAMP(3),
ADD COLUMN     "lastTestOutput" TEXT,
ADD COLUMN     "lastTestScore" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "core"."AsrPipeline" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "core"."UserProfile" ADD COLUMN     "preferredPromptTemplateId" TEXT;

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

-- CreateIndex
CREATE INDEX "AsrPipelineVersion_tenantId_idx" ON "core"."AsrPipelineVersion"("tenantId");

-- CreateIndex
CREATE INDEX "AsrPipelineVersion_asrPipelineId_idx" ON "core"."AsrPipelineVersion"("asrPipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "AsrPipelineVersion_asrPipelineId_versionNumber_key" ON "core"."AsrPipelineVersion"("asrPipelineId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "TenantFrontendConfig_tenantId_key" ON "core"."TenantFrontendConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantFrontendConfig_tenantId_idx" ON "core"."TenantFrontendConfig"("tenantId");

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

-- AddForeignKey
ALTER TABLE "core"."AsrPipelineVersion" ADD CONSTRAINT "AsrPipelineVersion_asrPipelineId_fkey" FOREIGN KEY ("asrPipelineId") REFERENCES "core"."AsrPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserDepartment" ADD CONSTRAINT "UserDepartment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserDepartment" ADD CONSTRAINT "UserDepartment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "core"."Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
