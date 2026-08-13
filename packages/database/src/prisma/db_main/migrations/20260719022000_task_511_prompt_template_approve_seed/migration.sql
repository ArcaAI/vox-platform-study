-- Flip built-in clinician-facing templates to APPROVED.
--
-- Clinical-flow prompt resolution is now approval-gated: `prompt-resolution`
-- only resolves templates whose status = APPROVED. This UPDATE promotes the
-- existing PUBLISHED seed templates so the built-in catalog keeps resolving
-- after the gate lands. Runs in a SEPARATE migration from the enum ADD VALUE
-- (Postgres cannot use a new enum value in the transaction that adds it).
--
-- ADDITIVE / non-destructive: an in-place status UPDATE only. It flips PUBLISHED
-- -> APPROVED and intentionally leaves DRAFT rows (e.g. DNA_ANALYSIS) untouched.
-- NO DROP / DELETE / TRUNCATE.

UPDATE "core"."PromptTemplate"
SET "status" = 'APPROVED'
WHERE "status" = 'PUBLISHED';
