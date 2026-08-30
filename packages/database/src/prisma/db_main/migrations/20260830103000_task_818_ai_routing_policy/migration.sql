-- ============================================================================
-- TASK-818 §3A.3 — AiRoutingPolicy
--
-- Applied 2026-08-30. Verified against a throwaway shadow DB: full ledger replayed
-- from empty, then `prisma migrate diff --from-config-datasource --to-schema`
-- printed "-- This is an empty migration." — so the schema and this SQL agree.
--
-- ⚠ This folder is deliberately named `PENDING_…` and NOT `<timestamp>_…`, so
--   `prisma migrate deploy` SKIPS it and it can never be mistaken for an
--   applied migration. It is not in the ledger and must not be added to one by
--   hand.
--
-- The statements below are Prisma's OWN output, produced offline with a
-- schema-to-schema diff (no database was touched):
--
--   npx prisma migrate diff \
--     --from-schema <db_main as of the parent commit> \
--     --to-schema   src/prisma/db_main \
--     --script
--
-- To turn this into a real, timestamped migration, follow
-- `.claude/rules/02-database-prisma.md` §Migration Workflow against a THROWAWAY
-- shadow database — never against the dev DB, which is `db push`-managed and
-- carries no `_prisma_migrations` ledger. The exact command sequence is in the
-- lane report accompanying this change. After the real folder exists, DELETE
-- this one.
--
-- Two notes for whoever applies it:
--   1. `ALTER TYPE … ADD VALUE` adds a ResourceType member. Nothing in this
--      migration USES the new value, so it is safe in the same transaction
--      (identical shape to 20260826113600_task_810_document_template_catalog).
--   2. `candidatesJson` is NOT NULL with no default. That is intentional — a
--      policy with no candidates cannot route — and it is safe because the
--      table is created empty in this same migration.
-- ============================================================================

-- CreateEnum
CREATE TYPE "core"."AiRoutingPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "core"."AiRoutingStrategy" AS ENUM ('PRIORITY', 'WEIGHTED', 'LEAST_BUSY', 'LOWEST_LATENCY', 'LOWEST_COST');

-- CreateEnum
CREATE TYPE "core"."AiExplicitProviderMode" AS ENUM ('STRICT', 'STRICT_UNLESS_OPTED_IN', 'POLICY_MAY_OVERRIDE');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'AiRoutingPolicy';

-- CreateTable
CREATE TABLE "core"."AiRoutingPolicy" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "taskKey" TEXT NOT NULL,
    "policyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "core"."AiRoutingPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "strategy" "core"."AiRoutingStrategy" NOT NULL DEFAULT 'PRIORITY',
    "explicitProviderMode" "core"."AiExplicitProviderMode" NOT NULL DEFAULT 'STRICT',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "killSwitch" BOOLEAN NOT NULL DEFAULT false,
    "matchJson" JSONB,
    "candidatesJson" JSONB NOT NULL,
    "fallbackJson" JSONB,
    "healthJson" JSONB,
    "maxConcurrentStreams" INTEGER,
    "requestsPerMinute" INTEGER,
    "tokensPerMinute" INTEGER,
    "affinityJson" JSONB,
    "supersedesVersion" INTEGER,
    "activatedAt" TIMESTAMP(3),
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiRoutingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiRoutingPolicy_tenantId_taskKey_idx" ON "core"."AiRoutingPolicy"("tenantId", "taskKey");

-- CreateIndex
CREATE UNIQUE INDEX "AiRoutingPolicy_tenantId_taskKey_policyVersion_unique" ON "core"."AiRoutingPolicy"("tenantId", "taskKey", "policyVersion");
