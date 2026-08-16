-- WorkflowDefinition: DB-level defense-in-depth for the two invariants
-- workflow-definition.prisma's file header (§3.4) and TASK-715's README §6
-- risk #2 named HUMAN-GATED — resolved here by TASK-734 §6 (answer: "Lets
-- review, suggest best practices"). Neither is expressible in the Prisma
-- schema DSL (no partial/filtered @@unique, no trigger support), so both are
-- hand-written. Additive only: no existing column or table is touched, and
-- neither mechanism changes what a WELL-BEHAVED caller (the application
-- service) can already do — WorkflowDefinitionService already enforces both
-- invariants itself (`assertMutable`, `demoteExistingActive`). This is
-- belt-and-suspenders, not a new business rule.
--
-- 1. At most one ACTIVE, non-deleted version per (tenantId, slug) — the
--    "movable pointer the dispatcher resolves for new runs" the Prisma model
--    comment describes but leaves application-enforced only ("a partial
--    unique index cannot express 'among ENABLED rows only' portably here" —
--    true of Prisma's schema DSL, not of Postgres itself; a partial index
--    with a WHERE predicate does exactly this). Mirrors the DB-level half of
--    ConsultationContextSchema.isDefault / DepartmentAgent.isDefault, which
--    this repo has never actually backed with an index either — this is the
--    first one, scoped to the one model this ticket owns.
CREATE UNIQUE INDEX "WorkflowDefinition_tenant_slug_active_unique"
ON "core"."WorkflowDefinition" ("tenantId", "slug")
WHERE "isActive" = true AND "resourceStatus" != 'DELETED';

-- 2. PUBLISHED/DEPRECATED rows are hard-immutable — but only for the
--    PUBLISHED BYTES and lineage identity (design.md: "Immutable config +
--    pinned version = deterministic Temporal replay"), not the whole row:
--    isActive/needsReview/validationReport/validatedAt/registryChecksum/
--    status/resourceStatus*/name/description/tags/_metadata/_version/
--    updatedAt/updatedBy stay writable, because the service's own
--    `demoteExistingActive` legitimately flips `isActive` on an already-
--    PUBLISHED row, and re-validation (TASK-716's NEEDS_REVIEW sweep)
--    legitimately rewrites `validationReport`/`needsReview` on one too. A
--    row-blind "no UPDATE at all" trigger would break both.
--
--    A hard DELETE of a PUBLISHED/DEPRECATED row is unconditionally
--    refused — the application only ever soft-deletes (rule: never hard
--    delete), so this closes the one path that could bypass it (a stray
--    admin script, a future call site that forgets the house rule).
--
--    Deliberately a trigger, not `REVOKE UPDATE, DELETE`
--    (`HarnessAuditEvent`'s idiom, migrations/20260606143138_task_330_.../
--    migration.sql:206-215): `REVOKE` is TABLE-level and this table holds
--    mutable DRAFT/VALIDATED rows in the same relation — a `REVOKE` cannot
--    distinguish DRAFT from PUBLISHED rows, a trigger can (checked below via
--    OLD.status, not NEW.status, so the guard cannot be bypassed by setting
--    status back to DRAFT in the same statement that also rewrites the
--    graph).
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
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."slug" IS DISTINCT FROM OLD."slug"
      OR NEW."paletteKey" IS DISTINCT FROM OLD."paletteKey"
      OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
      OR NEW."parentVersionId" IS DISTINCT FROM OLD."parentVersionId"
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
    THEN
      RAISE EXCEPTION 'WorkflowDefinition %: the published bytes (graph/compiledConfig, their checksums) and lineage identity are immutable once status=% — see workflow-definition.prisma §3.4', OLD."id", OLD."status"
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "workflow_definition_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."WorkflowDefinition"
FOR EACH ROW
EXECUTE FUNCTION "core"."workflow_definition_immutability_guard"();
