-- TASK-586 — promote the Sarvam & OpenAI cloud STT engines to first-class
-- AiModelFormat values so a bare-slug pipeline `models.asr` reference binds them
-- exactly like AZURE_SPEECH (previously they were stored as the generic CLOUD_API
-- and required an inline `engine:`/`provider::model` override — the seed-shape
-- inconsistency vs Azure). Also realigns the Prisma enum with the Python
-- `apps/stt/.../dto.py` enum, which already carries SARVAM/OPENAI (the enums MUST
-- stay in sync — see enums.prisma).
--
-- PURELY ADDITIVE. No DROP / DELETE / TRUNCATE / RENAME. Idempotent
-- `ADD VALUE IF NOT EXISTS` so it is safe + re-runnable on the push-managed dev DB.
-- Appended after WHISPER_CPP to match the typed order in enums.prisma.

ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'SARVAM';
ALTER TYPE "core"."AiModelFormat" ADD VALUE IF NOT EXISTS 'OPENAI';
