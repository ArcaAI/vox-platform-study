-- HarnessAuditAction gate-escalation records.
--
-- PURELY ADDITIVE. No DROP / DELETE / TRUNCATE / column removal / ALTER … DROP.
-- Adds two enum members so the harness `escalate_gate` SLA-breach callback
-- (apps/harness → apps/api /consultations/:id/escalation) can be persisted as a
-- WORM audit event:
--   GATE_ESCALATED — reason=gate_sla_breached (non-terminal escalation).
--   GATE_ABANDONED — reason=gate_sla_abandoned (terminal abandon, C1-02).
--
-- Hand-written (idempotent `ADD VALUE IF NOT EXISTS`) so it is safe on the
-- push-managed dev DB, matching the enum-add convention.
-- Existing rows are unaffected — no backfill, the members are simply now valid.

-- AlterEnum (additive; idempotent)
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'GATE_ESCALATED';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'GATE_ABANDONED';
