-- BASELINE (catch-up) — reconcile the remaining migration-history drift found by
-- replaying the committed migrations into a clean database and diffing the
-- result against `src/prisma/db_main`.
--
-- Two classes of drift are covered, neither of which is related to TASK-615 —
-- they are folded in here because the same replay-and-diff audit surfaced them,
-- and they must be resolved for a from-migrations database to match the schema
-- (and the db-push-managed dev/test databases).
--
--   A. Schema objects that exist in the .prisma models and in the db-push
--      databases but were never created by any committed migration (materialised
--      by `prisma db push` only):
--        * enum `TenantBucketPurpose`
--        * `TenantBucket.purpose`   (+ index TenantBucket_tenant_purpose_idx)
--        * `ContextItem.mediaId`    (+ index ContextItem_mediaId_idx)
--        * `Tenant.trialEndsAt`
--
--   B. Eleven indexes whose DB name in the migration history differs from the
--      schema's canonical (Prisma-default) name. Each `@@unique`/`@@index`
--      declares a client-side compound name via `name:` (which does NOT set the
--      database index name), but the original CREATE ... INDEX statements named
--      the physical index after that string. The schema therefore expects the
--      default `Model_col_col_key` name, the db-push databases carry it, and the
--      migration history carries the custom name — so a from-migrations database
--      diffs non-empty until the physical indexes are renamed to match. These
--      renames are purely cosmetic (same columns, same uniqueness) and no query
--      or later migration references the index by name.
--
-- Timestamped BEFORE `20260806000000` so it sits with the entitlement baseline
-- in the catch-up window; every object it touches was created by a migration
-- earlier than this timestamp.
--
-- Written idempotently — DO-guarded `CREATE TYPE`, `ADD COLUMN IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`, and existence-guarded `ALTER INDEX ... RENAME` —
-- so it is a strict no-op on the db-push databases that already match the schema
-- (there the indexes already carry the target names, so each rename guard skips).

-- ===========================================================================
-- A. db-push-only schema objects
-- ===========================================================================

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'TenantBucketPurpose' AND n.nspname = 'core'
  ) THEN
    CREATE TYPE "core"."TenantBucketPurpose" AS ENUM ('AUDIO', 'ATTACHMENTS', 'MISC', 'CUSTOM');
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "core"."TenantBucket" ADD COLUMN IF NOT EXISTS "purpose" "core"."TenantBucketPurpose" NOT NULL DEFAULT 'CUSTOM';

-- AlterTable
ALTER TABLE "core"."ContextItem" ADD COLUMN IF NOT EXISTS "mediaId" TEXT;

-- AlterTable
ALTER TABLE "core"."Tenant" ADD COLUMN IF NOT EXISTS "trialEndsAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TenantBucket_tenant_purpose_idx" ON "core"."TenantBucket"("tenantId", "purpose");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ContextItem_mediaId_idx" ON "core"."ContextItem"("mediaId");

-- ===========================================================================
-- B. Index-name reconciliation (migration-history name -> schema-default name)
-- ===========================================================================

DO $$
DECLARE
  renames text[][] := ARRAY[
    ['AgentTrajectoryStep_session_seq_unique', 'AgentTrajectoryStep_tenantId_sessionId_runId_seq_key'],
    ['AiProviderConnection_tenant_service_provider_unique', 'AiProviderConnection_tenantId_service_provider_key'],
    ['AiRuntimeProfile_tenant_provider_model_unique', 'AiRuntimeProfile_tenantId_provider_modelSlug_key'],
    ['AiTaskDefault_tenant_task_unique', 'AiTaskDefault_tenantId_taskKey_key'],
    ['DepartmentAgent_tenant_dept_slug_key', 'DepartmentAgent_tenantId_departmentId_slug_key'],
    ['FederatedIdentity_providerId_subject_unique', 'FederatedIdentity_providerId_subject_key'],
    ['McpServer_tenant_name_unique', 'McpServer_tenantId_name_key'],
    ['PromptTemplate_scope_unique', 'PromptTemplate_tenantId_departmentId_ownerUserId_name_key'],
    ['TenantIdentityProvider_tenant_protocol_displayName_unique', 'TenantIdentityProvider_tenantId_protocol_displayName_key'],
    ['TenantIdentityProviderDomain_domain_unique', 'TenantIdentityProviderDomain_domain_key'],
    ['TranscriptSegment_item_idx_unique', 'TranscriptSegment_contextItemId_idx_key']
  ];
  r text[];
BEGIN
  FOREACH r SLICE 1 IN ARRAY renames LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = r[1] AND n.nspname = 'core'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = r[2] AND n.nspname = 'core'
    ) THEN
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', 'core', r[1], r[2]);
    END IF;
  END LOOP;
END
$$;
