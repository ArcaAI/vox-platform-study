-- Reconcile the database `core."ResourceType"` enum with the
-- application `ResourceType` enum (`@arcaai/domains`).
--
-- Several services emit these values as the audit `resourceType` via
-- `broadcastSysEvent(...)`, but the values were never added to the database
-- enum when their owning tables were introduced:
-- * Highlight (`add_highlight` added the table, not the enum value)
--   * UserVoiceProfile     (`add_user_voice_profile` added the table, not the enum value)
--   * UserDepartment       (emitted by UserService / UserDepartmentService)
--   * TenantFrontendConfig (emitted by TenantFrontendConfigService)
--   * AsrPipelineVersion   (declared resource type for pipeline version snapshots)
--
-- Without these, the AuditLog INSERT fails with
-- "Invalid value for argument `resourceType`. Expected ResourceType.",
-- which rolls the originating create/update/delete back into a 500/404.
--
-- PURELY ADDITIVE and idempotent. `ADD VALUE IF NOT EXISTS` is a no-op on any
-- environment where a value already exists. No DROP / DELETE / TRUNCATE.

-- AlterEnum
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'Highlight';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'AsrPipelineVersion';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'UserVoiceProfile';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'UserDepartment';
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'TenantFrontendConfig';
