-- TASK-355 Phase D — Optimistic draft delivery (two-phase assurance).
--
-- PURELY ADDITIVE. No DROP / DELETE / TRUNCATE / column removal / ALTER … DROP.
-- Generated from `prisma migrate diff` (live datasource → edited datamodel) and
-- hand-augmented with (a) an idempotent enum ADD VALUE positioned BEFORE
-- 'PENDING_REVIEW' so the typed lifecycle order matches the state machine, and
-- (b) two nullable SummaryMeta columns. Existing rows are unaffected (already past
-- assurance): assuranceCompletedAt / gateDecision simply stay NULL on legacy rows.
--
-- Adds the DRAFT_PENDING_SENSORS lifecycle state (draft delivered early, assurance
-- running concurrently) and the assurance-finalisation columns that gate sign-off.

-- AlterEnum (additive; idempotent + positioned so it is safe on the push-managed dev DB)
ALTER TYPE "core"."ConsultationStatus" ADD VALUE IF NOT EXISTS 'DRAFT_PENDING_SENSORS' BEFORE 'PENDING_REVIEW';

-- AlterTable (both nullable/additive; no backfill needed)
ALTER TABLE "core"."SummaryMeta" ADD COLUMN     "assuranceCompletedAt" TIMESTAMP(3),
ADD COLUMN     "gateDecision" TEXT;
