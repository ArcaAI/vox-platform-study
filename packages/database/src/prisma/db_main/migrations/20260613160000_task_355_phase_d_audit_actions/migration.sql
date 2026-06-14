-- TASK-355 Phase D — relaxed sign-off governance audit actions (Slice 5).
--
-- PURELY ADDITIVE. No DROP / DELETE / TRUNCATE / column removal / ALTER … DROP.
-- Three new HarnessAuditAction WORM event types for the relaxed sign-off path
-- (clinician-autonomy + full-audit governance model, doc 08 §7.1):
--   SAFETY_OVERRIDE         — Q4: clinician one-click override of a COMPLETED safety FLAG at sign-off (no free-text).
--   SIGNED_BEFORE_ASSURANCE — Q2a: note signed while assurance still running (DRAFT_PENDING_SENSORS) — correlation annotation.
--   POST_SIGN_FLAG          — Q2b: assurance returned a FLAG/REGEN AFTER an early sign (note immutable) — amendment/follow-up.
--
-- `ADD VALUE IF NOT EXISTS` is idempotent + safe on the push-managed dev DB.
-- Mirrors the existing precedent `20260524100000_add_audit_action_impersonated`.

ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SAFETY_OVERRIDE';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SIGNED_BEFORE_ASSURANCE';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'POST_SIGN_FLAG';
