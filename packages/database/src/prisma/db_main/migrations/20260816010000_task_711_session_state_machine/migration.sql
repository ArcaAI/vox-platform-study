-- TASK-711: Session state machine — schema half.
--
-- Additive only. Three new ConsultationStatus members (PRIMED, DRAINING,
-- TIMED_OUT — PAUSED deliberately NOT added, see state-machine.md), three new
-- HarnessAuditAction members for the new WORM transition rows, and a
-- degradedReasons health-flag array column on Consultation (a filterable
-- projection on the active phase, not a state of its own).
--
-- Postgres forbids using a newly-added enum value in the same transaction
-- that adds it, so all data movement (the metadata.status backfill) lives in
-- a separate, later migration (task_711_consultation_status_backfill) that
-- only runs once these values are committed.

-- AlterEnum
ALTER TYPE "core"."ConsultationStatus" ADD VALUE IF NOT EXISTS 'PRIMED';
ALTER TYPE "core"."ConsultationStatus" ADD VALUE IF NOT EXISTS 'DRAINING';
ALTER TYPE "core"."ConsultationStatus" ADD VALUE IF NOT EXISTS 'TIMED_OUT';

-- AlterEnum
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SESSION_PRIMED';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SESSION_TIMED_OUT';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SESSION_REOPENED';

-- AlterTable
ALTER TABLE "core"."Consultation" ADD COLUMN     "degradedReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
