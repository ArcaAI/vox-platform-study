-- TASK-711 follow-up: owner decision on Q1 (README §6) — replace the speculative "ABANDONED"
-- state with a typed split of the terminal close, naming whether a human ever gave clinical
-- feedback (signed the note) before the record closed. See state-machine.md §1a.
--
-- Additive only. The pre-existing `CLOSED` member (already dead before this ticket — A-46 — and
-- never applied to a real environment by the earlier 20260816010000 migration in this same
-- ticket) is deliberately left un-targeted going forward; it cannot be dropped from a Postgres
-- enum. `CLOSED_COMPLETE`/`CLOSED_INCOMPLETE` are the only terminal-close targets `transitionTo`
-- will ever use.
--
-- Postgres forbids using a newly-added enum value in the same transaction that adds it, so this
-- is a separate migration from 20260816010000, and the backfill migration (Task 12, not yet
-- authored) must be a separate migration again, per the same constraint.

-- AlterEnum
ALTER TYPE "core"."ConsultationStatus" ADD VALUE IF NOT EXISTS 'CLOSED_COMPLETE';
ALTER TYPE "core"."ConsultationStatus" ADD VALUE IF NOT EXISTS 'CLOSED_INCOMPLETE';

-- AlterEnum
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SESSION_CLOSED_COMPLETE';
ALTER TYPE "core"."HarnessAuditAction" ADD VALUE IF NOT EXISTS 'SESSION_CLOSED_INCOMPLETE';
