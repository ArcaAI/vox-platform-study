-- CreateEnum
CREATE TYPE "core"."WorkflowRuleSeverity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "core"."WorkflowRulePredicateType" AS ENUM ('ACYCLIC', 'SINGLE_ENTRY', 'REACHABLE_FROM_ENTRY', 'REACHES_TERMINAL', 'REQUIRED_NODE_TYPE', 'FORBIDDEN_NODE_TYPE', 'REQUIRED_PATH_THROUGH', 'FORBIDDEN_PATH', 'ORDERED_BEFORE', 'BOUND', 'CONFIG_PREDICATE');

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE 'WorkflowInvariantRule';

-- CreateTable
CREATE TABLE "core"."WorkflowInvariantRule" (
    "_metadata" JSONB,
    "_version" INTEGER NOT NULL DEFAULT 1,
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "registerRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT NOT NULL,
    "rationale" TEXT,
    "predicateType" "core"."WorkflowRulePredicateType" NOT NULL,
    "predicateConfig" JSONB NOT NULL,
    "paletteKey" TEXT,
    "severity" "core"."WorkflowRuleSeverity" NOT NULL DEFAULT 'ERROR',
    "ruleVersion" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resourceStatus" "core"."ResourceStatusType" NOT NULL DEFAULT 'ENABLED',
    "resourceStatusUpdatedAt" TIMESTAMP(3),
    "resourceStatusUpdatedBy" TEXT,
    "createdBy" TEXT DEFAULT '60000000-0000-0000-0000-000000000000',
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowInvariantRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowInvariantRule_tenantId_idx" ON "core"."WorkflowInvariantRule"("tenantId");

-- CreateIndex
CREATE INDEX "WorkflowInvariantRule_tenant_palette_severity_idx" ON "core"."WorkflowInvariantRule"("tenantId", "paletteKey", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInvariantRule_tenant_ruleId_unique" ON "core"."WorkflowInvariantRule"("tenantId", "ruleId");
