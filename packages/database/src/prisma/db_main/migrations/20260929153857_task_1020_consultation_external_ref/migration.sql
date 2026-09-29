-- TASK-1020 D-2 — Consultation.externalRef: the caller encounter id becomes the idempotency key of `open`.
-- Steps 1+3 mirror the schema; steps 2 (backfill) and 4 (partial unique index) are hand-written and invisible to the schema.

-- 1. AlterTable — the caller's own encounter id, nullable (NULL = none sent; the legacy key applies).
ALTER TABLE "core"."Consultation" ADD COLUMN     "externalRef" TEXT;

-- 2. Backfill (idempotent) from the TASK-951 marker. `open-markers.ts` stores it as the top-level
--    string key `externalRef` of the model's own `metadata` column (NOT `_metadata`), written by
--    `withExternalRefMarker`; `readExternalRef` accepts only a NON-EMPTY STRING, so the same rule
--    applies here.
--
--    Duplicates: before this ticket the ref was a label, not a key, so two ENABLED rows may carry
--    the same (tenantId, patientId, doctorId, externalRef). Only the NEWEST of each such group is
--    promoted (ties broken by id, UUIDv7 = creation order) — `open` returns the newest match
--    anyway — and the older rows keep their metadata marker with a NULL column, so step 4 cannot
--    fail on legacy data. Soft-deleted rows are promoted too (the index is not status-filtered).
UPDATE "core"."Consultation" c
SET "externalRef" = ranked.ref
FROM (
  SELECT id,
         ref,
         row_number() OVER (
           PARTITION BY "tenantId", "patientId", "doctorId", ref
           ORDER BY "createdAt" DESC, id DESC
         ) AS rn
  FROM (
    SELECT id, "tenantId", "patientId", "doctorId", "createdAt", metadata ->> 'externalRef' AS ref
    FROM "core"."Consultation"
    WHERE "externalRef" IS NULL
      AND jsonb_typeof(metadata -> 'externalRef') = 'string'
      AND length(metadata ->> 'externalRef') > 0
  ) legacy
) ranked
WHERE c.id = ranked.id
  AND ranked.rn = 1;

-- 3. CreateIndex — the lookup `open` runs (schema: `Consultation_encounterKey_idx`).
CREATE INDEX "Consultation_encounterKey_idx" ON "core"."Consultation"("tenantId", "patientId", "doctorId", "externalRef");

-- 4. The IDEMPOTENCY guarantee (BP-3): one consultation per encounter, enforced by the database, so
--    two racing opens with the same ref cannot both insert. Partial — rows with no ref are
--    governed by the legacy key and are allowed to repeat.
CREATE UNIQUE INDEX "Consultation_encounterKey_uq" ON "core"."Consultation"("tenantId", "patientId", "doctorId", "externalRef") WHERE "externalRef" IS NOT NULL;
