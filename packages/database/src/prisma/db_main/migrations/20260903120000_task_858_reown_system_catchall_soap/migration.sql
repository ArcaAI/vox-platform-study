-- re-own the platform-wide SOAP fallback to the SYSTEM tenant.
--
-- `prompt-resolution.service.ts` `SYSTEM_DEFAULTS.promptId` is the Catch-All SOAP
-- template (71000000-0000-0000-0000-000000000036). It was seeded under the GLOBAL
-- customer tenant (50000000-0000-0000-0000-000000000000), which is a playground
-- tenant, not a configuration tier: PromptTemplate/PromptVersion are tenant-scoped
-- and reads widen only to `tenantId IN [caller, SYSTEM]`, so every other tenant's
-- `assemble` missed the row (DataNotFound → 404) and the durable lane's prompt
-- assembly degraded on every governed consultation. Same defect and same fix as
-- for the pre-summary default (…040). Data only; idempotent; a
-- database seeded after this change has nothing to move.
UPDATE "core"."PromptTemplate"
SET "tenantId" = '00000000-0000-0000-0000-000000000000',
    "approvedVersionNumber" = COALESCE("approvedVersionNumber", 1),
    "updatedAt" = NOW()
WHERE "id" = '71000000-0000-0000-0000-000000000036'
  AND "tenantId" = '50000000-0000-0000-0000-000000000000';

UPDATE "core"."PromptVersion"
SET "tenantId" = '00000000-0000-0000-0000-000000000000'
WHERE "promptTemplateId" = '71000000-0000-0000-0000-000000000036'
  AND "tenantId" = '50000000-0000-0000-0000-000000000000';
