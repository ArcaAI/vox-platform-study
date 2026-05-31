-- CreateEnum
CREATE TYPE "core"."StorageProviderType" AS ENUM ('MINIO', 'AWS_S3', 'AZURE_BLOB');

-- CreateEnum
CREATE TYPE "core"."StorageTopologyType" AS ENUM ('SHARED', 'DEDICATED');

-- AlterEnum: audit attribution for storage-config mutations
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantStorageConfig';

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

-- CreateIndex
CREATE INDEX "TenantStorageConfig_tenantId_idx" ON "core"."TenantStorageConfig"("tenantId");

-- CreateIndex
CREATE INDEX "TenantStorageConfig_bucketId_idx" ON "core"."TenantStorageConfig"("bucketId");

-- CreateIndex
CREATE INDEX "TenantStorageConfig_tenant_status_idx" ON "core"."TenantStorageConfig"("tenantId", "resourceStatus");

-- CreateIndex
CREATE UNIQUE INDEX "TenantStorageConfig_tenantId_bucketId_key" ON "core"."TenantStorageConfig"("tenantId", "bucketId");

-- AddForeignKey
ALTER TABLE "core"."TenantStorageConfig" ADD CONSTRAINT "TenantStorageConfig_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "core"."TenantBucket"("id") ON DELETE SET NULL ON UPDATE CASCADE;
