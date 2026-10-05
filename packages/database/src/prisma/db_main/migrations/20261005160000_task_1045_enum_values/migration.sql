-- TASK-1045 — enum values added ahead of the consultation lifecycle migration.
-- Kept in their own migration because a value added by `ALTER TYPE … ADD VALUE` cannot be USED
-- in the same transaction, and the next migration's partial indexes name the new ContextItemType
-- values.

-- AlterEnum — the consultation record model's item types.
ALTER TYPE "core"."ContextItemType" ADD VALUE 'TRANSCRIPT_SEGMENT';
ALTER TYPE "core"."ContextItemType" ADD VALUE 'FULL_TRANSCRIPT';
ALTER TYPE "core"."ContextItemType" ADD VALUE 'FACT_LEDGER';
ALTER TYPE "core"."ContextItemType" ADD VALUE 'ENCOUNTER_RECAP';

-- AlterEnum — the session-level approval audit row.
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE 'SESSION_APPROVED';

-- AlterEnum — audited resource types of the new tables.
ALTER TYPE "core"."ResourceType" ADD VALUE 'ConsultationEncounter';
ALTER TYPE "core"."ResourceType" ADD VALUE 'ConsultationApproval';
ALTER TYPE "core"."ResourceType" ADD VALUE 'ConsultationAttachment';
ALTER TYPE "core"."ResourceType" ADD VALUE 'ConsultationFeedback';
ALTER TYPE "core"."ResourceType" ADD VALUE 'ConsultationFeedbackRollup';
