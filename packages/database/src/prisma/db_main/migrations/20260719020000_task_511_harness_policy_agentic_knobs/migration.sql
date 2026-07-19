-- TASK-511 Phase 3A — HarnessPolicy agentic loop knobs (control-plane consolidation).
--
-- Purely ADDITIVE: seven nullable columns on the existing HarnessPolicy table so
-- the agentic loop knobs the workflow reads become DB-editable per tenant. Every
-- column is NULLABLE with NO default: null ⇒ the harness env/code default applies
-- (per-field fallthrough, mirroring the existing smrProvider/smrModel precedent).
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) so it is safe to apply via
-- `pnpm db:push` / psql on the db-push-managed dev database, which sits ahead of
-- migration history. NO DROP / DELETE / TRUNCATE.

ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "optimisticDeliveryEnabled" BOOLEAN;
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "atomicFactEnabled" BOOLEAN;
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "retrievalEnabled" BOOLEAN;
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "warmStartEnabled" BOOLEAN;
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "nerPriorsEnabled" BOOLEAN;
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "maxEditReruns" INTEGER;
ALTER TABLE "core"."HarnessPolicy" ADD COLUMN IF NOT EXISTS "regenFeedbackEnabled" BOOLEAN;
