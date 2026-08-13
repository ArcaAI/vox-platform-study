-- Register EvalRun in the DB ResourceType enum so the eval-gated
-- promotion runner's ResourceCreated sys-event can be persisted to AuditLog
-- (without this, every EvalRun audit INSERT — and the mutation that triggered
-- it — would fail with "Invalid value for argument `resourceType`").
-- Additive + idempotent (IF NOT EXISTS); dev/test Postgres is db-push-managed.
ALTER TYPE "core"."ResourceType" ADD VALUE IF NOT EXISTS 'EvalRun';
