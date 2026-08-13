-- Agent configuration extension: DepartmentAgent becomes the unit
-- of loop configuration and of promotion.
--
-- Adds seven loop-configuration columns to DepartmentAgent (role,
-- subscribedKinds, writeScope, goal, guardrailProfile, alwaysActions,
-- neverActions) and the new immutable DepartmentAgentVersion snapshot table.
--
-- Additive only: every new DepartmentAgent column except `role` is NULLABLE
-- with no default, so every existing row and every write that touches none of
-- them keeps behaving exactly as it does today. `role` is NOT NULL with a
-- DB default of SPECIALIST, and is backfilled from the pre-existing
-- `isDefault` flag below so the "at most one PRIMARY per department"
-- application-layer invariant — already guaranteed for `isDefault` by
-- `setDefaultForDepartment` — is never violated by this migration.

-- CreateEnum
CREATE TYPE "core"."DepartmentAgentRole" AS ENUM ('PRIMARY', 'SPECIALIST');

-- AlterTable
ALTER TABLE "core"."DepartmentAgent" ADD COLUMN     "alwaysActions" JSONB,
ADD COLUMN     "goal" JSONB,
ADD COLUMN     "guardrailProfile" TEXT,
ADD COLUMN     "neverActions" JSONB,
ADD COLUMN     "role" "core"."DepartmentAgentRole" NOT NULL DEFAULT 'SPECIALIST',
ADD COLUMN     "subscribedKinds" JSONB,
ADD COLUMN     "writeScope" JSONB;

-- Backfill: the row that was already the department default becomes PRIMARY.
-- Every other pre-existing row already defaulted to SPECIALIST above, so this
-- statement is the only data migration this ticket needs.
UPDATE "core"."DepartmentAgent" SET "role" = 'PRIMARY' WHERE "isDefault" = true;

-- CreateTable
-- Immutable snapshot: no `resourceStatus`, no `updatedAt`/`updatedBy` by
-- design (listed in MODELS_WITHOUT_SOFT_DELETE) — the same shape as
-- ConsultationContextSchemaVersion / PromptVersion.
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

-- CreateIndex
CREATE INDEX "DepartmentAgentVersion_tenantId_idx" ON "core"."DepartmentAgentVersion"("tenantId");

-- CreateIndex
CREATE INDEX "DepartmentAgentVersion_agentId_idx" ON "core"."DepartmentAgentVersion"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "DepartmentAgentVersion_agentId_versionNumber_key" ON "core"."DepartmentAgentVersion"("agentId", "versionNumber");

-- AddForeignKey
ALTER TABLE "core"."DepartmentAgentVersion" ADD CONSTRAINT "DepartmentAgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "core"."DepartmentAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
