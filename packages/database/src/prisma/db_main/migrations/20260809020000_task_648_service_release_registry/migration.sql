-- Service Version & Release Registry.
--
-- Four new tables, purely ADDITIVE:
--   - ServiceRelease  — immutable build facts, one row per (service, build).
--     Standard lifecycle (tenantId + resourceStatus soft-delete + _version OCC
--     + audit), but MACHINE-WRITTEN (self-registration, never human-edited) so
--     no OCC guard is needed at the mapper layer.
--   - ServiceInstance — heartbeated runtime observation. No `resourceStatus`
--     column: stale rows are pruned wholesale by the existing scheduler
--     surface (30-day retention), never individually soft-deleted.
--   - ChangelogEntry — curated release notes ("What's New"), the ONE
--     human-edited model here; carries real OCC (`_version` +
--     `updateWithVersion`) at the service/API layer (W13, out of scope for
--     this migration).
--   - UserChangelogAcknowledgement — per-user, per-entry acknowledgement of
--     the one-time popup. Scoped to the ACKNOWLEDGING USER'S tenant (the one
--     exception among these four models; everything else is SYSTEM-tenant
--     platform-wide data).
--
-- All rows are platform-wide (`tenantId` = the reserved SYSTEM tenant
-- `00000000-0000-0000-0000-000000000000`), except UserChangelogAcknowledgement.

-- CreateEnum
CREATE TYPE "core"."ChangelogSeverity" AS ENUM ('INFO', 'IMPORTANT', 'BREAKING');

-- CreateEnum
CREATE TYPE "core"."ChangelogAudience" AS ENUM ('ALL', 'GLOBAL_ADMIN', 'TENANT_ADMIN');

-- CreateEnum
CREATE TYPE "core"."ChangelogPublishStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE IF NOT EXISTS "core"."ServiceRelease" (
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
CREATE TABLE IF NOT EXISTS "core"."ServiceInstance" (
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
CREATE TABLE IF NOT EXISTS "core"."ChangelogEntry" (
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
CREATE TABLE IF NOT EXISTS "core"."UserChangelogAcknowledgement" (
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

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceRelease_service_commit_tag_unique" ON "core"."ServiceRelease"("serviceName", "gitCommitSha", "releaseTag");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServiceRelease_tenantId_idx" ON "core"."ServiceRelease"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServiceRelease_serviceName_buildAt_idx" ON "core"."ServiceRelease"("serviceName", "buildAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ServiceInstance_service_env_instance_unique" ON "core"."ServiceInstance"("serviceName", "environment", "instanceId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServiceInstance_tenantId_idx" ON "core"."ServiceInstance"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ServiceInstance_lastSeenAt_idx" ON "core"."ServiceInstance"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ChangelogEntry_platformVersion_unique" ON "core"."ChangelogEntry"("platformVersion");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChangelogEntry_tenantId_idx" ON "core"."ChangelogEntry"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ChangelogEntry_publishStatus_publishedAt_idx" ON "core"."ChangelogEntry"("publishStatus", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UserChangelogAck_user_entry_unique" ON "core"."UserChangelogAcknowledgement"("userId", "changelogEntryId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserChangelogAck_tenantId_idx" ON "core"."UserChangelogAcknowledgement"("tenantId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserChangelogAck_userId_idx" ON "core"."UserChangelogAcknowledgement"("userId");

-- AddForeignKey
ALTER TABLE "core"."ServiceInstance" ADD CONSTRAINT "ServiceInstance_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "core"."ServiceRelease"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "core"."UserChangelogAcknowledgement" ADD CONSTRAINT "UserChangelogAcknowledgement_changelogEntryId_fkey" FOREIGN KEY ("changelogEntryId") REFERENCES "core"."ChangelogEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterEnum — register the four new auditable ResourceTypes (additive, idempotent).
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'ServiceRelease';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'ServiceInstance';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'ChangelogEntry';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'UserChangelogAcknowledgement';
