-- TASK-732 Phase 2 exit criterion — flip the SYSTEM-tenant PipelinePolicy
-- default's `harnessEnabled` column from false to true.
--
-- Why a data migration, not just a seed-source edit: deployed rows do not
-- re-seed (`seed/14-pipeline-policy.ts`'s own doc comment; the same drift
-- TASK-702's data migration addressed for a different table). A tenant/env
-- whose SYSTEM row was already created by an earlier seed run keeps
-- whatever value it was created with until something writes to it.
--
-- The legacy signable generator this toggle used to fall back to when
-- `false` (`summary.processor.ts` / `ner.processor.ts`) was deleted in the
-- same ticket (TASK-732 Phase 3). A `false` SYSTEM default post-deletion
-- would mean any tenant with no explicit override gets a VISIBLE queued
-- failure (per `design.md` §Error handling) instead of routing through the
-- harness — this migration is what prevents that for every environment
-- that applies it.
--
-- Idempotent and narrowly scoped: touches only the ONE row it targets
-- (tenantId = SYSTEM, scope = TENANT, scopeId IS NULL — the same identity
-- `ensureTenantRow` in the seed uses), and only when it is still `false`
-- (a tenant that deliberately flipped its OWN SYSTEM row back to false for
-- some reason, however unlikely given SYSTEM is not meant to be hand-edited,
-- is left alone rather than silently overwritten). No `PipelinePolicyChange`
-- WORM row is written here — this is a platform-default migration, not a
-- tenant-scoped admin action; `PipelinePolicyService.upsertRow` remains the
-- only writer of WORM change records for actual admin edits.
UPDATE "core"."PipelinePolicy"
SET "harnessEnabled" = true
WHERE "tenantId" = '00000000-0000-0000-0000-000000000000'
  AND "scope" = 'TENANT'
  AND "scopeId" IS NULL
  AND "harnessEnabled" = false;
