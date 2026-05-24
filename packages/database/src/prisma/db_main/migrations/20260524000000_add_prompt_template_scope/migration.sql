-- TASK-294 DEF-C1: Add personal-overlay support to PromptTemplate
-- Backward-compatible: every change is additive. Existing rows are
-- backfilled to scope = 'TENANT_DEFAULT' via UPDATE (no DELETE/DROP/TRUNCATE).

-- CreateEnum
CREATE TYPE "core"."PromptTemplateScope" AS ENUM ('TENANT_DEFAULT', 'DEPARTMENT_DEFAULT', 'USER_PERSONAL');

-- AlterTable: add scope + ownerUserId columns
ALTER TABLE "core"."PromptTemplate"
    ADD COLUMN "scope" "core"."PromptTemplateScope" NOT NULL DEFAULT 'TENANT_DEFAULT',
    ADD COLUMN "ownerUserId" TEXT;

-- Backfill: all existing rows are tenant defaults (no-op given the DEFAULT,
-- but stated explicitly so an idempotent re-run on rows missing the new
-- value still lands them on TENANT_DEFAULT).
UPDATE "core"."PromptTemplate"
    SET "scope" = 'TENANT_DEFAULT'
    WHERE "scope" IS NULL;

-- CreateIndex
CREATE INDEX "PromptTemplate_tenantId_scope_idx" ON "core"."PromptTemplate"("tenantId", "scope");
CREATE INDEX "PromptTemplate_ownerUserId_idx" ON "core"."PromptTemplate"("ownerUserId");

-- CreateUniqueIndex: per (tenant, department, owner, name)
CREATE UNIQUE INDEX "PromptTemplate_scope_unique"
    ON "core"."PromptTemplate"("tenantId", "departmentId", "ownerUserId", "name");

-- AddForeignKey: ownerUserId -> User(id)
ALTER TABLE "core"."PromptTemplate"
    ADD CONSTRAINT "PromptTemplate_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "core"."User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
