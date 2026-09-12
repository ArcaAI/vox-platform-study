-- TASK-958 (review fix G1/F1) — DATA migration. No schema change: `prisma migrate diff`
-- against this schema still prints an empty migration after this runs.
--
-- WHY. `AiProviderConnection_tenant_service_default_key` is a plain unique index on
-- (tenantId, service, defaultForProvider). It is NOT partial and knows nothing about
-- soft delete, so a row that was deleted while it was its provider's DEFAULT keeps
-- OCCUPYING that provider's default slot forever. Every later connection for the same
-- provider must elect itself default (no live default remains) and therefore dies on a
-- raw P2002 no layer maps — the provider is wedged until the exact original slug is
-- revived.
--
-- The service now clears the marker as part of the delete (`releaseDefaultAndSoftDelete`);
-- this releases the slots that were already taken before that fix landed.
--
-- SAFE AND IDEMPOTENT: DELETED rows are invisible to every runtime read (the soft-delete
-- client extension filters them), so nothing resolves through the column being cleared;
-- a second run matches no rows. A revive re-elects the default by the same rule a create
-- obeys, so no revived row loses a default it was entitled to.
UPDATE "core"."AiProviderConnection"
SET "defaultForProvider" = NULL
WHERE "resourceStatus" = 'DELETED'
  AND "defaultForProvider" IS NOT NULL;
