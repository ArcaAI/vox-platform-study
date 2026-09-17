-- TASK-983 R5 — pin every APPROVED PromptTemplate that never got a version pinned.
--
-- `PromptTemplate.approvedVersionNumber` is the snapshot `PromptResolutionService`
-- actually serves (not the mutable `content` column), so an APPROVED row with a
-- NULL pin is approved in name only: it is skipped by clinical generation, and
-- the console shows the green "Approved" badge beside a "not approved" pin badge.
--
-- 16 templates (3 ARCAAI, 13 Global) shipped that way from
-- `seed/07-prompt-template.ts` until TASK-890 BBJ2-7 (commit 8de75bd2c) fixed the
-- SEED and noted "re-seed required" — and a deploy never refreshes seed data, so
-- every environment that was not reseeded still carries them. The only prior
-- backfill (20260903120000_task_858_reown_system_catchall_soap) pinned exactly one
-- hard-coded id.
--
-- `approveTemplate` now heals such a row on the next approval as well
-- (prompt-management.service.ts: the idempotent short-circuit requires
-- APPROVED *and* pinned). This migration heals them without waiting for a click.
--
-- COALESCE order: the row's own pin (belt — the WHERE clause already excludes it),
-- then `currentVersionNumber` (the history counter these rows were seeded with),
-- then 1, which is the first `PromptVersion` a seeded template owns. No new
-- PromptVersion is authored here: a seeded APPROVED template already has its v1
-- snapshot, and authoring one from SQL would bypass the entity/factory layer.
--
-- Data only. Idempotent (a second run matches no rows). `_version` is deliberately
-- NOT bumped: this is a deploy-time heal, and bumping it would invalidate every
-- ETag an open console tab is holding for no OCC benefit.
UPDATE "core"."PromptTemplate"
SET "approvedVersionNumber" = COALESCE("approvedVersionNumber", "currentVersionNumber", 1),
    "updatedAt" = NOW()
WHERE "status" = 'APPROVED'::"core"."PromptTemplateStatus"
  AND "approvedVersionNumber" IS NULL;
