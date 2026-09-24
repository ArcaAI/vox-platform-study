-- TASK-1004 D-3 — backfill Consultation.spokenLanguageMode from the legacy
-- free-form metadata.summaryLanguage key (packages/applications/src/services/
-- consultation/consultation/summary-language.ts, SUMMARY_LANGUAGE_METADATA_KEY).
--
-- This is a DATA BACKFILL, not a schema migration — it is not applied by
-- `prisma migrate deploy` / the k3s `db-migrate` PreSync Job, and it is not
-- staged under packages/database/.../migrations/ (rule 02: never stage a
-- not-yet-applied migration there). Run it by hand, once, against the target
-- database after the `spokenLanguageMode` column exists (the migration that
-- adds it is authored separately by the orchestrator on a shadow DB per the
-- rule 02 recipe). Idempotent and safe to re-run: it only ever touches rows
-- where `"spokenLanguageMode"` IS STILL NULL, so a second run is a no-op.
--
-- ## The `_metadata` vs `metadata` trap (see rule 00 / memory)
--
-- `Consultation` carries TWO JSONB columns: `metaData` (BaseEntity's generic
-- envelope, mapped to the DB column `_metadata`) and the model's OWN
-- `metadata` column (no @map — the DB column is literally `metadata`). The
-- legacy spoken-language key lives in the SECOND one, confirmed against
-- `summary-language.ts`'s `SUMMARY_LANGUAGE_METADATA_KEY = 'summaryLanguage'`
-- and `readSummaryLanguage(consultation.metadata)`. This script reads
-- `metadata`, never `_metadata`.
--
-- ## Normalization — mirrors EffectiveLanguageModeResolver's normalizer
--
-- Pinned by tests/contracts/language-resolution.fixture.json ("normalize"):
--   - a catalog id, case-insensitive, wins as-is (lower-cased);
--   - otherwise a BCP-47 `<lang>-<REGION>` tag (EXACTLY two subtags) whose
--     LANG subtag is itself a single-language catalog id (en, ml, vi, auto —
--     i.e. NOT a code-switch mode) maps to that lang id (`en-US` -> `en`,
--     `ml-IN` -> `ml`, `vi-VN` -> `vi`);
--   - anything else (an unknown language, a 3+-subtag tag such as
--     `en-Latn-US`, a display name, a sentence) is left NULL — never guessed.
--
-- Catalog ids as of TASK-1004: en, ml, ml-en, vi, vi-en, auto. Extending the
-- catalog later means extending BOTH literal lists below to match the
-- fixture, or this script silently stops backfilling the new ids.
--
-- ## Scope
--
-- Every Consultation row regardless of `resourceStatus` (including
-- soft-deleted ones) — this corrects historical data, not live behaviour, and
-- a soft-deleted consultation's spoken language is still a fact worth having
-- typed for reporting/audit reads that bypass the soft-delete filter.

BEGIN;

WITH legacy AS (
  SELECT
    id,
    trim(metadata ->> 'summaryLanguage') AS raw
  FROM core."Consultation"
  WHERE "spokenLanguageMode" IS NULL
    AND metadata ? 'summaryLanguage'
    AND trim(metadata ->> 'summaryLanguage') <> ''
),
normalized AS (
  SELECT
    id,
    CASE
      -- Exact catalog id, case-insensitive (includes the code-switch modes
      -- ml-en / vi-en, which must win here before the region-stripping rule
      -- below ever looks at them).
      WHEN lower(raw) IN ('en', 'ml', 'ml-en', 'vi', 'vi-en', 'auto') THEN lower(raw)
      -- <lang>-<REGION>: exactly two BCP-47 subtags, and the first is itself a
      -- single-language catalog id (never a code-switch mode).
      WHEN raw ~ '^[A-Za-z]{2,3}-[A-Za-z0-9]{2,8}$'
        AND lower(split_part(raw, '-', 1)) IN ('en', 'ml', 'vi', 'auto')
        THEN lower(split_part(raw, '-', 1))
      ELSE NULL
    END AS mode
  FROM legacy
)
UPDATE core."Consultation" c
SET "spokenLanguageMode" = n.mode
FROM normalized n
WHERE c.id = n.id
  AND n.mode IS NOT NULL;

COMMIT;

-- Verification (run separately, not part of the backfill):
--
--   -- rows backfilled by this script:
--   SELECT count(*) FROM core."Consultation"
--   WHERE "spokenLanguageMode" IS NOT NULL AND metadata ? 'summaryLanguage';
--
--   -- legacy values that did NOT normalize (left NULL on purpose — inspect
--   -- before assuming they need a manual fix):
--   SELECT metadata ->> 'summaryLanguage' AS raw, count(*)
--   FROM core."Consultation"
--   WHERE "spokenLanguageMode" IS NULL
--     AND metadata ? 'summaryLanguage'
--     AND trim(metadata ->> 'summaryLanguage') <> ''
--   GROUP BY 1
--   ORDER BY 2 DESC;
