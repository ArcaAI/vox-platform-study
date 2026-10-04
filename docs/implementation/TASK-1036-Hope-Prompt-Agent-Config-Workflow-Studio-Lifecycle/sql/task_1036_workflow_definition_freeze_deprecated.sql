-- TASK-1036 (lane A3, §3.4 / R18) — DRAFT migration SQL. NOT APPLIED and NOT under `migrations/`.
--
-- Per 02-database-prisma.md a not-yet-applied migration must never sit inside
-- `packages/database/src/prisma/db_main/migrations/` (Prisma applies every subdirectory that has a
-- migration.sql). The orchestrator promotes this file into a timestamped migration folder
-- (`<timestamp>_task_1036_workflow_definition_freeze_deprecated/migration.sql`) at integration, replays
-- it on a throwaway shadow database, and proves there is no schema drift (this changes a FUNCTION body
-- only; no table, column or enum changes, so `prisma migrate diff` stays empty).
--
-- WHAT CHANGED vs the current definition
-- --------------------------------------
-- The current body of "core"."workflow_definition_immutability_guard"() is the one migration
-- 20260917000000_task_982_workflow_definition_context_schema_binding left (it is migration
-- 20260817000100_task_734_* plus the three context-schema-binding clauses). It protects the
-- PUBLISHED BYTES and lineage identity of a PUBLISHED or DEPRECATED row, and forbids hard-deleting
-- one. It does NOT stop a DEPRECATED row from being walked back to life: status, deprecatedAt and
-- isActive are not in its list, so a raw UPDATE could turn DEPRECATED -> PUBLISHED / DRAFT, rewrite
-- the retirement instant, or re-activate a retired version, and the service has no writer for any of
-- that (R18: DEPRECATED is terminal).
--
-- This file re-declares the function in FULL (CREATE OR REPLACE replaces the whole body, so the file
-- reads as the current definition rather than as a diff) with EVERY existing protection kept
-- verbatim, and adds one new block, gated -- like the existing one -- on OLD."status", never on
-- NEW."status":
--
--   when OLD."status" = 'DEPRECATED', refuse any UPDATE that
--     * changes "status"        (DEPRECATED -> PUBLISHED / VALIDATED / DRAFT),
--     * changes "deprecatedAt"  (the retirement instant is stamped once, by deprecate()),
--     * sets "isActive" = true  (a retired version can never be the live one).
--
-- Not affected, deliberately:
--   * deprecate() itself: it runs while OLD."status" = 'PUBLISHED', which this block does not inspect;
--     the PUBLISHED -> DEPRECATED transition, the "deprecatedAt" stamp and "isActive" -> false all stay
--     legal.
--   * soft delete / restore ("resourceStatus", "_version", "updatedAt/By"): none of them is checked,
--     so a DEPRECATED row can still be soft-deleted.
--   * "isActive" -> false on a DEPRECATED row (a no-op or a cleanup) stays legal.
--   * Edit-as-new-draft (POST :id/draft) only INSERTS a new row; it never updates the source.
--
-- The trigger itself is unchanged and is NOT re-created: it already points at this function by name.
CREATE OR REPLACE FUNCTION "core"."workflow_definition_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" IN ('PUBLISHED', 'DEPRECATED') THEN
      RAISE EXCEPTION 'WorkflowDefinition %: hard delete of a % row is forbidden — use softDelete()', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- TG_OP = 'UPDATE'. Gated on OLD.status, deliberately never NEW.status.
  IF OLD."status" IN ('PUBLISHED', 'DEPRECATED') THEN
    IF NEW."graph" IS DISTINCT FROM OLD."graph"
      OR NEW."graphChecksum" IS DISTINCT FROM OLD."graphChecksum"
      OR NEW."compiledConfig" IS DISTINCT FROM OLD."compiledConfig"
      OR NEW."compiledConfigChecksum" IS DISTINCT FROM OLD."compiledConfigChecksum"
      OR NEW."contextSchemaId" IS DISTINCT FROM OLD."contextSchemaId"
      OR NEW."contextSchemaVersionNumber" IS DISTINCT FROM OLD."contextSchemaVersionNumber"
      OR NEW."contextSchemaFollowsLatest" IS DISTINCT FROM OLD."contextSchemaFollowsLatest"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."slug" IS DISTINCT FROM OLD."slug"
      OR NEW."paletteKey" IS DISTINCT FROM OLD."paletteKey"
      OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
      OR NEW."parentVersionId" IS DISTINCT FROM OLD."parentVersionId"
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
    THEN
      RAISE EXCEPTION 'WorkflowDefinition %: the published bytes (graph/compiledConfig, their checksums, the context-schema binding) and lineage identity are immutable once status=% — see workflow-definition.prisma', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- TASK-1036: DEPRECATED is terminal. Same OLD.status gate as above, so the guard cannot be bypassed
  -- by changing status and another column in one statement.
  IF OLD."status" = 'DEPRECATED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."deprecatedAt" IS DISTINCT FROM OLD."deprecatedAt"
      OR NEW."isActive" IS TRUE
    THEN
      RAISE EXCEPTION 'WorkflowDefinition %: a DEPRECATED version is terminal — its status and deprecatedAt are frozen and it can never be re-activated; branch a new draft instead', OLD."id"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
