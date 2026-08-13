-- #1 / F6 — Tenant lifecycle: add the SUSPENDED resource status.
-- Additive enum-value addition ONLY. Isolated in its own migration because
-- Postgres cannot use a newly-added enum value in the same transaction that
-- adds it; keeping it separate from any column DDL that references the type
-- keeps `migrate deploy` safe. No DROP/DELETE/TRUNCATE.

-- AlterEnum
ALTER TYPE "core"."ResourceStatusType" ADD VALUE IF NOT EXISTS 'SUSPENDED';
