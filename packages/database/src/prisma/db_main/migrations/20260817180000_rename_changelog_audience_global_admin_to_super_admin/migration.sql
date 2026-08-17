-- ChangelogAudience enum only: rename GLOBAL_ADMIN → SUPER_ADMIN.
-- Does not touch Role.name or User rows. Seed remains the source of truth
-- for the elevated role and the super_admin user.
--
-- Idempotent: RENAME VALUE runs only when the old label is still present.
-- PostgreSQL RENAME VALUE updates stored enum labels in place, so existing
-- ChangelogEntry.audience rows follow the new name automatically.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'core'
      AND t.typname = 'ChangelogAudience'
      AND e.enumlabel = 'GLOBAL_ADMIN'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'core'
      AND t.typname = 'ChangelogAudience'
      AND e.enumlabel = 'SUPER_ADMIN'
  ) THEN
    ALTER TYPE "core"."ChangelogAudience" RENAME VALUE 'GLOBAL_ADMIN' TO 'SUPER_ADMIN';
  END IF;
END $$;
