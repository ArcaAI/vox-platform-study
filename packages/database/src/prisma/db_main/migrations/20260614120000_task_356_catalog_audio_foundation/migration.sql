-- TASK-356 — Catalog plane (Phase 1) + Audio console (Phase 4) shared DB foundation.
--
-- PURELY ADDITIVE. No DROP / DELETE / TRUNCATE / RENAME / column removal / ALTER … DROP.
-- Generated from `prisma migrate diff` (live datasource → edited datamodel) and
-- hand-augmented with idempotent `ADD VALUE IF NOT EXISTS` (safe + re-runnable on the
-- push-managed dev DB) plus a positional `BEFORE` for GUARDRAIL so the live enum order
-- matches the typed ModelTaskType order in enums.prisma. Mirrors the additive
-- precedent `20260613130000_task_355_phase_d_optimistic_delivery`.
--
-- Phase 1 (catalog): AiModelFormat += CTRANSLATE2 / FASTER_WHISPER / MLX / GGUF
--   (D-4 self-convert formats); ModelTaskType += GUARDRAIL (granite-guardian task type).
-- Phase 4 (audio console): new TranscriptionMode + CaptureMode enums and three additive
--   TenantFrontendConfig columns — transcriptionMode (default BACKEND) +
--   transcriptionModeLocked (default false) preserve the current hard-wired behavior;
--   captureMode is nullable so existing tenants keep today's per-surface capture
--   behavior until an admin opts in (back-compat, R-6).

-- CreateEnum (brand-new types)
CREATE TYPE "core"."TranscriptionMode" AS ENUM ('LOCAL', 'BACKEND');

-- CreateEnum (brand-new types)
CREATE TYPE "core"."CaptureMode" AS ENUM ('RAW_AND_PROCESSED', 'RAW_ONLY', 'PROCESSED_ONLY', 'NONE');

-- AlterEnum (additive + idempotent; appended after PYTORCH, matching enums.prisma order)
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'CTRANSLATE2';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'FASTER_WHISPER';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'MLX';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'GGUF';

-- AlterEnum (additive + idempotent; positioned so the live order matches the typed NLP
-- block — GUARDRAIL sits after SENTENCE_SIMILARITY, immediately before TEXT_TO_SPEECH)
ALTER TYPE "core"."ModelTaskType" ADD VALUE IF NOT EXISTS 'GUARDRAIL' BEFORE 'TEXT_TO_SPEECH';

-- AlterTable (all additive; transcriptionMode/Locked defaulted, captureMode nullable)
ALTER TABLE "core"."TenantFrontendConfig" ADD COLUMN     "captureMode" "core"."CaptureMode",
ADD COLUMN     "transcriptionMode" "core"."TranscriptionMode" NOT NULL DEFAULT 'BACKEND',
ADD COLUMN     "transcriptionModeLocked" BOOLEAN NOT NULL DEFAULT false;
