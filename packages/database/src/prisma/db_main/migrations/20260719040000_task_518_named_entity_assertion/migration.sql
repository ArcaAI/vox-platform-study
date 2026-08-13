-- Negation/assertion polarity on NamedEntity.
--
-- Purely ADDITIVE: one new NULLABLE column, no changes to existing columns or
-- data. `assertion` records the ConText/NegEx-style claim a mention makes about
-- the patient — one of PRESENT | ABSENT | HISTORICAL | FAMILY | HYPOTHETICAL.
-- Modeled as a plain nullable TEXT (not a PG enum) to stay forward-compatible
-- with a future learned model's label set and to keep the migration additive
-- and reversible-free. A NULL value is interpreted as PRESENT (the safe
-- default) by the domain layer, so existing rows and any writer that does not
-- set it remain positive assertions.
--
-- Additive + idempotent so it is safe to apply via `pnpm db:push` / psql on the
-- db-push-managed dev database.

-- AlterTable
ALTER TABLE "core"."NamedEntity" ADD COLUMN IF NOT EXISTS "assertion" TEXT;
