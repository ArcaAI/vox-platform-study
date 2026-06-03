-- TASK-331 doc-02 F5: Promote the prompt Draft/Published lifecycle to a REAL
-- column so the admin status filter is server-side instead of client-side over
-- paginated pages. Backward-compatible: every change is additive. Existing rows
-- land on the DEFAULT 'DRAFT' (no DELETE/DROP/TRUNCATE).

-- CreateEnum
CREATE TYPE "core"."PromptTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- AlterTable: add status column (defaults every existing row to DRAFT)
ALTER TABLE "core"."PromptTemplate" ADD COLUMN "status" "core"."PromptTemplateStatus" NOT NULL DEFAULT 'DRAFT';
