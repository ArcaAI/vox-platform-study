-- Prompt governance: eval-gate bypass fix (F-02) + hot-path index (F-16).
--
-- Purely ADDITIVE. No DROP / DELETE / TRUNCATE. Safe to re-apply on the
-- db-push-managed dev/test databases, which sit ahead of migration history
-- (every statement is IF NOT EXISTS-guarded).
--
-- 1. PromptTemplate.approvedVersionNumber — the PromptVersion snapshot pinned at
--    the last approval. Resolution serves this version for unpinned agents and
--    the preferred/legacy/default tiers, so a post-approval content edit is NOT
--    served until the next (eval-gated) re-approval. Backfilled to the current
--    version for already-APPROVED templates so their approved content keeps
--    resolving after this migration.
-- 2. DepartmentAgent composite index for findDefaultForDepartment.

-- 1a. Column (nullable ⇒ back-compatible; null = never approved under this scheme).
ALTER TABLE "core"."PromptTemplate"
  ADD COLUMN IF NOT EXISTS "approvedVersionNumber" INTEGER;

-- 1b. Backfill: pin already-APPROVED templates to their current version so the
--     content they were serving stays the resolved (approved) snapshot.
UPDATE "core"."PromptTemplate"
  SET "approvedVersionNumber" = "currentVersionNumber"
  WHERE "status" = 'APPROVED' AND "approvedVersionNumber" IS NULL;

-- 2. Hot-path composite index for the default-agent lookup.
CREATE INDEX IF NOT EXISTS "DepartmentAgent_tenantId_departmentId_isDefault_idx"
  ON "core"."DepartmentAgent" ("tenantId", "departmentId", "isDefault");
