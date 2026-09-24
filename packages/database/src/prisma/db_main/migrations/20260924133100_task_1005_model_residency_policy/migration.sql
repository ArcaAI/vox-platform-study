-- CreateEnum
CREATE TYPE "core"."ModelResidencyClass" AS ENUM ('PINNED', 'WARM', 'ON_DEMAND');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'ModelResidencyPolicy';

-- AlterTable
ALTER TABLE "core"."AiModel" ADD COLUMN     "observedAt" TIMESTAMP(3),
ADD COLUMN     "observedLoadSeconds" DOUBLE PRECISION,
ADD COLUMN     "observedMemoryMb" INTEGER;

-- CreateTable
CREATE TABLE "core"."ModelResidencyPolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aiModelId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "class" "core"."ModelResidencyClass" NOT NULL DEFAULT 'ON_DEMAND',
    "idleTtlSeconds" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "maxInstances" INTEGER NOT NULL DEFAULT 1,
    "preferredDevice" TEXT,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelResidencyPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelResidencyPolicy_tenantId_service_idx" ON "core"."ModelResidencyPolicy"("tenantId", "service");

-- CreateIndex
CREATE INDEX "ModelResidencyPolicy_aiModelId_idx" ON "core"."ModelResidencyPolicy"("aiModelId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelResidencyPolicy_tenant_model_service_key" ON "core"."ModelResidencyPolicy"("tenantId", "aiModelId", "service");

-- AddForeignKey
ALTER TABLE "core"."ModelResidencyPolicy" ADD CONSTRAINT "ModelResidencyPolicy_aiModelId_fkey" FOREIGN KEY ("aiModelId") REFERENCES "core"."AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
