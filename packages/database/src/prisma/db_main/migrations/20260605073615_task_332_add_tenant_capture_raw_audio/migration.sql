-- TASK-332: add the tenant-level toggle for local raw-stream dual-capture.
-- The effective SDK flag is platformCapability(GlobalSetting feature-flags
-- 'enable-local-raw-capture') AND this column, computed server-side in
-- GET /tenant/me/config. Backward-compatible: the column is NOT NULL with a
-- false default so existing rows keep raw-capture OFF (additive only — no
-- DROP/DELETE/TRUNCATE).

-- AlterTable
ALTER TABLE "core"."TenantFrontendConfig" ADD COLUMN     "captureRawAudio" BOOLEAN NOT NULL DEFAULT false;
