-- TASK-532 (OD-2) — blast-radius query for the E3 governance locks.
--
-- Run this BEFORE merge and attach the result to the comms note (§7 Risks).
-- Read-only: SELECTs only, no DDL/DML. Safe against production.
--
-- The two locks behave DIFFERENTLY, so this file has two parts:
--
--   Part 1 (HarnessPolicy) is the DISRUPTIVE one. `safetyEnabled` /
--   `phiEnabled` / `phiFailClosed` joined the SYSTEM overlay, so a tenant row
--   that disagrees with SYSTEM is FORCE-REVERTED at read time the moment this
--   ships. The stored value is ignored, not deleted — removing the key from
--   `GLOBAL_ADMIN_ONLY_POLICY_KEYS` restores the tenant's value verbatim.
--   Every row this returns is a tenant whose effective safety/PHI posture
--   CHANGES on deploy. Rows where the tenant DISABLED a gate (tenant=false,
--   SYSTEM=true) are the ones to call out: their guardrail/PHI protection turns
--   back ON, which is the intended tightening but is still a behaviour change
--   they did not ask for today.
--
--   Part 2 (PipelinePolicy) is NON-disruptive: existing pins keep resolving
--   exactly as they do now (the read path is untouched). Only future WRITES are
--   blocked. These tenants lose the ABILITY to change a toggle, not the value.
--
-- Usage:
--   psql "$DATABASE_URL" -f affected-tenants.sql

\echo '=== Part 1: HarnessPolicy — tenants whose EFFECTIVE posture changes on deploy ==='

WITH sys AS (
    SELECT "safetyEnabled", "phiEnabled", "phiFailClosed"
    FROM core."HarnessPolicy"
    WHERE "tenantId" = '00000000-0000-0000-0000-000000000000'
      AND "resourceStatus" <> 'DELETED'
)
SELECT
    hp."tenantId",
    t."name" AS tenant_name,
    hp."safetyEnabled"  AS tenant_safety,  sys."safetyEnabled"  AS system_safety,
    hp."phiEnabled"     AS tenant_phi,     sys."phiEnabled"     AS system_phi,
    hp."phiFailClosed"  AS tenant_failclosed, sys."phiFailClosed" AS system_failclosed,
    -- The rows that need a heads-up first: the tenant had a gate OFF and it
    -- comes back ON.
    (hp."safetyEnabled" IS DISTINCT FROM sys."safetyEnabled" AND hp."safetyEnabled" = false)
      OR (hp."phiEnabled" IS DISTINCT FROM sys."phiEnabled" AND hp."phiEnabled" = false)
      OR (hp."phiFailClosed" IS DISTINCT FROM sys."phiFailClosed" AND hp."phiFailClosed" = false)
        AS reenables_a_disabled_gate,
    hp."updatedAt", hp."updatedBy"
FROM core."HarnessPolicy" hp
CROSS JOIN sys
LEFT JOIN core."Tenant" t ON t."id" = hp."tenantId"
WHERE hp."tenantId" <> '00000000-0000-0000-0000-000000000000'
  AND hp."resourceStatus" <> 'DELETED'
  AND (
        hp."safetyEnabled" IS DISTINCT FROM sys."safetyEnabled"
     OR hp."phiEnabled"    IS DISTINCT FROM sys."phiEnabled"
     OR hp."phiFailClosed" IS DISTINCT FROM sys."phiFailClosed"
  )
ORDER BY reenables_a_disabled_gate DESC, hp."updatedAt" DESC;

\echo ''
\echo '=== Part 2: PipelinePolicy — tenants holding pins they can no longer edit ==='
\echo '(values keep resolving; only future writes are blocked)'

SELECT
    pp."tenantId",
    t."name"  AS tenant_name,
    pp."scope",
    pp."scopeId",
    pp."harnessEnabled",
    pp."autoNerEnabled",
    pp."updatedAt", pp."updatedBy"
FROM core."PipelinePolicy" pp
LEFT JOIN core."Tenant" t ON t."id" = pp."tenantId"
WHERE pp."resourceStatus" <> 'DELETED'
  AND (pp."harnessEnabled" IS NOT NULL OR pp."autoNerEnabled" IS NOT NULL)
ORDER BY pp."tenantId", pp."scope", pp."updatedAt" DESC;

\echo ''
\echo '=== Part 3: custom (non-seeded) policies that reached MCP/trajectory via HarnessPolicy ==='
\echo '(M-12 subject swap — these roles need an explicit McpServer / AgentTrajectory grant)'

-- NOTE ON SCHEMA: `core."Policy"` has NO tenantId column — a policy is scoped by
-- its `scope` enum (GLOBAL vs TENANT) and by `${context.tenantId}` conditions
-- inside the `rules` JSON. `isProtected` is NOT a seeded/custom discriminator
-- (only 2 seeded rows set it), so seeded rows are identified by name against the
-- DEFAULT_POLICIES list in `seed/01-policy.ts`.
--
-- Every row below grants some HarnessPolicy ability. `seeded = t` rows were
-- migrated automatically by this ticket (they gained explicit McpServer /
-- AgentTrajectory grants). `seeded = f` rows are CUSTOM, operator-authored
-- policies: if one was relied on to reach the MCP registry or the trajectory
-- read plane, it needs the new grants added by hand — this ticket deliberately
-- does not mutate tenant-authored policies.
SELECT
    p."id",
    p."name",
    p."scope",
    (p."name" = ANY (ARRAY[
        'api-key-own-manage','audit-log-read','consultation-department-read','consultation-own-manage',
        'consultation-read-assigned','consultation-shared-patient-read','federated-learning-access',
        'global-settings-manage','harness-platform-manage','harness-tenant-manage','prisma-studio-manage',
        'prompt-template-manage','prompt-template-read','rbac-delegate','rbac-system-manage',
        'rbac-tenant-manage','service-integration','storage-upload','system-full-access',
        'tenant-full-access','user-profile-own'
    ])) AS seeded,
    p."rules"
FROM core."Policy" p
WHERE p."resourceStatus" <> 'DELETED'
  AND p."rules"::text LIKE '%HarnessPolicy%'
ORDER BY seeded, p."name";
