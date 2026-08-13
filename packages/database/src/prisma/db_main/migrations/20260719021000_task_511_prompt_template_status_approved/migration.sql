-- Add the APPROVED value to PromptTemplateStatus.
--
-- Purely ADDITIVE enum extension. Postgres forbids using a newly-added enum
-- value in the SAME transaction that adds it, so the seed flip that consumes
-- APPROVED lives in the FOLLOWING migration
-- (20260719022000_task_511_prompt_template_approve_seed). NO DROP / DELETE.
--
-- Idempotent (ADD VALUE IF NOT EXISTS) so it is safe to re-apply on the
-- db-push-managed dev database, which sits ahead of migration history.

ALTER TYPE "core"."PromptTemplateStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
