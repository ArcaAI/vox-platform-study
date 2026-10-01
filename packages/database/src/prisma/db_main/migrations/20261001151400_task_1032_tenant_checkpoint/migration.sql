-- CreateEnum
CREATE TYPE "core"."TenantCheckpointKind" AS ENUM ('MANUAL', 'SAFETY');

-- CreateEnum
CREATE TYPE "core"."TenantCheckpointOrigin" AS ENUM ('CREATED', 'UPLOADED');

-- CreateEnum
CREATE TYPE "core"."TenantCheckpointStatus" AS ENUM ('PENDING', 'UPLOADING', 'RUNNING', 'READY', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "core"."TenantCheckpointCategory" AS ENUM ('CONFIG_CONTENT', 'USERS_ACCESS', 'CLINICAL');

-- CreateEnum
CREATE TYPE "core"."TenantCheckpointRestoreStatus" AS ENUM ('PENDING', 'LOCKING', 'SAFETY_CHECKPOINT', 'VERIFYING', 'RECONCILING', 'POST_COMMIT', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "core"."ResourceType" ADD VALUE 'TenantCheckpoint';
ALTER TYPE "core"."ResourceType" ADD VALUE 'TenantCheckpointRestore';

-- CreateTable
CREATE TABLE "core"."TenantCheckpoint" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "kind" "core"."TenantCheckpointKind" NOT NULL DEFAULT 'MANUAL',
    "origin" "core"."TenantCheckpointOrigin" NOT NULL DEFAULT 'CREATED',
    "status" "core"."TenantCheckpointStatus" NOT NULL DEFAULT 'PENDING',
    "includesMedia" BOOLEAN NOT NULL DEFAULT true,
    "passphraseProtected" BOOLEAN NOT NULL DEFAULT false,
    "keyEnvelope" JSONB,
    "objectKey" TEXT,
    "uploadId" TEXT,
    "sizeBytes" BIGINT,
    "manifestDigest" TEXT,
    "manifestSummary" JSONB,
    "schemaFingerprint" TEXT,
    "sourceDeploymentId" TEXT,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "progress" JSONB,
    "heartbeatAt" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "failureDetail" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core"."TenantCheckpointRestore" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "checkpointId" TEXT NOT NULL,
    "categories" "core"."TenantCheckpointCategory"[],
    "reason" TEXT NOT NULL,
    "status" "core"."TenantCheckpointRestoreStatus" NOT NULL DEFAULT 'PENDING',
    "safetyCheckpointId" TEXT,
    "counts" JSONB,
    "warnings" JSONB,
    "requestedBy" TEXT NOT NULL,
    "heartbeatAt" TIMESTAMP(3),
    "lockAcquiredAt" TIMESTAMP(3),
    "lockReleasedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "failureDetail" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCheckpointRestore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantCheckpoint_tenantId_idx" ON "core"."TenantCheckpoint"("tenantId");

-- CreateIndex
CREATE INDEX "TenantCheckpoint_tenantId_status_idx" ON "core"."TenantCheckpoint"("tenantId", "status");

-- CreateIndex
CREATE INDEX "TenantCheckpoint_status_heartbeatAt_idx" ON "core"."TenantCheckpoint"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "TenantCheckpointRestore_tenantId_idx" ON "core"."TenantCheckpointRestore"("tenantId");

-- CreateIndex
CREATE INDEX "TenantCheckpointRestore_checkpointId_idx" ON "core"."TenantCheckpointRestore"("checkpointId");

-- CreateIndex
CREATE INDEX "TenantCheckpointRestore_tenantId_status_idx" ON "core"."TenantCheckpointRestore"("tenantId", "status");

-- AddForeignKey
ALTER TABLE "core"."TenantCheckpointRestore" ADD CONSTRAINT "TenantCheckpointRestore_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "core"."TenantCheckpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one non-terminal restore per tenant: the database, not the service,
-- decides the race between two concurrent restore requests (409 TENANT_CHECKPOINT_BUSY).
CREATE UNIQUE INDEX "TenantCheckpointRestore_one_active_per_tenant"
  ON "core"."TenantCheckpointRestore" ("tenantId")
  WHERE "status" NOT IN ('COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED') AND "resourceStatus" <> 'DELETED';
