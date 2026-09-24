-- AlterTable
ALTER TABLE "core"."Consultation" ADD COLUMN     "spokenLanguageMode" TEXT;

-- Backfill (idempotent): promote the legacy spoken-language key
-- `metadata.summaryLanguage` (the model's own `metadata` column, not `_metadata`)
-- to the typed column, only where it normalizes to a catalog id per
-- tests/contracts/language-resolution.fixture.json: a catalog id (case-insensitive),
-- or `<lang>-<REGION>` (region = 2 letters or 3 digits) whose lang is a
-- single-language id. Anything else stays NULL — never guessed.
UPDATE "core"."Consultation" c
SET "spokenLanguageMode" = n.mode
FROM (
  SELECT id,
    CASE
      WHEN lower(raw) IN ('en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto') THEN lower(raw)
      WHEN raw ~ '^[A-Za-z]{2,3}-([A-Za-z]{2}|[0-9]{3})$'
        AND lower(split_part(raw, '-', 1)) IN ('en', 'ml', 'vi')
        THEN lower(split_part(raw, '-', 1))
      ELSE NULL
    END AS mode
  FROM (
    SELECT id, trim(metadata ->> 'summaryLanguage') AS raw
    FROM "core"."Consultation"
    WHERE "spokenLanguageMode" IS NULL
      AND metadata ? 'summaryLanguage'
  ) legacy
) n
WHERE c.id = n.id
  AND n.mode IS NOT NULL;
