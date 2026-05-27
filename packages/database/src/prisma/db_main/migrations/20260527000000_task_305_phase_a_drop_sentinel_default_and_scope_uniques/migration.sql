-- TASK-305 Phase A — Schema hardening (drop sentinel default, NOT NULL
-- tenantId, scoped uniques, tenant-leading composite indexes).
--
-- WHY:
--   The audit (`docs/multi-tenancy-audit/02-prisma-schema-review.md` §B3–B5)
--   classified the previous `tenantId String? @default("50000000-…")` schema
--   as the single largest cross-tenant leak primitive in the data layer:
--   any caller bug that omitted `tenantId` silently wrote to the Global
--   customer tenant; NULL meant "applies to all tenants" but the unique
--   constraints treated NULL as distinct, allowing a global assignment to
--   shadow a tenant-scoped one. This migration moves the schema to
--   "explicit-or-fail": every write must pass `tenantId`; platform-wide rows
--   belong to a reserved system tenant (UUID `00000000-…`).
--
-- WHAT THIS MIGRATION DOES (in order):
--   1. Insert the reserved system tenant row (idempotent).
--   2. Back-fill orphan rows — any row whose `tenantId` is currently NULL is
--      re-pointed to the system tenant. Affects the 11 tables that had
--      `tenantId String?`. Rows that already carried the sentinel value
--      `'50000000-…'` (the old default) stay on the Global customer tenant —
--      they were never NULL, so they are owned data, not orphans.
--   3. DROP DEFAULT on all 27 tenantId columns — no more silent fill-in.
--   4. SET NOT NULL on the 11 previously-nullable tenantId columns.
--   5. Drop the now-redundant single-column indexes that the tenant-leading
--      composites supersede (`Consultation.doctorId/departmentId`,
--      `Webhook.tenantId`).
--   6. Drop the global unique on `Webhook.name`.
--   7. Add tenant-leading composite indexes on PHI hot paths
--      (Consultation/ContextItem/AudioRecording/SummaryMeta/NamedEntity).
--   8. Add tenant-scoped uniques on `Tag` and `Webhook`.
--
-- PRE-FLIGHT (ops must confirm BEFORE running this migration):
--   - No duplicate (userId, roleId, NULL) rows in core."UserRoleAssignment".
--     Run:
--       SELECT "userId", "roleId", count(*) FROM core."UserRoleAssignment"
--       WHERE "tenantId" IS NULL GROUP BY 1,2 HAVING count(*) > 1;
--     Expected: zero rows. If any rows are returned, dedupe before applying
--     (older duplicates DELETED by ops with explicit user approval — this
--     migration intentionally does not DELETE rows).
--   - No duplicate (tenantId, name, key) rows in core."GlobalSetting" after
--     back-fill, no duplicate (tenantId, slug) in core."AsrPipeline" /
--     core."AiModel" — same query shape as above, substitute columns.
--
-- POST-FLIGHT (smoke checks):
--   - SELECT COUNT(*) FROM core."Tenant" WHERE id = '00000000-0000-0000-0000-000000000000';
--     -- expect 1
--   - SELECT count(*) FROM core."AuditLog" WHERE "tenantId" IS NULL; -- expect 0
--   - SELECT count(*) FROM information_schema.columns
--     WHERE table_schema = 'core' AND column_default LIKE '%50000000-%'; -- expect 0
--   - SELECT indexname FROM pg_indexes WHERE schemaname = 'core'
--     AND indexname LIKE 'Consultation_tenant_%'; -- expect 2 (doctor, department)
--
-- BACKWARD COMPATIBILITY:
--   - No table is dropped; no column is removed.
--   - Pre-existing rows already carrying tenantId = '50000000-…' (the old
--     sentinel default) remain on the Global customer tenant — they are not
--     touched here.
--   - The `softDeleteFilter` Prisma extension is unaffected.
--
-- =============================================================================
-- STEP 1 — Insert the reserved system tenant (idempotent)
-- =============================================================================

INSERT INTO core."Tenant" (id, name, key, description, "_metadata", "_version", "resourceStatus")
VALUES (
    '00000000-0000-0000-0000-000000000000',
    'System',
    '__SYSTEM__',
    'Reserved system tenant for platform-wide rows (policies, roles, system AI models). DO NOT use for customer data.',
    '{}'::jsonb,
    1,
    'ENABLED'
)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- STEP 2 — Back-fill orphan rows (NULL tenantId → SYSTEM_TENANT_ID)
-- =============================================================================

UPDATE core."AuditLog"             SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."ApiKey"               SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."Media"                SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."Notification"         SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."ResourceSubscription" SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."GlobalSetting"        SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."Webhook"              SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."Tag"                  SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."AsrPipeline"          SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."AiModel"              SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;
UPDATE core."UserRoleAssignment"   SET "tenantId" = '00000000-0000-0000-0000-000000000000' WHERE "tenantId" IS NULL;

-- =============================================================================
-- STEP 3-8 — Auto-generated by `prisma migrate diff` (TASK-305 A.5)
-- =============================================================================

-- DropIndex
DROP INDEX "core"."Consultation_doctorId_idx";

-- DropIndex
DROP INDEX "core"."Consultation_departmentId_idx";

-- DropIndex
DROP INDEX "core"."Webhook_name_key";

-- DropIndex
DROP INDEX "core"."Webhook_tenantId_index";

-- AlterTable
ALTER TABLE "core"."ApiKey" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."AuditLog" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."Consultation" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."ContextItem" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."AudioRecording" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."SummaryMeta" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."NamedEntity" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."ContextItemVersion" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."Department" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."DnaWritingStyleReport" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."DnaWritingStyleVersion" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."DnaUsageRecord" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."PromptUsageRecord" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."GlobalSetting" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."Media" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."Notification" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."ResourceSubscription" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."PromptTemplate" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."PromptVersion" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."AsrPipeline" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."AiModel" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."TranscriptionJob" ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."Tag" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."UserRoleAssignment" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "core"."Webhook" ALTER COLUMN "tenantId" SET NOT NULL,
ALTER COLUMN "tenantId" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Consultation_tenant_doctor_idx" ON "core"."Consultation"("tenantId", "doctorId");

-- CreateIndex
CREATE INDEX "Consultation_tenant_department_idx" ON "core"."Consultation"("tenantId", "departmentId");

-- CreateIndex
CREATE INDEX "ContextItem_tenant_consultation_type_idx" ON "core"."ContextItem"("tenantId", "consultationId", "type");

-- CreateIndex
CREATE INDEX "AudioRecording_tenant_contextItem_idx" ON "core"."AudioRecording"("tenantId", "contextItemId");

-- CreateIndex
CREATE INDEX "SummaryMeta_tenant_contextItem_idx" ON "core"."SummaryMeta"("tenantId", "contextItemId");

-- CreateIndex
CREATE INDEX "NamedEntity_tenant_item_class_idx" ON "core"."NamedEntity"("tenantId", "contextItemId", "className");

-- CreateIndex
CREATE INDEX "Tag_tenantId_resource_idx" ON "core"."Tag"("tenantId", "resourceTypeName", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_tenantId_resourceTypeName_resourceId_tagKey_key" ON "core"."Tag"("tenantId", "resourceTypeName", "resourceId", "tagKey");

-- CreateIndex
CREATE UNIQUE INDEX "Webhook_tenantId_name_key" ON "core"."Webhook"("tenantId", "name");
