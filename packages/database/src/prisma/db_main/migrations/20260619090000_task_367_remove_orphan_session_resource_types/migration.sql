-- Remove dead/orphan `Session` / `SessionEvent` / `SessionSyncLog`
-- values from `core."ResourceType"`.
--
-- These three labels were declared in the very first commit (`d10c1775`,
-- migration 20260320044312) and were NEVER backed by a Prisma model, emitted by
-- any TS/Python service, or written to any database (0 rows on dev + test).
-- The login/logout/impersonation audit path uses `ResourceType.User`, not
-- `Session*`. See docs/implementation/TASK-367-Orphan-Session-ResourceType-Investigation/README.md.
--
-- Postgres CANNOT drop an enum value in place (`ALTER TYPE ... DROP VALUE` does
-- not exist), so the type is recreated via the standard swap. The only column of
-- type `core."ResourceType"` is `core."AuditLog"."resourceType"` (no default, no
-- check constraint), so the swap touches exactly one column.
--
-- DESTRUCTIVE DDL (CREATE TYPE / ALTER TABLE / DROP TYPE). A pre-flight guard
-- aborts the whole migration if any AuditLog row still uses one of the three
-- values (it would otherwise fail the USING cast / lose data). Prisma runs each
-- migration in a transaction, so a guard abort rolls everything back.

-- Pre-flight guard: abort unless ZERO AuditLog rows use the orphan values.
DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT count(*) INTO orphan_count
  FROM "core"."AuditLog"
  WHERE "resourceType" IN ('Session', 'SessionEvent', 'SessionSyncLog');

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'TASK-367 aborted: % AuditLog row(s) still use Session/SessionEvent/SessionSyncLog. Backfill/remap these rows before removing the enum values.',
      orphan_count;
  END IF;
END
$$;

-- Recreate the enum without the three orphan values (40 labels, declaration order).
CREATE TYPE "core"."ResourceType_new" AS ENUM (
  'AuditLog',
  'ApiKey',
  'Department',
  'GlobalSetting',
  'IntegrationPackage',
  'IntegrationItem',
  'Media',
  'Notification',
  'ResourceSubscription',
  'Role',
  'Permission',
  'RolePermission',
  'Tag',
  'Tenant',
  'UserRoleAssignment',
  'User',
  'UserSettings',
  'UserProfile',
  'UserMedia',
  'Webhook',
  'WebhookRunHistory',
  'Consultation',
  'ContextItem',
  'ContextItemVersion',
  'AudioRecording',
  'SummaryMeta',
  'NamedEntity',
  'AsrPipeline',
  'AiModel',
  'TranscriptionJob',
  'PromptTemplate',
  'DnaWritingStyleReport',
  'TenantBucket',
  'StorageAccessKey',
  'TenantStorageConfig',
  'Highlight',
  'AsrPipelineVersion',
  'UserVoiceProfile',
  'UserDepartment',
  'TenantFrontendConfig'
);

-- Repoint the single consuming column, then swap the type names.
ALTER TABLE "core"."AuditLog"
  ALTER COLUMN "resourceType" TYPE "core"."ResourceType_new"
  USING ("resourceType"::text::"core"."ResourceType_new");

DROP TYPE "core"."ResourceType";

ALTER TYPE "core"."ResourceType_new" RENAME TO "ResourceType";
