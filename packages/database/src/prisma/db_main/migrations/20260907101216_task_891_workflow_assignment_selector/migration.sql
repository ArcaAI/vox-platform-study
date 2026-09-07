-- DropIndex
DROP INDEX "core"."WorkflowAssignment_scope_palette_unique";

-- AlterTable
ALTER TABLE "core"."WorkflowAssignment" ADD COLUMN     "selectorKey" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowAssignment_scope_palette_selector_unique" ON "core"."WorkflowAssignment"("tenantId", "scope", "scopeId", "paletteKey", "selectorKey");

