-- WorkflowDefinition: make the context-schema binding QUERYABLE, and keep it
-- inside the published-bytes guard.
--
-- Until now a workflow's binding to a ConsultationContextSchema lived only
-- inside `graph` / `compiledConfig` JSON. That is enough for the interpreter
-- (which validates against the frozen bytes it is handed) but it means nothing
-- can answer the question a tenant admin actually asks BEFORE publishing a new
-- version of a schema: "what does this change break?" These three columns are
-- that index.
--
-- They are stamped SERVER-SIDE at publish, from the same trigger resolution the
-- compiler freezes into `compiledConfig`, so they are part of the published
-- bytes — which is why step 4 below extends the immutability guard to cover
-- them rather than leaving them silently mutable on a PUBLISHED row (the guard
-- protects a CLOSED list, so a new column is unguarded by default).
--
-- Idempotent throughout (`IF NOT EXISTS`, `CREATE OR REPLACE`): this file is
-- authored by hand against the Prisma diff rather than generated, so an
-- environment that has already seen part of it must not fail on the rest.

-- 1. The columns.
ALTER TABLE "core"."WorkflowDefinition"
  ADD COLUMN IF NOT EXISTS "contextSchemaId" TEXT,
  ADD COLUMN IF NOT EXISTS "contextSchemaVersionNumber" INTEGER,
  ADD COLUMN IF NOT EXISTS "contextSchemaFollowsLatest" BOOLEAN NOT NULL DEFAULT false;

-- 2. The index the usages read walks: every consumer of one schema, per tenant.
CREATE INDEX IF NOT EXISTS "WorkflowDefinition_tenantId_contextSchemaId_idx"
ON "core"."WorkflowDefinition" ("tenantId", "contextSchemaId");

-- 3. Backfill from the bytes that already carry the answer.
--
--    `compiledConfig.policyBindings.contextSchemaRefs[0]` is the TRIGGER's entry
--    (a graph carries at most one context-schema reference, on its trigger), so
--    it supplies the schema id and the version the artifact was frozen at. Only
--    PUBLISHED-or-later rows have a compiled config at all; a DRAFT has nothing
--    to backfill and gets its columns at its own publish.
UPDATE "core"."WorkflowDefinition"
SET
  "contextSchemaId" = "compiledConfig" -> 'policyBindings' -> 'contextSchemaRefs' -> 0 ->> 'schemaId',
  "contextSchemaVersionNumber" =
    NULLIF("compiledConfig" -> 'policyBindings' -> 'contextSchemaRefs' -> 0 ->> 'versionNumber', '')::INTEGER
WHERE "compiledConfig" IS NOT NULL
  AND jsonb_typeof("compiledConfig" -> 'policyBindings' -> 'contextSchemaRefs' -> 0) = 'object'
  AND ("compiledConfig" -> 'policyBindings' -> 'contextSchemaRefs' -> 0 ->> 'schemaId') IS NOT NULL;

--    `followsLatest` is a property of what the AUTHOR wrote, not of what publish
--    resolved: a trigger naming a schema id with NO `versionNumber` asked for
--    "whatever the tenant has pinned", and publish resolved that to a concrete
--    version without recording which of the two the author chose. So it is
--    derived from `graph`, never from `compiledConfig`.
UPDATE "core"."WorkflowDefinition"
SET "contextSchemaFollowsLatest" = true
WHERE "contextSchemaId" IS NOT NULL
  AND jsonb_typeof("graph" -> 'nodes') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements("graph" -> 'nodes') AS node
    WHERE node ->> 'type' = 'core.trigger'
      AND (node -> 'config' -> 'contextSchema' ->> 'contextSchemaId') IS NOT NULL
      AND (node -> 'config' -> 'contextSchema' -> 'versionNumber') IS NULL
  );

-- 4. Extend the published-bytes immutability guard to the three new columns.
--
--    Re-declared in full (CREATE OR REPLACE replaces the whole body) so this
--    file reads as the current definition rather than as a diff. Everything
--    below is the function as migration
--    20260817000100_task_734_workflow_definition_immutability_guard left it,
--    plus the three `IS DISTINCT FROM` clauses. Still gated on OLD.status,
--    deliberately never NEW.status, so the guard cannot be bypassed by setting
--    status back to DRAFT in the same statement that rewrites the binding.
--
--    Publish itself is unaffected: it stamps these columns while OLD.status is
--    still DRAFT/VALIDATED, which the guard does not inspect. The trigger
--    itself is unchanged and is NOT re-created here — it already points at this
--    function by name.
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

  RETURN NEW;
END;
$$;
