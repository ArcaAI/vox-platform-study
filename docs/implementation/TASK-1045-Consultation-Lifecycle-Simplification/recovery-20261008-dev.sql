-- Recovery for the dev P3018 failure on 2026-10-08. Review the preview query in
-- README.md before running. The failed migration already executed all statements
-- before Consultation_openKey_uq, including the status type swap and table creation.
-- This file resumes at the missing duplicate backfill and completes section 3-4.
-- Run only against hope-v2-dev after checking the failed migration state.

BEGIN;
LOCK TABLE "core"."Consultation" IN SHARE ROW EXCLUSIVE MODE;
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "tenantId", "doctorId", "patientId", COALESCE("departmentId", '')
    ORDER BY "createdAt" DESC, "updatedAt" DESC, "id" DESC
  ) AS position
  FROM "core"."Consultation"
  WHERE "status" NOT IN ('CLOSED_COMPLETE', 'CLOSED_INCOMPLETE')
    AND "resourceStatus" <> 'DELETED'
)
UPDATE "core"."Consultation" AS consultation
SET "status" = 'CLOSED_INCOMPLETE',
    "closedReason" = 'AUTO',
    "closedAt" = COALESCE(consultation."closedAt", CURRENT_TIMESTAMP),
    "_metadata" = COALESCE(consultation."_metadata", '{}'::jsonb)
      || '{"task1045DuplicateClosed":true}'::jsonb
FROM ranked
WHERE consultation."id" = ranked."id" AND ranked.position > 1;

CREATE UNIQUE INDEX "Consultation_openKey_uq" ON "core"."Consultation"("tenantId", "doctorId", "patientId", COALESCE("departmentId", ''))
  WHERE "status" NOT IN ('CLOSED_COMPLETE', 'CLOSED_INCOMPLETE') AND "resourceStatus" <> 'DELETED';

-- An encounter's caller ref names one encounter per consultation; encounters without a ref repeat.
CREATE UNIQUE INDEX "ConsultationEncounter_externalRef_uq" ON "core"."ConsultationEncounter"("consultationId", "externalRef")
  WHERE "externalRef" IS NOT NULL;

-- Segment ingest is idempotent: "<sttSessionId>:<utteranceIndex>" once per consultation.
CREATE UNIQUE INDEX "ContextItem_segmentKey_uq" ON "core"."ContextItem"("consultationId", "segmentKey")
  WHERE "segmentKey" IS NOT NULL;

-- One live FULL_TRANSCRIPT per consultation (later rebuilds are versions of it).
CREATE UNIQUE INDEX "ContextItem_fullTranscript_uq" ON "core"."ContextItem"("consultationId")
  WHERE "type" = 'FULL_TRANSCRIPT' AND "resourceStatus" <> 'DELETED';

-- One live fact ledger and one live recap per encounter.
CREATE UNIQUE INDEX "ContextItem_encounterArtifact_uq" ON "core"."ContextItem"("consultationId", "type", "encounterSeq")
  WHERE "type" IN ('FACT_LEDGER', 'ENCOUNTER_RECAP') AND "resourceStatus" <> 'DELETED';

-- One LATEST rating per (tenant, actor, target); superseded rows and comment-only rows repeat.
CREATE UNIQUE INDEX "ConsultationFeedback_latest_uq" ON "core"."ConsultationFeedback"("tenantId", "actorUserId", "targetKey")
  WHERE "isLatest" AND "rating" IS NOT NULL AND "targetKey" IS NOT NULL;

-- ==================================================================================================
-- 4. Immutability triggers
-- ==================================================================================================

-- ContextItemVersion: a version is history — a correction is a NEW version. DELETE always raises;
-- UPDATE raises only when the row would actually change, so an idempotent seed upsert that rewrites
-- identical values is tolerated.
CREATE OR REPLACE FUNCTION "core"."context_item_version_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ContextItemVersion %: versions are immutable — a correction is a new version, never a delete', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ContextItemVersion %: versions are immutable — a correction is a new version, never an update', OLD."id"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "context_item_version_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."ContextItemVersion"
FOR EACH ROW
EXECUTE FUNCTION "core"."context_item_version_immutability_guard"();

-- ConsultationApproval: the approval snapshot is written once; a re-approval is a new row.
CREATE OR REPLACE FUNCTION "core"."consultation_approval_immutability_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ConsultationApproval %: approval snapshots are immutable — a re-approval writes a new row', OLD."id"
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "consultation_approval_immutability_guard_trigger"
BEFORE UPDATE OR DELETE ON "core"."ConsultationApproval"
FOR EACH ROW
EXECUTE FUNCTION "core"."consultation_approval_immutability_guard"();
COMMIT;
