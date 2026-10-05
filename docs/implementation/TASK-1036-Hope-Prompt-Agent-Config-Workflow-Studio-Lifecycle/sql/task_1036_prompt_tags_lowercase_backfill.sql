-- TASK-1036 (reviewer Q16, lane F2): DATA back-fill. NOT APPLIED, and NOT under `migrations/`.
--
-- Why it exists
-- -------------
-- Prompt tags are now NORMALISED on write: `IsPromptTags()` in
-- packages/applications/src/services/prompt-management/dto/prompt-tag.ts trims and lower-cases
-- every tag before the grammar runs, so `Pre-Summary` is stored as `pre-summary` instead of being
-- refused. A tag is compared by equality everywhere (the list facet, the resolver's selector, the
-- console filter). A row written BEFORE that rule may still hold `Pre-Summary` next to new rows
-- holding `pre-summary`, and the two would never match. This file brings existing rows onto the
-- same rule.
--
-- What it does, per "core"."PromptTemplate" row
-- ----------------------------------------------
--   * every tag -> lower(btrim(tag));
--   * a tag that is empty after btrim is dropped;
--   * duplicates that only appear after normalising collapse to ONE, kept at the position of the
--     FIRST occurrence (WITH ORDINALITY), so the order the author chose is preserved;
--   * only rows whose tags actually change are touched. Those rows get `_version + 1` (any content
--     write bumps the optimistic-concurrency counter, so a stale If-Match gets 412 instead of
--     silently overwriting), `updatedAt = now()` and `updatedBy = <system user>` (the house
--     system-user id, `seed/00-constants.ts`).
--
-- Idempotent: a second run finds nothing to change and updates 0 rows. Soft-deleted rows are
-- included on purpose; a restore must not bring a mixed-case tag back.
--
-- What it deliberately does NOT do
-- ---------------------------------
--   * It does not repair tags that are still outside the grammar after normalising (for example
--     `has space`). Those are reported by the read-only query at the end, so a human can decide.
--     The write path refuses them; it never invents a spelling.
--   * It changes no schema. `prisma migrate diff` stays empty.
--
-- How to run it (orchestrator / operator; never from a lane)
-- ---------------------------------------------------------
--   1. Run the report query (step 0) and keep its output as evidence.
--   2. Run the transaction (step 1). Its UPDATE row count is the number of rows normalised.
--   3. Run it once more; it must report UPDATE 0.
--   4. Run the report query again. Only grammar-invalid rows may remain.

-- Step 0 (read-only): rows whose tags would change, with old and new values.
WITH normalised AS (
  SELECT pt."id",
         pt."tenantId",
         pt."name",
         pt."tags" AS old_tags,
         COALESCE(
           (SELECT array_agg(n.tag ORDER BY n.first_pos)
              FROM (SELECT lower(btrim(t.tag)) AS tag, min(t.pos) AS first_pos
                      FROM unnest(pt."tags") WITH ORDINALITY AS t(tag, pos)
                     WHERE btrim(t.tag) <> ''
                     GROUP BY lower(btrim(t.tag))) AS n),
           ARRAY[]::text[]
         ) AS new_tags
    FROM "core"."PromptTemplate" AS pt
)
SELECT "id", "tenantId", "name", old_tags, new_tags
  FROM normalised
 WHERE old_tags IS DISTINCT FROM new_tags
 ORDER BY "tenantId", "name";

-- Step 1: the back-fill.
BEGIN;

WITH normalised AS (
  SELECT pt."id",
         COALESCE(
           (SELECT array_agg(n.tag ORDER BY n.first_pos)
              FROM (SELECT lower(btrim(t.tag)) AS tag, min(t.pos) AS first_pos
                      FROM unnest(pt."tags") WITH ORDINALITY AS t(tag, pos)
                     WHERE btrim(t.tag) <> ''
                     GROUP BY lower(btrim(t.tag))) AS n),
           ARRAY[]::text[]
         ) AS tags
    FROM "core"."PromptTemplate" AS pt
)
UPDATE "core"."PromptTemplate" AS pt
   SET "tags"      = normalised.tags,
       "_version"  = pt."_version" + 1,
       "updatedAt" = now(),
       "updatedBy" = '60000000-0000-0000-0000-000000000000'
  FROM normalised
 WHERE pt."id" = normalised."id"
   AND pt."tags" IS DISTINCT FROM normalised.tags;

COMMIT;

-- Step 2 (read-only): tags that are STILL outside the grammar after normalising
-- (PROMPT_TAG_PATTERN: key 1-32 `[a-z0-9][a-z0-9_-]*`, optional `:value` 1-64 `[a-z0-9][a-z0-9._-]*`).
SELECT pt."id", pt."tenantId", pt."name", bad.tag
  FROM "core"."PromptTemplate" AS pt
 CROSS JOIN LATERAL unnest(pt."tags") AS bad(tag)
 WHERE bad.tag !~ '^[a-z0-9][a-z0-9_-]{0,31}(:[a-z0-9][a-z0-9._-]{0,63})?$'
 ORDER BY pt."tenantId", pt."name";
