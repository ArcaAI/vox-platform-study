-- Align the four TASK-648 unique-index names with what Prisma derives from the schema.
--
-- Root cause: `platform.prisma` declares these constraints as
--   @@unique([...], name: "ServiceRelease_service_commit_tag_unique")
-- On `@@unique`, `name:` sets the CLIENT-facing compound key (the
-- `where: { ServiceRelease_service_commit_tag_unique: {...} }` argument) — the
-- DATABASE index name is set by `map:`, which is absent, so Prisma expects its
-- default `Model_field_field_key`. The TASK-648 migration created the indexes
-- under the `name:` value instead, leaving every migration-built database
-- permanently drifted from the schema (visible as four RenameIndex statements
-- in `prisma migrate diff` / an unwanted drift migration in `migrate dev`).
--
-- `@@index(..., name: ...)` is unaffected — there `name:` IS the database name,
-- which is why only the unique indexes drifted.
--
-- Rolling forward with the rename (rather than adding `map:`) keeps the client
-- API unchanged and matches what `db push`-managed environments already have.
--
-- Guarded: environments baselined by TASK-644 may have been `db push`-built and
-- already carry the default names, so each rename is conditional.

DO $$
DECLARE
  rename_pair RECORD;
BEGIN
  FOR rename_pair IN
    SELECT *
    FROM (
      VALUES
        ('ChangelogEntry_platformVersion_unique', 'ChangelogEntry_platformVersion_key'),
        ('ServiceInstance_service_env_instance_unique', 'ServiceInstance_serviceName_environment_instanceId_key'),
        ('ServiceRelease_service_commit_tag_unique', 'ServiceRelease_serviceName_gitCommitSha_releaseTag_key'),
        ('UserChangelogAck_user_entry_unique', 'UserChangelogAcknowledgement_userId_changelogEntryId_key')
    ) AS t(old_name, new_name)
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'core' AND indexname = rename_pair.old_name
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'core' AND indexname = rename_pair.new_name
    ) THEN
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', 'core', rename_pair.old_name, rename_pair.new_name);
    END IF;
  END LOOP;
END $$;
