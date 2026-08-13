-- Agent promotion between tenants.
--
-- Adds the immutable, WORM `AgentPromotion` record and the matching
-- `ResourceType` enum value.
--
-- Additive only: one new enum value and one new table. No existing column,
-- constraint or row is touched, so every current code path behaves exactly as
-- it does today.
--
-- OWNERSHIP: `tenantId` IS `toTenantId` — the promotion record is the TARGET
-- tenant's lineage (`AgentPromotionEntity.validate()` enforces the equality).
-- The source tenant survives only as the plain `fromTenantId` column.
--
-- NO FOREIGN KEYS on `agentVersionId` / `sourceAgentId` / `targetAgentId` /
-- `targetAgentVersionId` — deliberate. The first two name rows in the SOURCE
-- tenant, and a Prisma relation would put a navigable path from a
-- target-tenant row into another tenant's data on the model. The `tenantId`
-- column's own no-FK convention is the precedent; integrity is enforced in
-- `AgentPromotionService`, which loads and authorizes both sides before it
-- writes.
--
-- No `resourceStatus` and no `updatedAt`/`updatedBy`: the row is written once
-- and never updated (a re-promotion writes a NEW row), the same immutable
-- shape as DepartmentAgentVersion / ConsultationContextSchemaVersion /
-- PromptVersion. Listed in MODELS_WITHOUT_SOFT_DELETE.

-- AlterEnum
-- `IF NOT EXISTS` mirrors the MCP-server-registry precedent
-- (migrations/20260719020000_task_516_mcp_server_registry/migration.sql:46).
-- The value is only ADDED here, never used in this same transaction, which is
-- what makes the statement safe inside Prisma's migration transaction.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'AgentPromotion';

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

-- CreateIndex
CREATE INDEX "AgentPromotion_tenantId_idx" ON "core"."AgentPromotion"("tenantId");

-- CreateIndex
-- The hot read: a target-tenant admin asking "where did this agent come from".
CREATE INDEX "AgentPromotion_tenantId_targetAgentId_idx" ON "core"."AgentPromotion"("tenantId", "targetAgentId");

-- CreateIndex
CREATE INDEX "AgentPromotion_fromTenantId_idx" ON "core"."AgentPromotion"("fromTenantId");

-- CreateIndex
CREATE INDEX "AgentPromotion_agentVersionId_idx" ON "core"."AgentPromotion"("agentVersionId");
