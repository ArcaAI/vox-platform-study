-- Add IMPERSONATED_ACTION to the AuditAction enum so that
-- per-request audit rows produced under impersonation can be distinguished
-- from regular LOGIN/CRUD actions and queried for HIPAA actor-on-subject
-- traceability reports.
--
-- Backward-compatible: ADD VALUE is additive. No DELETE/DROP/TRUNCATE.

ALTER TYPE "core"."AuditAction" ADD VALUE IF NOT EXISTS 'IMPERSONATED_ACTION';
