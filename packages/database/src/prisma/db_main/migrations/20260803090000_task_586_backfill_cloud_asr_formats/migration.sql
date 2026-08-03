UPDATE "core"."AiModel"
SET
  "format" = 'SARVAM',
  "_version" = "_version" + 1,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  "slug" = 'sarvam-saaras-v3'
  AND "provider" = 'sarvam'
  AND "taskType" = 'AUTOMATIC_SPEECH_RECOGNITION'
  AND "format" = 'CLOUD_API';
