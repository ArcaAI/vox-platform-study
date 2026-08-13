-- D-8 roll-forward — backfill `sarvam-saaras-v4` AiModel.format
--
-- Commit 7703e40f illegally amended the ALREADY-COMMITTED migration
-- 20260803090000_task_586_backfill_cloud_asr_formats, appending an UPDATE for
-- slug 'sarvam-saaras-v4' after it had already shipped. Environments that
-- applied that migration before 7703e40f never received the appended
-- statement, and its checksum drifted for anyone who re-derived it from the
-- file. That migration has been reverted to its originally-applied contents
-- (the 'sarvam-saaras-v3' UPDATE only); this migration carries the
-- 'sarvam-saaras-v4' UPDATE forward as its own, new, never-amend-again step.
--
-- Idempotent: the WHERE clause already makes this a no-op wherever the row
-- has already been updated (format <> 'CLOUD_API').

UPDATE "core"."AiModel"
SET
  "format" = 'SARVAM',
  "_version" = "_version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "slug" = 'sarvam-saaras-v4'
  AND "provider" = 'sarvam'
  AND "taskType" = 'AUTOMATIC_SPEECH_RECOGNITION'
  AND "format" = 'CLOUD_API';
