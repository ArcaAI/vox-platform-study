-- CreateEnum
CREATE TYPE "core"."RateLimitMatchKind" AS ENUM ('EXACT', 'PREFIX');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'RateLimitRule';

-- AlterTable
ALTER TABLE "core"."PlanEntitlement" ADD COLUMN     "rateLimitPerMinute" INTEGER,
ADD COLUMN     "rateLimitWindowMs" INTEGER;

-- AlterTable
ALTER TABLE "core"."TenantEntitlement" ADD COLUMN     "rateLimitWindowMs" INTEGER;

-- CreateTable
CREATE TABLE "core"."RateLimitRule" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "routeMatch" TEXT NOT NULL,
    "matchKind" "core"."RateLimitMatchKind" NOT NULL DEFAULT 'EXACT',
    "limitValue" INTEGER NOT NULL,
    "windowMs" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitRule_tenantId_idx" ON "core"."RateLimitRule"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimitRule_tenantId_routeMatch_matchKind_key" ON "core"."RateLimitRule"("tenantId", "routeMatch", "matchKind");
